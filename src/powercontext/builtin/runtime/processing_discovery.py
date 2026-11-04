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

"""Bounded reconciliation of Source-driven Family progress at startup."""

from __future__ import annotations

from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from powercontext.builtin.persistence.cursors import SourceCursorRepository
from powercontext.builtin.persistence.database import AsyncDatabase
from powercontext.builtin.persistence.processing_intents import ArtifactProcessingIntentRepository
from powercontext.builtin.persistence.supervision import ArtifactProcessingFence, ArtifactProcessingLeaseRepository
from powercontext.builtin.persistence.tables import PROFILE_POLICIES_TABLE, SOURCE_JOURNAL_HEADS_TABLE


async def enabled_profile_scopes(connection: AsyncConnection, scope_ids: tuple[str, ...]) -> frozenset[str]:
    """Qualify one bounded automatic page before accepting any invocation.

    Hold enabled Policy rows through admission so concurrent policy changes
    serialize with the decision. This reads metadata only, before any Worker
    authorization, model construction, or retry state exists for the page.
    """

    if not scope_ids:
        return frozenset()
    table = PROFILE_POLICIES_TABLE
    rows = await connection.scalars(
        select(table.c.scope_id)
        .where(table.c.scope_id.in_(scope_ids), table.c.generation_enabled.is_(True))
        .with_for_update()
    )
    return frozenset(rows)


class SourceProcessingPendingProvider:
    """Inspect journal metadata, never Source bodies, prompts, or models."""

    def __init__(
        self,
        database: AsyncDatabase,
        binding_name: str,
        artifact_family: str,
        *,
        source_count_threshold: int | None = None,
    ) -> None:
        self._database = database
        self._binding = binding_name
        self._family = artifact_family
        self._threshold = source_count_threshold

    async def reconcile(self, after_scope_id: str | None, limit: int, *, fence: ArtifactProcessingFence) -> str | None:
        heads = SOURCE_JOURNAL_HEADS_TABLE
        statement = select(heads.c.scope_id, heads.c.position).order_by(heads.c.scope_id).limit(limit)
        if after_scope_id is not None:
            statement = statement.where(heads.c.scope_id > after_scope_id)
        if self._family == "profile":
            statement = statement.join(PROFILE_POLICIES_TABLE, PROFILE_POLICIES_TABLE.c.scope_id == heads.c.scope_id)
            statement = statement.where(PROFILE_POLICIES_TABLE.c.generation_enabled.is_(True))
        async with self._database.transaction() as connection:
            await ArtifactProcessingLeaseRepository().require_fence(connection, fence)
            rows = (await connection.execute(statement)).all()
            intents = ArtifactProcessingIntentRepository()
            cursors = SourceCursorRepository()
            for scope, high in rows:
                cursor = await cursors.load(connection, scope, self._binding)
                pending = int(high) - (0 if cursor is None else cursor.cursor.sequence)
                if pending <= 0:
                    continue
                intent = await intents.load(connection, scope, self._binding, for_update=True)
                if self._threshold is not None and pending >= self._threshold:
                    # Restart must not lose an already accepted invocation.
                    if intent is None or intent.requested_generation <= intent.handled_generation:
                        await intents.request(connection, scope, self._binding)
                    continue
                if intent is None or intent.dirty_generation == intent.clean_generation:
                    await intents.mark_dirty(connection, scope, self._binding)
        return str(rows[-1][0]) if len(rows) == limit else None


class SourceCountTrigger:
    """Request one bounded Family invocation per threshold crossing.

    The domain decides when enough unprocessed Sources accumulated; the
    Supervisor keeps its own scheduling and window limits. Requests travel the
    requested channel so they never depend on the time-based gate.
    """

    def __init__(self, database: AsyncDatabase, thresholds: Mapping[str, int]) -> None:
        self._database = database
        self._thresholds = dict(thresholds)
        self._intents = ArtifactProcessingIntentRepository()
        self._cursors = SourceCursorRepository()

    async def request_due(self, scope_id: str, /) -> tuple[str, ...]:
        if not self._thresholds:
            return ()
        heads = SOURCE_JOURNAL_HEADS_TABLE
        accepted: list[str] = []
        async with self._database.transaction() as connection:
            head = int(
                await connection.scalar(select(heads.c.position).where(heads.c.scope_id == scope_id)) or 0
            )
            for binding_name, threshold in self._thresholds.items():
                cursor = await self._cursors.load(connection, scope_id, binding_name)
                if head - (0 if cursor is None else cursor.cursor.sequence) < threshold:
                    continue
                intent = await self._intents.load(connection, scope_id, binding_name, for_update=True)
                if intent is not None and intent.requested_generation > intent.handled_generation:
                    continue
                await self._intents.request(connection, scope_id, binding_name)
                accepted.append(binding_name)
        return tuple(accepted)

