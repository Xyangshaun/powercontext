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

"""Pi session branch capture: raw visible events, identity, and resumable import."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import TEXT_EVIDENCE_PROJECTION_KEY, AdapterSourceDefinition, TextEvidence
from powercontext.sources.connectors import ConnectorRunCompletion, ConnectorRunSession, ConnectorRunStatus
from powercontext.sources.models import Source, SourceMaterialization

PI_EVENT_SOURCE_NAME = "pi-event"
PI_EVENT_SOURCE_VERSION = "1"
PI_SESSION_CONNECTOR_NAME = "pi-session-history"
PI_SESSION_CONNECTOR_VERSION = "1"
PI_CHECKPOINT_SCHEMA = "powercontext.pi-session-history.v1"

_HEADER_TYPE = "session"
_HEADER_VERSION = 3
_TEXT_EVENT_TYPES = ("compaction", "branch_summary", "custom_message")


class PiSessionInput(BaseModel):
    """One complete Pi v3 JSONL session archive and the leaf whose branch is wanted."""

    model_config = ConfigDict(frozen=True)

    content: bytes
    leaf_id: str | None = None


class PiEventInput(BaseModel):
    """One visible event on the selected branch, with its untouched input record."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict[str, Any]


class PiEventSource(Source):
    """A captured Pi event whose identity survives branch switches and restarts."""

    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict[str, Any]


def pi_event_source_id(session_id: str, event_id: str, /) -> str:
    """Build a delimiter-safe identity from the session and event ids only."""

    identity = f"pi:{quote(session_id, safe='')}:{quote(event_id, safe='')}"
    if len(identity) > MAX_SOURCE_ID_LENGTH:
        digest = hashlib.sha256(f"{session_id}\x00{event_id}".encode()).hexdigest()
        identity = f"pi:{digest}"
    return identity


def parse_pi_session(value: PiSessionInput, /) -> tuple[PiEventInput, ...]:
    """Return the visible events of the selected branch, ordered root to leaf."""

    if not isinstance(value, PiSessionInput):
        raise ValueError("PiSessionInput is required")  # noqa: TRY003
    session_id, records, events = _parse_archive(value.content, value.leaf_id)
    del records
    return events


def _parse_archive(raw: bytes, leaf_id: str | None, /) -> tuple[str, dict[str, dict[str, Any]], tuple[PiEventInput, ...]]:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("Pi session archive must be valid UTF-8") from error

    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise ValueError("Pi session archive must not be empty")  # noqa: TRY003
    documents = [_load_record(line) for line in lines]

    header = documents[0]
    if header.get("type") != _HEADER_TYPE:
        raise ValueError("the first record must be a Pi session header")  # noqa: TRY003
    if header.get("version") != _HEADER_VERSION:
        raise ValueError("the Pi session header must declare version 3")  # noqa: TRY003
    session_id = header.get("id")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("the Pi session header must declare a non-empty id")  # noqa: TRY003

    records: dict[str, dict[str, Any]] = {}
    parents: dict[str, str | None] = {}
    order: list[str] = []
    for document in documents[1:]:
        event_id = document.get("id")
        if not isinstance(event_id, str) or not event_id:
            raise ValueError("every Pi record must declare a non-empty id")  # noqa: TRY003
        if event_id in records:
            raise ValueError(f"duplicate Pi record id {event_id!r}")  # noqa: TRY003
        parent_id = document.get("parentId")
        if parent_id is not None and (not isinstance(parent_id, str) or not parent_id):
            raise ValueError(f"Pi record {event_id!r} has an invalid parentId")  # noqa: TRY003
        if parent_id is not None and parent_id not in records:
            raise ValueError(f"Pi record {event_id!r} references a missing parent")  # noqa: TRY003
        records[event_id] = document
        parents[event_id] = parent_id
        order.append(event_id)

    if not order:
        raise ValueError("the Pi session must contain at least one record")  # noqa: TRY003
    leaf = leaf_id if leaf_id is not None else order[-1]
    if leaf not in records:
        raise ValueError(f"Pi leaf {leaf!r} is not present in the session")  # noqa: TRY003

    chain: list[str] = []
    visited: set[str] = set()
    cursor: str | None = leaf
    while cursor is not None:
        if cursor in visited:
            raise ValueError("the Pi session graph contains a cycle")  # noqa: TRY003
        visited.add(cursor)
        chain.append(cursor)
        cursor = parents[cursor]
    chain.reverse()

    events: list[PiEventInput] = []
    for event_id in chain:
        rendered = _render_event(session_id, records[event_id], parents[event_id])
        if rendered is not None:
            events.append(rendered)
    return session_id, records, tuple(events)


def _load_record(line: str) -> dict[str, Any]:
    try:
        document = json.loads(line)
    except json.JSONDecodeError as error:
        raise ValueError("Pi session records must be JSON lines") from error
    if not isinstance(document, dict):
        raise ValueError("Pi session records must be JSON objects")  # noqa: TRY003
    return document


def _render_event(
    session_id: str,
    record: dict[str, Any],
    parent_id: str | None,
    /,
) -> PiEventInput | None:
    event_id = record["id"]
    event_type = record.get("type")
    if not isinstance(event_type, str):
        return None
    role, body = _render_body(event_type, record)
    if role is None or not body:
        return None
    return PiEventInput(
        session_id=session_id,
        event_id=event_id,
        parent_id=parent_id,
        event_type=event_type,
        role=role,
        content=f"{role}: {body}",
        record=record,
    )


def _render_body(event_type: str, record: dict[str, Any], /) -> tuple[str | None, str]:
    if event_type == "message":
        message = record.get("message")
        if not isinstance(message, dict):
            return None, ""
        role = message.get("role")
        if not isinstance(role, str) or not role:
            return None, ""
        if role == "toolResult":
            name = _string_or(message.get("toolName"), "unknown")
            call_id = _string_or(message.get("toolCallId"), "unknown")
            text = _visible_text(message.get("content"))
            return role, f"[tool_result {name} {call_id}] {text}"
        if role == "bashExecution":
            command = _string_or(message.get("command"), "")
            output = _string_or(message.get("output"), "")
            return role, f"$ {command}\n{output}"
        return role, _render_content(message.get("content"))
    if event_type in ("compaction", "branch_summary"):
        summary = record.get("summary")
        return event_type, summary if isinstance(summary, str) else ""
    if event_type == "custom_message":
        body = _visible_text(record.get("content"))
        if not body:
            message = record.get("message")
            body = _visible_text(message.get("content")) if isinstance(message, dict) else ""
        return "custom", body
    return None, ""


def _render_content(content: object) -> str:
    """Render message content: text as-is, tool calls as compact sorted JSON, others skipped."""

    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    pieces: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text":
            text = block.get("text")
            if isinstance(text, str):
                pieces.append(text)
        elif kind == "toolCall":
            name = _string_or(block.get("name"), "unknown")
            call_id = _string_or(block.get("id"), "unknown")
            arguments = block.get("arguments")
            pieces.append(f"[tool_call {name} {call_id}] {_compact_json(arguments)}")
    return "\n".join(pieces)


def _visible_text(content: object) -> str:
    """Join the visible text blocks of one tool result or custom message."""

    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    pieces = [
        block["text"]
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    ]
    return "\n".join(pieces)


def _compact_json(value: object) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _string_or(value: object, fallback: str) -> str:
    return value if isinstance(value, str) else fallback


class PiEventSourceAdapter:
    """Resolve and read the captured Pi event Source."""

    input_class = PiEventInput
    name = PI_EVENT_SOURCE_NAME
    source_class = PiEventSource

    async def resolve(self, value: PiEventInput, /) -> PiEventSource:
        return PiEventSource(
            name=pi_event_source_id(value.session_id, value.event_id),
            definition_version=PI_EVENT_SOURCE_VERSION,
            materialization=SourceMaterialization.CAPTURED,
            session_id=value.session_id,
            event_id=value.event_id,
            parent_id=value.parent_id,
            event_type=value.event_type,
            role=value.role,
            content=value.content,
            record=value.record,
        )

    async def read(self, source: PiEventSource, /) -> PiEventInput:
        return PiEventInput(
            session_id=source.session_id,
            event_id=source.event_id,
            parent_id=source.parent_id,
            event_type=source.event_type,
            role=source.role,
            content=source.content,
            record=source.record,
        )


class PiEventTextEvidenceProjection:
    """Expose one captured Pi event as the standard textual evidence shape."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PiEventSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PiEventSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PI_EVENT_SOURCE_NAME,
            source_id=source.name,
            content=source.content,
            metadata={
                "session_id": source.session_id,
                "event_id": source.event_id,
                "parent_id": source.parent_id,
                "event_type": source.event_type,
                "role": source.role,
            },
        )


class PiSessionConnector:
    """Import the selected branch once, resuming from the lifecycle checkpoint."""

    name = PI_SESSION_CONNECTOR_NAME
    version = PI_SESSION_CONNECTOR_VERSION
    source_definitions = frozenset({PI_EVENT_SOURCE_NAME})

    def __init__(self, path: str | Path, leaf_id: str | None = None) -> None:
        self._path = Path(path)
        self._leaf_id = leaf_id

    async def run(self, session: ConnectorRunSession, /) -> ConnectorRunCompletion:
        raw = self._path.read_bytes()
        session_id, records, events = _parse_archive(raw, self._leaf_id)
        imported = _load_checkpoint(session.checkpoint, session_id)
        for event_id, digest in imported.items():
            record = records.get(event_id)
            if record is not None and _record_digest(record) != digest:
                raise ValueError(f"imported Pi event {event_id!r} was rewritten")  # noqa: TRY003
        for event in events:
            if event.event_id in imported:
                continue
            await session.submit(event.event_id, PI_EVENT_SOURCE_NAME, event)
            imported[event.event_id] = _record_digest(event.record)
        return ConnectorRunCompletion(
            status=ConnectorRunStatus.COMPLETE,
            checkpoint={
                "schema": PI_CHECKPOINT_SCHEMA,
                "session_id": session_id,
                "events": dict(sorted(imported.items())),
            },
        )


def _load_checkpoint(checkpoint: object, session_id: str, /) -> dict[str, str]:
    if checkpoint is None:
        return {}
    if not isinstance(checkpoint, dict):
        raise ValueError("the Pi session checkpoint must be a JSON object")  # noqa: TRY003
    if checkpoint.get("schema") != PI_CHECKPOINT_SCHEMA:
        raise ValueError("the Pi session checkpoint schema is not supported")  # noqa: TRY003
    if checkpoint.get("session_id") != session_id:
        return {}
    events = checkpoint.get("events")
    if not isinstance(events, dict):
        raise ValueError("the Pi session checkpoint events must be a JSON object")  # noqa: TRY003
    imported: dict[str, str] = {}
    for event_id, digest in events.items():
        if not isinstance(event_id, str) or not isinstance(digest, str):
            raise ValueError("the Pi session checkpoint entries must be strings")  # noqa: TRY003
        imported[event_id] = digest
    return imported


def _record_digest(record: dict[str, Any], /) -> str:
    canonical = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


PI_EVENT_SOURCE_DEFINITION = AdapterSourceDefinition(
    PiEventSourceAdapter(),
    version=PI_EVENT_SOURCE_VERSION,
    projections=(PiEventTextEvidenceProjection(),),
)

__all__ = [
    "PI_EVENT_SOURCE_DEFINITION",
    "PI_EVENT_SOURCE_NAME",
    "PI_SESSION_CONNECTOR_NAME",
    "PiEventInput",
    "PiEventSource",
    "PiSessionConnector",
    "PiSessionInput",
    "parse_pi_session",
    "pi_event_source_id",
]
