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

"""Query-driven selection of literal evidence spans from retrieved Memory text.

The selection is a pure function of the query and the candidate texts. It never
rewrites, translates, or summarises: every span is a literal character range of
one original entry, so a reader can always walk back to the exact source.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass

_TOKEN_PATTERN = re.compile(r"[a-z0-9]+|[一-鿿]")
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?;])\s+|\n+")
_MAX_SEED_SENTENCES = 3


@dataclass(frozen=True)
class EvidenceSpan:
    """One literal span of one candidate document, with its query relevance."""

    document_index: int
    indices: tuple[int, ...]
    sentences: tuple[tuple[int, int], ...]
    text: str
    score: float

    @property
    def start(self) -> int:
        return self.sentences[0][0]

    @property
    def end(self) -> int:
        return self.sentences[-1][1]


@dataclass(frozen=True)
class _Document:
    """One candidate document split into sentence ranges with relevance weights."""

    text: str
    sentences: tuple[tuple[int, int], ...]
    weights: tuple[float, ...]


def select_evidence_spans(
    documents: Sequence[str],
    query: str,
    *,
    measure: Callable[[Sequence[EvidenceSpan]], int],
    max_bytes: int,
) -> tuple[EvidenceSpan, ...]:
    """Choose the literal spans that fit the byte budget and answer the query best.

    ``measure`` reports the rendered UTF-8 size of a candidate selection, so the
    budget covers the whole delivered context — envelope, citations, and text —
    rather than the evidence text alone. The most relevant span is grown into
    the space that is left, because every extra literal character can only add
    evidence, never remove it.
    """

    prepared = _prepare(documents, query)
    selected: list[EvidenceSpan] = []
    covered: list[set[int]] = [set() for _ in documents]
    for seed in _ranked_seeds(prepared):
        if covered[seed.document_index]:
            continue
        region = _grow(seed, prepared[seed.document_index], selected, measure=measure, max_bytes=max_bytes)
        if region is None:
            continue
        selected.append(region)
        covered[seed.document_index].update(region.indices)
    return tuple(selected)


def _prepare(documents: Sequence[str], query: str) -> list[_Document]:
    """Split every candidate into sentence ranges and weight the sentences."""

    segments = [_sentences(document) for document in documents]
    weights = _sentence_weights(segments, documents, query)
    return [
        _Document(text=document, sentences=sentences, weights=row)
        for document, sentences, row in zip(documents, segments, weights, strict=True)
    ]


def _sentences(document: str) -> tuple[tuple[int, int], ...]:
    """Split one document into sentence ranges, keeping exact character offsets."""

    spans: list[tuple[int, int]] = []
    start = 0
    for match in _SENTENCE_BOUNDARY.finditer(document):
        if match.start() > start:
            spans.append((start, match.start()))
        start = match.end()
    if start < len(document):
        spans.append((start, len(document)))
    trimmed: list[tuple[int, int]] = []
    for span_start, span_end in spans:
        while span_start < span_end and document[span_start].isspace():
            span_start += 1
        while span_end > span_start and document[span_end - 1].isspace():
            span_end -= 1
        if span_start < span_end:
            trimmed.append((span_start, span_end))
    return tuple(trimmed)


def _tokens(text: str) -> list[str]:
    return _TOKEN_PATTERN.findall(text.lower())


def _sentence_weights(
    segments: Sequence[Sequence[tuple[int, int]]],
    documents: Sequence[str],
    query: str,
) -> list[tuple[float, ...]]:
    """Score every sentence by the inverse document frequency of the query terms it holds."""

    query_terms = set(_tokens(query))
    if not query_terms:
        return [tuple(0.0 for _ in sentences) for sentences in segments]

    frequency: Counter[str] = Counter()
    for sentences, document in zip(segments, documents, strict=True):
        for start, end in sentences:
            frequency.update(set(_tokens(document[start:end])))

    total = sum(len(sentences) for sentences in segments)
    rows: list[tuple[float, ...]] = []
    for sentences, document in zip(segments, documents, strict=True):
        row: list[float] = []
        for start, end in sentences:
            matched = query_terms & set(_tokens(document[start:end]))
            row.append(sum(math.log(1 + total / frequency[term]) for term in matched))
        rows.append(tuple(row))
    return rows


def _ranked_seeds(documents: Sequence[_Document]) -> list[EvidenceSpan]:
    """Rank every candidate region by relevance, preferring longer regions on a tie."""

    ranked: list[EvidenceSpan] = []
    for document_index, document in enumerate(documents):
        for first in range(len(document.sentences)):
            for length in range(1, _MAX_SEED_SENTENCES + 1):
                end = first + length
                if end > len(document.sentences):
                    break
                indices = tuple(range(first, end))
                sentences = tuple(document.sentences[index] for index in indices)
                ranked.append(
                    EvidenceSpan(
                        document_index=document_index,
                        indices=indices,
                        sentences=sentences,
                        text=document.text[sentences[0][0] : sentences[-1][1]],
                        score=sum(document.weights[index] for index in indices),
                    )
                )
    ranked.sort(key=lambda span: (-span.score, -len(span.sentences)))
    return ranked


def _grow(
    seed: EvidenceSpan,
    document: _Document,
    selected: Sequence[EvidenceSpan],
    *,
    measure: Callable[[Sequence[EvidenceSpan]], int],
    max_bytes: int,
) -> EvidenceSpan | None:
    """Extend one relevant region into the budget that is left, or report that none fits."""

    best: EvidenceSpan | None = None
    for count in range(len(seed.indices), 0, -1):
        candidate = _respan(seed, document, seed.indices[:count])
        if measure((*selected, candidate)) <= max_bytes:
            best = candidate
            break
    if best is None:
        return None

    while True:
        extended = _extended(document, best)
        if extended is None:
            return best
        candidate = _respan(seed, document, extended)
        if measure((*selected, candidate)) > max_bytes:
            return best
        best = candidate


def _extended(document: _Document, span: EvidenceSpan) -> tuple[int, ...] | None:
    """Return the sentence indices of the most relevant neighbouring sentence."""

    right = span.indices[-1] + 1
    left = span.indices[0] - 1
    right_weight = document.weights[right] if right < len(document.sentences) else None
    left_weight = document.weights[left] if left >= 0 else None
    if right_weight is None and left_weight is None:
        return None
    if left_weight is None or (right_weight is not None and right_weight >= left_weight):
        return (*span.indices, right)
    return (left, *span.indices)


def _respan(seed: EvidenceSpan, document: _Document, indices: tuple[int, ...]) -> EvidenceSpan:
    """Rebuild one span over an explicit sentence index range."""

    sentences = tuple(document.sentences[index] for index in indices)
    return EvidenceSpan(
        document_index=seed.document_index,
        indices=indices,
        sentences=sentences,
        text=document.text[sentences[0][0] : sentences[-1][1]],
        score=seed.score,
    )


__all__ = ["EvidenceSpan", "select_evidence_spans"]
