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

"""Dependency-aware Source lifecycle over built-in Memory and Topic Memory."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator
from sqlalchemy import delete, select

from powercontext.artifacts import ArtifactRef, MemoryCitation
from powercontext.builtin.persistence.database import AsyncDatabase
from powercontext.builtin.persistence.tables import (
    SOURCE_LIFECYCLE_EVENTS_TABLE,
    SOURCE_LIFECYCLE_NODES_TABLE,
    TOPIC_MEMORY_LIFECYCLE_EXCLUSIONS_TABLE,
)
from powercontext.sources.models import SourceRef

if TYPE_CHECKING:
    from collections.abc import Mapping

    from sqlalchemy.ext.asyncio import AsyncConnection

    from powercontext.builtin.runtime.application import BuiltinRuntime

MAX_LIFECYCLE_NODE_ID_LENGTH = 128
MAX_LIFECYCLE_REASON_LENGTH = 512
_LIFECYCLE_REASON = "source-lifecycle"
_FAMILIES = ("source", "memory", "topic")
_POLICIES = ("all", "any")
_RESOLVE_PURPOSES = ("generation", "audit")


class SourceLifecycleError(ValueError):
    """Reject an invalid lifecycle registration, event, or resolution."""


class SourceLifecycleEvent(BaseModel):
    """One immutable, monotonically sequenced availability event for a Source."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    node_id: str = Field(min_length=1, max_length=MAX_LIFECYCLE_NODE_ID_LENGTH)
    revision: StrictInt = Field(ge=1)
    sequence: StrictInt = Field(ge=1)
    available: StrictBool
    reason: str = Field(min_length=1, max_length=MAX_LIFECYCLE_REASON_LENGTH)

    @field_validator("node_id", "reason")
    @classmethod
    def validate_trimmed(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("must be a trimmed string")
        return value


@dataclass(frozen=True)
class _Node:
    node_id: str
    family: str
    reference: dict[str, Any]
    parents: tuple[str, ...]
    policy: str
    revision: int
    ordinal: int
    available: bool


@dataclass(frozen=True)
class _Event:
    node_id: str
    sequence: int
    revision: int
    available: bool
    reason: str


def _encode(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _decode(payload: bytes) -> Any:
    return json.loads(bytes(payload).decode())


class SourceLifecycleRepository:
    """Persist lifecycle registrations, events, and Topic visibility rows."""

    def __init__(self, database: AsyncDatabase) -> None:
        self._database = database

    async def load(self, scope_id: str, /) -> tuple[tuple[_Node, ...], dict[str, tuple[_Event, ...]]]:
        nodes = SOURCE_LIFECYCLE_NODES_TABLE
        events = SOURCE_LIFECYCLE_EVENTS_TABLE
        async with self._database.connection() as connection:
            node_rows = (
                await connection.execute(
                    select(nodes.c.node_id, nodes.c.family, nodes.c.reference, nodes.c.parents, nodes.c.policy)
                    .add_columns(nodes.c.revision, nodes.c.ordinal, nodes.c.available)
                    .where(nodes.c.scope_id == scope_id)
                    .order_by(nodes.c.ordinal)
                )
            ).mappings()
            event_rows = (
                await connection.execute(
                    select(
                        events.c.node_id,
                        events.c.sequence,
                        events.c.revision,
                        events.c.available,
                        events.c.reason,
                    )
                    .where(events.c.scope_id == scope_id)
                    .order_by(events.c.node_id, events.c.sequence)
                )
            ).mappings()
        registered = tuple(
            _Node(
                node_id=str(row["node_id"]),
                family=str(row["family"]),
                reference=_decode(row["reference"]),
                parents=tuple(str(parent) for parent in _decode(row["parents"])),
                policy=str(row["policy"]),
                revision=int(row["revision"]),
                ordinal=int(row["ordinal"]),
                available=bool(row["available"]),
            )
            for row in node_rows
        )
        history: dict[str, list[_Event]] = {}
        for row in event_rows:
            history.setdefault(str(row["node_id"]), []).append(
                _Event(
                    node_id=str(row["node_id"]),
                    sequence=int(row["sequence"]),
                    revision=int(row["revision"]),
                    available=bool(row["available"]),
                    reason=str(row["reason"]),
                )
            )
        return registered, {node_id: tuple(items) for node_id, items in history.items()}

    async def insert_node(self, scope_id: str, node: _Node, /, *, excluded: bool) -> None:
        nodes = SOURCE_LIFECYCLE_NODES_TABLE
        exclusions = TOPIC_MEMORY_LIFECYCLE_EXCLUSIONS_TABLE
        async with self._database.transaction() as connection:
            await connection.execute(
                nodes.insert().values(
                    scope_id=scope_id,
                    node_id=node.node_id,
                    family=node.family,
                    reference=_encode(node.reference),
                    parents=_encode(list(node.parents)),
                    policy=node.policy,
                    revision=node.revision,
                    ordinal=node.ordinal,
                    available=node.available,
                )
            )
            if excluded:
                await self._exclude(connection, scope_id, node.reference["artifact_id"])

    async def commit_apply(
        self,
        scope_id: str,
        changed: Mapping[str, bool],
        event: _Event,
        topic_exclusions: Mapping[str, bool],
        /,
    ) -> None:
        nodes = SOURCE_LIFECYCLE_NODES_TABLE
        events = SOURCE_LIFECYCLE_EVENTS_TABLE
        async with self._database.transaction() as connection:
            for node_id, available in changed.items():
                await connection.execute(
                    nodes.update()
                    .where(nodes.c.scope_id == scope_id, nodes.c.node_id == node_id)
                    .values(available=available)
                )
            await connection.execute(
                events.insert().values(
                    scope_id=scope_id,
                    node_id=event.node_id,
                    sequence=event.sequence,
                    revision=event.revision,
                    available=event.available,
                    reason=event.reason,
                )
            )
            for artifact_id, excluded in topic_exclusions.items():
                if excluded:
                    await self._exclude(connection, scope_id, artifact_id)
                else:
                    await connection.execute(
                        delete(TOPIC_MEMORY_LIFECYCLE_EXCLUSIONS_TABLE).where(
                            TOPIC_MEMORY_LIFECYCLE_EXCLUSIONS_TABLE.c.scope_id == scope_id,
                            TOPIC_MEMORY_LIFECYCLE_EXCLUSIONS_TABLE.c.artifact_id == artifact_id,
                        )
                    )

    @staticmethod
    async def _exclude(connection: AsyncConnection, scope_id: str, artifact_id: str, /) -> None:
        exclusions = TOPIC_MEMORY_LIFECYCLE_EXCLUSIONS_TABLE
        exists = await connection.scalar(
            select(exclusions.c.artifact_id).where(
                exclusions.c.scope_id == scope_id,
                exclusions.c.artifact_id == artifact_id,
            )
        )
        if exists is not None:
            return
        await connection.execute(
            exclusions.insert().values(scope_id=scope_id, artifact_id=artifact_id, reason=_LIFECYCLE_REASON)
        )


class SourceLifecycleScope:
    """Register dependency nodes and propagate Source availability for one Scope."""

    def __init__(self, runtime: BuiltinRuntime, repository: SourceLifecycleRepository, scope_id: str) -> None:
        self._runtime = runtime
        self._repository = repository
        self.scope_id = scope_id

    async def register_source(self, node_id: str, reference: SourceRef, /, *, revision: int) -> None:
        if type(reference) is not SourceRef:
            raise SourceLifecycleError("source-reference")
        _require_revision(revision)
        await self._register(
            node_id,
            family="source",
            reference=reference.model_dump(mode="json"),
            parents=(),
            policy="all",
            revision=revision,
        )

    async def register_memory(
        self,
        node_id: str,
        citation: MemoryCitation,
        /,
        *,
        parents: tuple[str, ...],
        policy: str,
    ) -> None:
        if type(citation) is not MemoryCitation:
            raise SourceLifecycleError("memory-reference")
        _require_parents(parents, policy)
        await self._validate_memory(citation)
        await self._register(
            node_id,
            family="memory",
            reference=citation.model_dump(mode="json"),
            parents=parents,
            policy=policy,
            revision=0,
        )

    async def register_topic(
        self,
        node_id: str,
        reference: ArtifactRef,
        /,
        *,
        parents: tuple[str, ...],
        policy: str,
    ) -> None:
        if type(reference) is not ArtifactRef:
            raise SourceLifecycleError("topic-reference")
        _require_parents(parents, policy)
        await self._validate_topic(reference)
        await self._register(
            node_id,
            family="topic",
            reference=reference.model_dump(mode="json"),
            parents=parents,
            policy=policy,
            revision=0,
        )

    async def apply(self, event: SourceLifecycleEvent, /) -> list[str]:
        if type(event) is not SourceLifecycleEvent:
            raise SourceLifecycleError("event")
        async with self._runtime._context(self.scope_id) as context, self._runtime._locked(self.scope_id):
            nodes, history = await self._repository.load(self.scope_id)
            by_id = {node.node_id: node for node in nodes}
            node = by_id.get(event.node_id)
            if node is None or node.family != "source":
                raise SourceLifecycleError("unknown-source")
            if event.revision != node.revision:
                raise SourceLifecycleError("revision")
            recorded = history.get(event.node_id, ())
            replay = next((item for item in recorded if item.sequence == event.sequence), None)
            if replay is not None:
                if (
                    replay.revision,
                    replay.available,
                    replay.reason,
                ) != (event.revision, event.available, event.reason):
                    raise SourceLifecycleError("sequence-conflict")
                return sorted(item.node_id for item in nodes if item.available)
            if recorded and event.sequence < recorded[-1].sequence:
                raise SourceLifecycleError("sequence")
            availability = {item.node_id: item.available for item in nodes}
            availability[event.node_id] = event.available
            changed: dict[str, bool] = {}
            if node.available != event.available:
                changed[event.node_id] = event.available
            for item in nodes:
                if item.family == "source":
                    continue
                supported = [availability[parent] for parent in item.parents]
                target = all(supported) if item.policy == "all" else any(supported)
                availability[item.node_id] = target
                if target != item.available:
                    changed[item.node_id] = target
            await self._apply_memory(nodes, changed, context)
            exclusions = {
                str(item.reference["artifact_id"]): availability[item.node_id]
                for item in nodes
                if item.family == "topic" and item.node_id in changed
            }
            await self._repository.commit_apply(
                self.scope_id,
                changed,
                _Event(
                    node_id=event.node_id,
                    sequence=event.sequence,
                    revision=event.revision,
                    available=event.available,
                    reason=event.reason,
                ),
                {artifact_id: not available for artifact_id, available in exclusions.items()},
            )
        return sorted(item.node_id for item in nodes if availability[item.node_id])

    async def resolve(
        self,
        node_id: str,
        /,
        *,
        purpose: Literal["generation", "audit"] = "generation",
    ) -> SourceRef | MemoryCitation | ArtifactRef:
        if purpose not in _RESOLVE_PURPOSES:
            raise SourceLifecycleError("purpose")
        nodes, _ = await self._repository.load(self.scope_id)
        node = next((item for item in nodes if item.node_id == node_id), None)
        if node is None:
            raise SourceLifecycleError("unknown-node")
        if purpose == "generation" and not node.available:
            raise SourceLifecycleError("unavailable")
        if node.family == "source":
            return SourceRef.model_validate(node.reference)
        if node.family == "memory":
            return MemoryCitation.model_validate(node.reference)
        return ArtifactRef.model_validate(node.reference)

    async def _register(
        self,
        node_id: str,
        *,
        family: str,
        reference: dict[str, Any],
        parents: tuple[str, ...],
        policy: str,
        revision: int,
    ) -> None:
        _require_node_id(node_id)
        async with self._runtime._context(self.scope_id) as context, self._runtime._locked(self.scope_id):
            nodes, _ = await self._repository.load(self.scope_id)
            by_id = {item.node_id: item for item in nodes}
            existing = by_id.get(node_id)
            if existing is not None:
                if (
                    existing.family,
                    existing.reference,
                    existing.parents,
                    existing.policy,
                    existing.revision,
                ) == (family, reference, parents, policy, revision):
                    return
                raise SourceLifecycleError("conflict")
            if node_id in parents:
                raise SourceLifecycleError("cycle")
            for parent in parents:
                if parent not in by_id:
                    raise SourceLifecycleError("unknown-parent")
            if family == "source":
                available = True
            elif policy == "all":
                available = all(by_id[parent].available for parent in parents)
            else:
                available = any(by_id[parent].available for parent in parents)
            node = _Node(
                node_id=node_id,
                family=family,
                reference=reference,
                parents=parents,
                policy=policy,
                revision=revision,
                ordinal=max((item.ordinal for item in nodes), default=-1) + 1,
                available=available,
            )
            if family == "memory" and not available:
                await self._set_entry(
                    node,
                    False,
                    service=context.artifacts.memory,
                    artifact_id=context.artifacts.memory_artifact_id,
                )
            await self._repository.insert_node(
                self.scope_id,
                node,
                excluded=family == "topic" and not available,
            )

    async def _apply_memory(
        self,
        nodes: tuple[_Node, ...],
        changed: Mapping[str, bool],
        context: Any,
    ) -> None:
        for node in nodes:
            if node.family != "memory" or node.node_id not in changed:
                continue
            await self._set_entry(
                node,
                changed[node.node_id],
                service=context.artifacts.memory,
                artifact_id=context.artifacts.memory_artifact_id,
            )

    async def _set_entry(self, node: _Node, available: bool, *, service: Any, artifact_id: str) -> None:
        citation = MemoryCitation.model_validate(node.reference)
        target = "active" if available else "inactive"
        try:
            head, entries = await service.head_entries(artifact_id)
        except Exception as error:  # noqa: BLE001 - storage failures surface as lifecycle errors
            raise SourceLifecycleError("memory-head") from error
        manifest = {item.entry_id: item for item in head.content.manifest.entries}
        item = manifest.get(citation.entry_id)
        if item is None:
            raise SourceLifecycleError("memory-entry")
        if item.state == target:
            return
        version = next((entry for entry in entries if entry.entry_id == citation.entry_id), None)
        if version is None:
            raise SourceLifecycleError("memory-entry")
        if available:
            await service.reactivate(head, entries=(version,), reason=_LIFECYCLE_REASON)
        else:
            await service.forget(head, entries=(version,), reason=_LIFECYCLE_REASON)

    async def _validate_memory(self, citation: MemoryCitation) -> None:
        try:
            async with self._runtime._context(self.scope_id) as context:
                await context.artifacts.memory.validate_citation(citation)
        except SourceLifecycleError:
            raise
        except Exception as error:  # noqa: BLE001 - citation validity is part of registration
            raise SourceLifecycleError("memory-citation") from error

    async def _validate_topic(self, reference: ArtifactRef) -> None:
        try:
            await self._runtime.records.for_scope(self.scope_id).get_artifact_revision(
                "topic-memory", reference.artifact_id, reference.revision
            )
        except Exception as error:  # noqa: BLE001 - artifact validity is part of registration
            raise SourceLifecycleError("topic-artifact") from error


class SourceLifecycleApplication:
    """Select a Scope-bound lifecycle application."""

    def __init__(self, runtime: BuiltinRuntime, repository: SourceLifecycleRepository) -> None:
        self._runtime = runtime
        self._repository = repository

    def for_scope(self, scope_id: str, /) -> SourceLifecycleScope:
        return SourceLifecycleScope(self._runtime, self._repository, scope_id)


def _require_node_id(node_id: str) -> None:
    if not isinstance(node_id, str) or not node_id or node_id != node_id.strip():
        raise SourceLifecycleError("node-id")
    if len(node_id) > MAX_LIFECYCLE_NODE_ID_LENGTH:
        raise SourceLifecycleError("node-id")


def _require_revision(revision: int) -> None:
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise SourceLifecycleError("revision")


def _require_parents(parents: tuple[str, ...], policy: str) -> None:
    if policy not in _POLICIES:
        raise SourceLifecycleError("policy")
    if not parents or len(set(parents)) != len(parents):
        raise SourceLifecycleError("parents")
    for parent in parents:
        _require_node_id(parent)
