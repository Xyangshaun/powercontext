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

"""HTTP scoring service adapter for Memory reranking."""

from __future__ import annotations

import json

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError

from powercontext.builtin.artifacts.memory.models import MemoryHit
from powercontext.builtin.artifacts.memory.reranking import MemoryRerankDecision, _validate_bounds
from powercontext.builtin.inference import InferenceUsage

DEFAULT_HTTP_RERANKER_POLICY_ID = "http-cross-encoder-v1"
DEFAULT_HTTP_RERANKER_BATCH_SIZE = 32


class _ScoreRecord(BaseModel):
    """One scored candidate as returned by the scoring service."""

    model_config = ConfigDict(extra="forbid")

    rank: StrictInt = Field(ge=1)
    score: float = Field(allow_inf_nan=False)


class _ScoreResponse(BaseModel):
    """The exact response envelope accepted from the scoring service."""

    model_config = ConfigDict(extra="forbid")

    scores: tuple[_ScoreRecord, ...]


class HTTPMemoryReranker:
    """Select Memory hits with a remote HTTP scoring service.

    The service scores candidates it is given, so the coarse pool is split into
    batches that respect the service's batch limit. Scores are collected across
    every batch before a single global selection is made, so the final order is
    decided by the complete candidate pool rather than by batch order.
    """

    def __init__(
        self,
        endpoint: str,
        *,
        client: httpx.AsyncClient,
        batch_size: int = DEFAULT_HTTP_RERANKER_BATCH_SIZE,
        policy_id: str = DEFAULT_HTTP_RERANKER_POLICY_ID,
    ) -> None:
        if not endpoint or endpoint != endpoint.strip():
            raise ValueError("endpoint must be a non-empty trimmed string")  # noqa: TRY003
        if batch_size < 1:
            raise ValueError("batch_size must be positive")  # noqa: TRY003
        self._endpoint = endpoint
        self._client = client
        self._batch_size = batch_size
        self.policy_id = policy_id

    async def rerank(
        self,
        query: str,
        candidates: tuple[MemoryHit, ...],
        limit: int,
        /,
    ) -> MemoryRerankDecision:
        """Score every candidate and keep the highest scoring original ranks."""

        _validate_bounds(len(candidates), limit)
        scores: dict[int, float] = {}
        requests = 0
        for start in range(0, len(candidates), self._batch_size):
            batch = candidates[start : start + self._batch_size]
            ranks = tuple(range(start + 1, start + len(batch) + 1))
            response = await self._client.post(
                self._endpoint,
                json={
                    "query": query,
                    "candidates": [
                        {"rank": rank, "text": candidate.text}
                        for rank, candidate in zip(ranks, batch, strict=True)
                    ],
                },
            )
            response.raise_for_status()
            requests += 1
            scores.update(_parse_scores(response, set(ranks)))

        ordered = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
        selected = tuple(rank for rank, _ in ordered[:limit])
        return MemoryRerankDecision(
            selected_ranks=selected,
            usage=InferenceUsage(requests=requests),
            discarded_rank_count=len(candidates) - len(selected),
        )


def _parse_scores(response: httpx.Response, expected_ranks: set[int]) -> dict[int, float]:
    """Validate one scoring response and map its scores back to batch ranks."""

    try:
        payload = response.json()
    except (json.JSONDecodeError, ValueError) as error:
        raise ValueError("reranker response must be a JSON object") from error
    try:
        parsed = _ScoreResponse.model_validate(payload)
    except ValidationError as error:
        raise ValueError("reranker response must match the score schema") from error

    scores: dict[int, float] = {}
    for record in parsed.scores:
        if record.rank not in expected_ranks:
            raise ValueError("reranker response scored a rank outside the request batch")  # noqa: TRY003
        if record.rank in scores:
            raise ValueError("reranker response scored a rank more than once")  # noqa: TRY003
        scores[record.rank] = record.score
    if set(scores) != expected_ranks:
        raise ValueError("reranker response must score every requested rank exactly once")  # noqa: TRY003
    return scores


__all__ = [
    "DEFAULT_HTTP_RERANKER_BATCH_SIZE",
    "DEFAULT_HTTP_RERANKER_POLICY_ID",
    "HTTPMemoryReranker",
]
