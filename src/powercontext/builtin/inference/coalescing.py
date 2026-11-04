# Copyright (c) 2026 OceanBase.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Cross-call request coalescing and result caching for embedding providers."""

from __future__ import annotations

import asyncio
from collections import OrderedDict

from powercontext.builtin.inference.models import EmbeddingResult, EmbeddingVector, InferenceUsage
from powercontext.builtin.inference.protocols import EmbeddingModel

DEFAULT_MAX_BATCH_SIZE = 64
DEFAULT_COALESCE_MS = 5.0
DEFAULT_CACHE_SIZE = 1024


class _Slot:
    """One text that is cached, in flight, or waiting to be batched."""

    __slots__ = ("batch", "future", "text")

    def __init__(self, text: str) -> None:
        self.text = text
        self.future: asyncio.Future[EmbeddingVector] = asyncio.get_running_loop().create_future()
        self.future.add_done_callback(_consume_failure)
        self.batch: _Batch | None = None


class _Batch:
    """One provider request together with the texts it covers."""

    __slots__ = ("slots", "task", "usage")

    def __init__(self, slots: tuple[_Slot, ...]) -> None:
        self.slots = slots
        self.task: asyncio.Task[None] | None = None
        self.usage: InferenceUsage | None = None


class CoalescingEmbeddingModel:
    """Share one provider request across concurrent callers and cache the result.

    Every caller that needs the same text inside one coalescing window waits on
    the same slot, so the provider sees each text once. The provider work runs in
    its own task: cancelling one waiter never cancels the work other waiters
    depend on, and a failed request is neither cached nor retried behind the
    caller's back.
    """

    def __init__(
        self,
        model: EmbeddingModel,
        *,
        max_batch_size: int = DEFAULT_MAX_BATCH_SIZE,
        coalesce_ms: float = DEFAULT_COALESCE_MS,
        cache_size: int = DEFAULT_CACHE_SIZE,
    ) -> None:
        if max_batch_size < 1:
            raise ValueError("max_batch_size must be positive")  # noqa: TRY003
        if coalesce_ms < 0:
            raise ValueError("coalesce_ms must not be negative")  # noqa: TRY003
        if cache_size < 0:
            raise ValueError("cache_size must not be negative")  # noqa: TRY003
        self._model = model
        self.profile = model.profile
        self._max_batch_size = max_batch_size
        self._coalesce_seconds = coalesce_ms / 1000
        self._cache_size = cache_size
        self._cache: OrderedDict[str, EmbeddingVector] = OrderedDict()
        self._inflight: dict[str, _Slot] = {}
        self._pending: list[_Slot] = []

    async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult:
        """Return one vector per input text, in the input order."""

        if not texts:
            return EmbeddingResult(vectors=(), usage=InferenceUsage(requests=0))

        resolved: dict[str, _Slot | EmbeddingVector] = {}
        created = False
        for text in dict.fromkeys(texts):
            cached = self._cached(text)
            if cached is not None:
                resolved[text] = cached
                continue
            slot = self._inflight.get(text)
            if slot is None:
                slot = _Slot(text)
                self._inflight[text] = slot
                self._pending.append(slot)
                created = True
            resolved[text] = slot

        if created:
            await asyncio.sleep(self._coalesce_seconds)
            self._flush()

        vectors: list[EmbeddingVector] = []
        batches: list[_Batch] = []
        seen: set[int] = set()
        for text in texts:
            value = resolved[text]
            if isinstance(value, _Slot):
                vector = await asyncio.shield(value.future)
                batch = value.batch
                if batch is not None and id(batch) not in seen:
                    seen.add(id(batch))
                    batches.append(batch)
            else:
                vector = value
            vectors.append(vector)
        return EmbeddingResult(vectors=tuple(vectors), usage=_merged_usage(batches))

    def _flush(self) -> None:
        """Send every pending text, respecting the provider batch limit."""

        while self._pending:
            group = tuple(self._pending[: self._max_batch_size])
            del self._pending[: self._max_batch_size]
            batch = _Batch(group)
            for slot in group:
                slot.batch = batch
            batch.task = asyncio.create_task(self._run_batch(batch))

    async def _run_batch(self, batch: _Batch) -> None:
        """Run one provider request and publish its vectors to every waiter."""

        texts = tuple(slot.text for slot in batch.slots)
        try:
            result = await self._model.embed(texts)
        except Exception as error:
            self._fail(batch, error)
            return
        if len(result.vectors) != len(texts):
            self._fail(
                batch,
                ValueError("embedding provider returned a different vector count than requested texts"),
            )
            return
        batch.usage = result.usage
        for slot, vector in zip(batch.slots, result.vectors, strict=True):
            self._release(slot)
            self._store(slot.text, vector)
            if not slot.future.done():
                slot.future.set_result(vector)

    def _fail(self, batch: _Batch, error: BaseException) -> None:
        """Publish one failure to the waiters of this batch without caching it."""

        for slot in batch.slots:
            self._release(slot)
            if not slot.future.done():
                slot.future.set_exception(error)

    def _release(self, slot: _Slot) -> None:
        if self._inflight.get(slot.text) is slot:
            del self._inflight[slot.text]

    def _cached(self, text: str) -> EmbeddingVector | None:
        if self._cache_size < 1:
            return None
        vector = self._cache.get(text)
        if vector is None:
            return None
        self._cache.move_to_end(text)
        return vector

    def _store(self, text: str, vector: EmbeddingVector) -> None:
        if self._cache_size < 1:
            return
        self._cache[text] = vector
        self._cache.move_to_end(text)
        while len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)


def _merged_usage(batches: list[_Batch]) -> InferenceUsage:
    """Sum the provider usage of every distinct batch this caller waited on."""

    usages = [batch.usage for batch in batches if batch.usage is not None]
    if not usages:
        return InferenceUsage(requests=0)
    return InferenceUsage(
        requests=sum(usage.requests for usage in usages),
        input_tokens=_sum_optional(usage.input_tokens for usage in usages),
        output_tokens=_sum_optional(usage.output_tokens for usage in usages),
    )


def _sum_optional(values) -> int | None:
    present = [value for value in values if value is not None]
    return sum(present) if present else None


def _consume_failure(future: asyncio.Future[EmbeddingVector]) -> None:
    """Retrieve a stored failure so an abandoned waiter cannot warn about it."""

    if not future.cancelled():
        future.exception()


__all__ = ["CoalescingEmbeddingModel"]
