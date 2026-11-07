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

"""Page-level PDF Source: full physical-page extraction and evidence-page retrieval."""

from __future__ import annotations

import hashlib
import io
import re
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict
from pypdf import PdfReader

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import TEXT_EVIDENCE_PROJECTION_KEY, AdapterSourceDefinition, TextEvidence
from powercontext.sources.models import Source, SourceMaterialization

if TYPE_CHECKING:
    from powercontext.builtin.artifacts.memory import MemoryCitation

PDF_PAGE_SOURCE_NAME = "pdf-page"
PDF_PAGE_SOURCE_VERSION = "1"

_SEARCH_TERM_CAP = 16


class PDFDocumentInput(BaseModel):
    """One complete original PDF document."""

    model_config = ConfigDict(frozen=True)

    document_id: str
    content: bytes


class PDFPageInput(BaseModel):
    """One physical page of a PDF document, numbered from one."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    document_id: str
    document_sha256: str
    page_number: int
    text: str


class PDFPageSource(Source):
    """A captured PDF page whose identity follows the document revision."""

    source_id: str
    document_id: str
    document_sha256: str
    page_number: int
    text: str


def pdf_page_source_id(document_id: str, document_sha256: str, page_number: int, /) -> str:
    """Build the identity of one page inside one document revision."""

    identity = f"pdf:{quote(document_id, safe='')}:{document_sha256}:{page_number}"
    if len(identity) > MAX_SOURCE_ID_LENGTH:
        digest = hashlib.sha256(f"{document_id}\x00{document_sha256}\x00{page_number}".encode()).hexdigest()
        identity = f"pdf:{digest}"
    return identity


def parse_pdf_document(value: PDFDocumentInput, /) -> tuple[PDFPageInput, ...]:
    """Extract every physical page in order, or fail without returning partial pages."""

    if not isinstance(value, PDFDocumentInput):
        raise ValueError("PDFDocumentInput is required")  # noqa: TRY003
    document_id = value.document_id
    if not document_id or document_id != document_id.strip():
        raise ValueError("document_id must be a non-empty trimmed string")  # noqa: TRY003
    content = value.content
    if not content:
        raise ValueError("PDF document must not be empty")  # noqa: TRY003

    digest = hashlib.sha256(content).hexdigest()
    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted and not reader.decrypt(""):
            raise ValueError("PDF document requires a user password")  # noqa: TRY003
        pages = tuple(
            PDFPageInput(
                document_id=document_id,
                document_sha256=digest,
                page_number=page_number,
                text=page.extract_text() or "",
            )
            for page_number, page in enumerate(reader.pages, start=1)
        )
    except ValueError:
        raise
    except Exception as error:  # pypdf reports damaged input through its own exception types
        raise ValueError(f"PDF document could not be parsed: {error}") from error
    if not pages:
        raise ValueError("PDF document must contain at least one page")  # noqa: TRY003
    return pages


class PDFPageSourceAdapter:
    """Resolve and read the page-level PDF Source."""

    input_class = PDFPageInput
    name = PDF_PAGE_SOURCE_NAME
    source_class = PDFPageSource

    async def resolve(self, value: PDFPageInput, /) -> PDFPageSource:
        source_id = pdf_page_source_id(value.document_id, value.document_sha256, value.page_number)
        return PDFPageSource(
            name=source_id,
            source_id=source_id,
            materialization=SourceMaterialization.CAPTURED,
            document_id=value.document_id,
            document_sha256=value.document_sha256,
            page_number=value.page_number,
            text=value.text,
        )

    async def read(self, source: PDFPageSource, /) -> PDFPageInput:
        return PDFPageInput(
            document_id=source.document_id,
            document_sha256=source.document_sha256,
            page_number=source.page_number,
            text=source.text,
        )


class PDFPageTextEvidenceProjection:
    """Expose one captured page as the standard textual evidence shape."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PDFPageSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PDFPageSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PDF_PAGE_SOURCE_NAME,
            source_id=source.source_id,
            content=f"{source.document_id}\n{source.text}",
            metadata={
                "document_id": source.document_id,
                "document_sha256": source.document_sha256,
                "page_number": source.page_number,
            },
        )


_PAGE_FACTS: dict[str, Any] = {}
_FISCAL_YEAR = re.compile(r"fy(\d{4})")
_PAGE_SOURCE_ID = re.compile(r"^pdf:(.*):([0-9a-f]{64}):(\d+)$")


def _question_terms(question: str, analyze_query: Any, function_words: frozenset[str]) -> tuple[str, ...]:
    """Normalize a question to content terms, expanding fiscal-year labels the filings spell out."""

    terms = [_FISCAL_YEAR.sub(r"\1", term) for term in dict.fromkeys(analyze_query(question).split())]
    meaningful = [term for term in terms if term not in function_words]
    return tuple((meaningful or terms)[:_SEARCH_TERM_CAP])


def _stemmed_terms(text: str) -> list[str]:
    """Analyzer v1 terms folded to Porter stems, so inflections of one concept meet."""

    from powercontext.builtin.artifacts.search import analyze_text
    from powercontext.sources import _porter

    return [_porter.stem(term) for term in analyze_text(text).split()]


def _page_facts(record: Any) -> Any:
    """Structure and term statistics of one page entry, cached per immutable version."""

    from powercontext.sources.pdf_routing import PageFacts

    version_id = record.entry.entry_version_id
    cached = _PAGE_FACTS.get(version_id)
    if cached is not None:
        return cached
    text = record.entry.text
    document_id, _, page_text = text.partition("\n")
    page_number = None
    for reference in record.entry.sources:
        if reference.source_type == PDF_PAGE_SOURCE_NAME:
            match = _PAGE_SOURCE_ID.match(reference.source_id)
            if match:
                page_number = int(match.group(3))
                break
    facts = PageFacts(document_id.strip(), page_number or 0, page_text, _stemmed_terms)
    _PAGE_FACTS[version_id] = facts
    return facts


def _router_terms(question: str, analyze_query: Any, function_words: frozenset[str]) -> tuple[str, ...]:
    """Stem the question's content terms exactly as the page corpus is tokenized."""

    from powercontext.sources import _porter

    asked = _question_terms(question, analyze_query, function_words)
    return tuple(dict.fromkeys(_porter.stem(term) for term in asked))


async def search_pdf_pages(memory: Any, question: str, limit: int = 10) -> tuple[MemoryCitation, ...]:
    """Rank distinct evidence pages for one natural-language question.

    Route the question through the filing's own structure first (primary statements,
    ITEM sections, note titles), then fall back to BM25 over the same Analyzer v1 terms
    the stored FTS projection uses. Keep one citation per physical page.
    """

    from powercontext.builtin.artifacts.memory import MemoryCitation
    from powercontext.builtin.artifacts.search import _QUERY_FUNCTION_WORDS, analyze_fts_query
    from powercontext.sources.pdf_routing import PageRouter

    if limit <= 0:
        return ()
    terms = _router_terms(question, analyze_fts_query, _QUERY_FUNCTION_WORDS)
    if not terms:
        return ()
    entries = (await memory.list()).entries
    if not entries:
        return ()

    corpus = [(record, _page_facts(record)) for record in entries]
    router = PageRouter(facts for _, facts in corpus)
    ranked = router.rank(question, terms, limit=len(corpus))

    citations: list[MemoryCitation] = []
    seen_pages: set[str] = set()
    for index in ranked:
        record = corpus[index][0]
        page_source_id = next(
            (
                reference.source_id
                for reference in record.entry.sources
                if reference.source_type == PDF_PAGE_SOURCE_NAME
            ),
            None,
        )
        if page_source_id is None or page_source_id in seen_pages:
            continue
        seen_pages.add(page_source_id)
        citations.append(
            MemoryCitation(
                memory_ref=record.memory_ref,
                entry_id=record.entry.entry_id,
                entry_version_id=record.entry.entry_version_id,
            )
        )
        if len(citations) >= limit:
            break
    return tuple(citations)


PDF_PAGE_SOURCE_ADAPTER = PDFPageSourceAdapter()
PDF_PAGE_SOURCE_DEFINITION = AdapterSourceDefinition(
    PDF_PAGE_SOURCE_ADAPTER,
    version=PDF_PAGE_SOURCE_VERSION,
    projections=(PDFPageTextEvidenceProjection(),),
)

__all__ = [
    "PDF_PAGE_SOURCE_DEFINITION",
    "PDFDocumentInput",
    "PDFPageInput",
    "PDFPageSource",
    "parse_pdf_document",
    "pdf_page_source_id",
    "search_pdf_pages",
]
