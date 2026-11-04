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

"""Chunked, digest-verified transport for prepared context.

The pack keeps the prepared content as a tuple of byte chunks plus a SHA-256 digest
over the canonical wire payload. A delta carries a reusable prefix count from a base
pack and the appended target chunks, so a receiver rebuilds the target with only the
serialized base pack and the delta.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

PACK_SCHEMA = "powercontext.context-pack.v1"
DELTA_SCHEMA = "powercontext.context-pack-delta.v1"
DEFAULT_CHUNK_BYTES = 512
_DIGEST_PREFIX = "sha256:"
_PACK_FIELDS = frozenset(("schema", "items", "digest", "byte_count"))
_DELTA_FIELDS = frozenset(("schema", "base_digest", "target_digest", "prefix_items", "appended"))


class ContextPackError(ValueError):
    """Reject an invalid pack, delta, chunking request, or reconstruction."""


def _canonical(payload: Mapping[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def _digest(items: tuple[bytes, ...]) -> str:
    unsigned = {"schema": PACK_SCHEMA, "items": [_encode_item(item) for item in items]}
    return _DIGEST_PREFIX + hashlib.sha256(_canonical(unsigned)).hexdigest()


def _encode_item(item: bytes) -> str:
    return base64.b64encode(item).decode("ascii")


def _decode_items(values: object) -> tuple[bytes, ...]:
    if not isinstance(values, list):
        raise ContextPackError("items must be a list")
    decoded: list[bytes] = []
    for value in values:
        if not isinstance(value, str):
            raise ContextPackError("items must be Base64 strings")
        try:
            decoded.append(base64.b64decode(value.encode("ascii"), validate=True))
        except (binascii.Error, UnicodeEncodeError) as error:
            raise ContextPackError("items must be valid Base64") from error
    return tuple(decoded)


def _validate_digest(value: object) -> str:
    if not isinstance(value, str) or not value.startswith(_DIGEST_PREFIX):
        raise ContextPackError("digest must be a sha256:<hex> string")
    hexadecimal = value[len(_DIGEST_PREFIX) :]
    if len(hexadecimal) != 64 or any(character not in "0123456789abcdef" for character in hexadecimal):
        raise ContextPackError("digest must be a sha256:<hex> string")
    return value


def _load_payload(payload: bytes, /) -> dict[str, Any]:
    try:
        decoded = json.loads(bytes(payload))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContextPackError("payload must be UTF-8 JSON") from error
    if not isinstance(decoded, dict):
        raise ContextPackError("payload must be a JSON object")
    return decoded


@dataclass(frozen=True, slots=True)
class ContextPack:
    """A complete context payload: ordered byte chunks plus their wire digest."""

    items: tuple[bytes, ...]
    digest: str
    byte_count: int

    @classmethod
    def build(cls, items: tuple[bytes, ...], /) -> ContextPack:
        normalized = tuple(items)
        for item in normalized:
            if type(item) is not bytes:
                raise ContextPackError("items must be bytes")
        digest = _digest(normalized)
        byte_count = 0
        while True:
            candidate = cls(normalized, digest, byte_count)
            measured = len(candidate.to_bytes())
            if measured == byte_count:
                return candidate
            byte_count = measured

    @classmethod
    def from_content(cls, content: str | bytes, /, *, chunk_bytes: int = DEFAULT_CHUNK_BYTES) -> ContextPack:
        if type(chunk_bytes) is not int or chunk_bytes <= 0:
            raise ContextPackError("chunk_bytes must be a positive integer")
        text = content.encode("utf-8") if isinstance(content, str) else bytes(content)
        return cls.build(_chunk_content(text, chunk_bytes))

    def to_bytes(self) -> bytes:
        return _canonical(
            {
                "schema": PACK_SCHEMA,
                "items": [_encode_item(item) for item in self.items],
                "digest": self.digest,
                "byte_count": self.byte_count,
            }
        )

    @classmethod
    def from_bytes(cls, payload: bytes, /) -> ContextPack:
        decoded = _load_payload(payload)
        if set(decoded) != _PACK_FIELDS:
            raise ContextPackError("pack fields do not match the schema")
        if decoded.get("schema") != PACK_SCHEMA:
            raise ContextPackError("pack schema is not supported")
        items = _decode_items(decoded.get("items"))
        digest = _validate_digest(decoded.get("digest"))
        if digest != _digest(items):
            raise ContextPackError("pack digest does not match its items")
        byte_count = decoded.get("byte_count")
        if type(byte_count) is not int or byte_count != len(bytes(payload)):
            raise ContextPackError("pack byte_count does not match its payload")
        return cls(items, digest, byte_count)


@dataclass(frozen=True, slots=True)
class ContextPackDelta:
    """The prefix of a base pack to keep plus the target chunks appended after it."""

    base_digest: str
    target_digest: str
    prefix_items: int
    appended: tuple[bytes, ...]

    @classmethod
    def between(cls, base: ContextPack, target: ContextPack, /) -> ContextPackDelta:
        if not isinstance(base, ContextPack) or not isinstance(target, ContextPack):
            raise ContextPackError("delta requires ContextPack operands")
        prefix = 0
        shared = min(len(base.items), len(target.items))
        while prefix < shared and base.items[prefix] == target.items[prefix]:
            prefix += 1
        return cls(base.digest, target.digest, prefix, target.items[prefix:])

    @property
    def byte_count(self) -> int:
        return len(self.to_bytes())

    def to_bytes(self) -> bytes:
        return _canonical(
            {
                "schema": DELTA_SCHEMA,
                "base_digest": self.base_digest,
                "target_digest": self.target_digest,
                "prefix_items": self.prefix_items,
                "appended": [_encode_item(item) for item in self.appended],
            }
        )

    @classmethod
    def from_bytes(cls, payload: bytes, /) -> ContextPackDelta:
        decoded = _load_payload(payload)
        if set(decoded) != _DELTA_FIELDS:
            raise ContextPackError("delta fields do not match the schema")
        if decoded.get("schema") != DELTA_SCHEMA:
            raise ContextPackError("delta schema is not supported")
        base_digest = _validate_digest(decoded.get("base_digest"))
        target_digest = _validate_digest(decoded.get("target_digest"))
        prefix = decoded.get("prefix_items")
        if type(prefix) is not int or prefix < 0:
            raise ContextPackError("prefix_items must be a non-negative integer")
        appended = _decode_items(decoded.get("appended"))
        return cls(base_digest, target_digest, prefix, appended)


def apply_context_pack_delta(base: ContextPack, delta: ContextPackDelta, /) -> ContextPack:
    """Rebuild the target pack from a base pack and its delta, verifying both digests."""

    if not isinstance(base, ContextPack) or not isinstance(delta, ContextPackDelta):
        raise ContextPackError("reconstruction requires a pack and a delta")
    if delta.base_digest != base.digest:
        raise ContextPackError("delta base digest does not match the given pack")
    if delta.prefix_items > len(base.items):
        raise ContextPackError("delta prefix exceeds the base pack")
    rebuilt = ContextPack.build((*base.items[: delta.prefix_items], *delta.appended))
    if rebuilt.digest != delta.target_digest:
        raise ContextPackError("delta target digest does not match the rebuilt content")
    return rebuilt


def _chunk_content(payload: bytes, limit: int, /) -> tuple[bytes, ...]:
    """Greedily pack whole lines, splitting over-long lines on UTF-8 boundaries."""

    if not payload:
        return ()
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ContextPackError("content must be valid UTF-8") from error
    chunks: list[bytes] = []
    pending: list[bytes] = []
    pending_bytes = 0

    def flush() -> None:
        nonlocal pending_bytes
        if pending:
            chunks.append(b"".join(pending))
            pending.clear()
            pending_bytes = 0

    for line in text.splitlines(keepends=True):
        encoded = line.encode("utf-8")
        if len(encoded) > limit:
            flush()
            chunks.extend(_split_long_line(line, limit))
            continue
        if pending_bytes + len(encoded) > limit:
            flush()
        pending.append(encoded)
        pending_bytes += len(encoded)
    flush()
    if not chunks and text:
        raise ContextPackError("content could not be chunked")
    return tuple(chunks)


def _split_long_line(line: str, limit: int, /) -> list[bytes]:
    pieces: list[bytes] = []
    current: list[str] = []
    current_bytes = 0
    for character in line:
        size = len(character.encode("utf-8"))
        if size > limit:
            raise ContextPackError("chunk_bytes is too small for the content")
        if current_bytes + size > limit:
            pieces.append("".join(current).encode("utf-8"))
            current = []
            current_bytes = 0
        current.append(character)
        current_bytes += size
    if current:
        pieces.append("".join(current).encode("utf-8"))
    return pieces
