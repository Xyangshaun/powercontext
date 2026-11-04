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

"""Row-level CSV Source with stable identity and standard text evidence."""

from __future__ import annotations

import csv
import io
import json
from urllib.parse import quote

from pydantic import BaseModel

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import TEXT_EVIDENCE_PROJECTION_KEY, AdapterSourceDefinition, TextEvidence
from powercontext.sources.models import Source, SourceMaterialization

CSV_ROW_SOURCE_NAME = "csv-row"
CSV_ROW_SOURCE_VERSION = "1"


class CSVDocumentInput(BaseModel):
    """One offline CSV document to capture row by row."""

    document_id: str
    primary_key: str
    content: bytes


class CSVRowInput(BaseModel):
    """One captured row, identified by its document and primary key value."""

    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]


class CSVRowSource(Source):
    """A captured CSV row that stays addressable after reordering."""

    source_id: str
    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]


def csv_row_source_id(document_id: str, primary_key_value: str) -> str:
    """Build the delimiter-safe identity of one row inside one document."""

    document_part = _document_component(document_id)
    key_part = _key_component(primary_key_value)
    identity = f"csv:{document_part}:{key_part}"
    if len(identity) > MAX_SOURCE_ID_LENGTH:
        raise ValueError(
            f"CSV row identity must not exceed {MAX_SOURCE_ID_LENGTH} characters"
        )  # noqa: TRY003
    return identity


def parse_csv_document(value: CSVDocumentInput) -> tuple[CSVRowInput, ...]:
    """Capture every row of one document, or fail without returning partial rows."""

    document_id = value.document_id
    if not document_id or document_id != document_id.strip():
        raise ValueError("document_id must be a non-empty trimmed string")  # noqa: TRY003
    primary_key = value.primary_key
    if not primary_key:
        raise ValueError("primary_key must not be empty")  # noqa: TRY003

    try:
        text = value.content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("CSV content must be valid UTF-8") from error

    try:
        records = list(csv.reader(io.StringIO(text, newline=""), strict=True))
    except csv.Error as error:
        raise ValueError(f"CSV content is malformed: {error}") from error

    if not records:
        raise ValueError("CSV document must contain a header row")  # noqa: TRY003
    header = records[0]
    if not header:
        raise ValueError("CSV header row must not be empty")  # noqa: TRY003
    for column in header:
        if not column or not column.strip():
            raise ValueError("CSV header columns must be non-empty and non-blank")  # noqa: TRY003
    if len(set(header)) != len(header):
        raise ValueError("CSV header columns must be unique")  # noqa: TRY003
    if primary_key not in header:
        raise ValueError("primary_key must match one CSV header column exactly")  # noqa: TRY003

    key_index = header.index(primary_key)
    width = len(header)
    seen: set[str] = set()
    rows: list[CSVRowInput] = []
    for record in records[1:]:
        if not record:
            continue
        if len(record) != width:
            raise ValueError("CSV row field count must match the header width")  # noqa: TRY003
        primary_key_value = record[key_index]
        if not primary_key_value or not primary_key_value.strip():
            raise ValueError("CSV primary key values must be non-empty and non-blank")  # noqa: TRY003
        if primary_key_value in seen:
            raise ValueError("CSV primary key values must be unique within a document")  # noqa: TRY003
        seen.add(primary_key_value)
        rows.append(
            CSVRowInput(
                document_id=document_id,
                primary_key=primary_key,
                primary_key_value=primary_key_value,
                columns=tuple(header),
                values=tuple(record),
            )
        )
    return tuple(rows)


class CSVRowSourceAdapter:
    """Resolve and read the row-level CSV Source."""

    input_class = CSVRowInput
    name = CSV_ROW_SOURCE_NAME
    source_class = CSVRowSource

    async def resolve(self, value: CSVRowInput, /) -> CSVRowSource:
        source_id = csv_row_source_id(value.document_id, value.primary_key_value)
        return CSVRowSource(
            name=source_id,
            source_id=source_id,
            materialization=SourceMaterialization.CAPTURED,
            document_id=value.document_id,
            primary_key=value.primary_key,
            primary_key_value=value.primary_key_value,
            columns=value.columns,
            values=value.values,
        )

    async def read(self, source: CSVRowSource, /) -> CSVRowInput:
        return CSVRowInput(
            document_id=source.document_id,
            primary_key=source.primary_key,
            primary_key_value=source.primary_key_value,
            columns=source.columns,
            values=source.values,
        )


class CSVRowTextEvidenceProjection:
    """Expose one captured row as the standard textual evidence shape."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = CSVRowSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: CSVRowSource, /) -> TextEvidence:
        row = dict(zip(source.columns, source.values, strict=True))
        return TextEvidence(
            source_type=CSV_ROW_SOURCE_NAME,
            source_id=source.source_id,
            content=json.dumps(row, ensure_ascii=False, separators=(",", ":")),
            metadata={
                "document_id": source.document_id,
                "primary_key": source.primary_key,
                "primary_key_value": source.primary_key_value,
                "columns": list(source.columns),
                "row": row,
            },
        )


def _document_component(document_id: str) -> str:
    if not document_id or document_id != document_id.strip():
        raise ValueError("document_id must be a non-empty trimmed string")  # noqa: TRY003
    return quote(document_id, safe="")


def _key_component(primary_key_value: str) -> str:
    if not primary_key_value or not primary_key_value.strip():
        raise ValueError("primary_key_value must be non-empty and non-blank")  # noqa: TRY003
    return quote(primary_key_value, safe="")


CSV_ROW_SOURCE_ADAPTER = CSVRowSourceAdapter()
CSV_ROW_SOURCE_DEFINITION = AdapterSourceDefinition(
    CSV_ROW_SOURCE_ADAPTER,
    version=CSV_ROW_SOURCE_VERSION,
    projections=(CSVRowTextEvidenceProjection(),),
)

__all__ = [
    "CSV_ROW_SOURCE_DEFINITION",
    "CSVDocumentInput",
    "CSVRowInput",
    "CSVRowSource",
    "csv_row_source_id",
    "parse_csv_document",
]
