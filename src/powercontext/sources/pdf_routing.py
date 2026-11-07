"""Section/statement-aware page routing over a 10-K page corpus (repo-ready, stdlib only).

Every rule here is derived from 10-K document structure (ITEM headings, primary
statement titles, note titles, geopolitical/segment wording) and a small finance
intent lexicon. Nothing depends on a particular filing or on gold labels.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Sequence

ITEM = re.compile(r"^item\s+(\d+[a-c]?)\s*[\.\u2014\-]?\s*(.*)$", re.I)
STMT = (
    (
        "income",
        re.compile(
            r"^consolidated (statements? of (income|operations|earnings)|statement of (income|operations|earnings))$",
            re.I,
        ),
    ),
    ("balance", re.compile(r"^consolidated (balance sheets?|statements? of financial position)$", re.I)),
    ("cashflow", re.compile(r"^consolidated (statements? of cash flows?|statement of cash flows?)$", re.I)),
    ("equity", re.compile(r"^consolidated statements? of (changes in )?(stockholders|shareholders)")),
)
INDEX_PAGE = re.compile(r"index to (the )?consolidated financial statements", re.I)
NOTE = re.compile(r"^note\s+\d+\s*[-\u2013\u2014:]\s*(.*)$", re.I)
GEO = re.compile(r"geograph", re.I)
LEGAL = re.compile(r"legal proceedings|litigation|legal proceeding", re.I)
COMPANY_TOKEN = re.compile(r"[^a-z0-9]+")

_HEADING_MAX_TERMS = 9
_HEADING_WEIGHT = 6.0
_K1, _B = 1.2, 0.75
_K1PLUS = 2.2
_STMT_LIMIT = 1
_BUCKET_LIMITS = {"business": 3, "risk": 12, "mda": 5, "fin": 5, "legal": 6, "geo": 3, "front": 1}
_NOTE_LIMIT = 3
_OPENING_PAGES = 3


def _lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


class PageFacts:
    """Per-page structure and term statistics, computed once per entry version."""

    __slots__ = ("counts", "doc", "headings", "is_index", "length", "lines", "page", "section", "stmt", "text", "title")

    def __init__(self, doc: str, page: int, text: str, tokenize: Callable[[str], Sequence[str]]) -> None:
        self.doc = doc
        self.page = page
        self.text = text
        self.lines = _lines(text)[:40]
        terms = list(tokenize(f"{doc}\n{text}"))
        self.length = max(1, len(terms))
        self.counts = Counter(terms)
        heading_terms: list[str] = []
        for line in text.splitlines():
            lt = tokenize(line)
            if 0 < len(lt) <= _HEADING_MAX_TERMS:
                heading_terms.extend(lt)
        self.headings = Counter(heading_terms)
        self.stmt, _item, self.is_index = _structure(self.lines)
        self.section = "FRONT"
        title = None
        for line in self.lines[:_HEADING_MAX_TERMS]:
            match = NOTE.match(line)
            if match:
                title = match.group(1)
                break
            if any(pattern.match(line.rstrip(".")) for _, pattern in STMT):
                title = line
                break
        self.title = Counter(tokenize(title)) if title else None

    @property
    def item(self) -> str | None:
        for line in self.lines[:8]:
            match = ITEM.match(line)
            if match:
                return match.group(1).upper()
        return None


def _structure(lines: Sequence[str]) -> tuple[str | None, str | None, bool]:
    stmt = None
    for tag, pattern in STMT:
        for line in lines[:10]:
            if pattern.match(line.rstrip(".")):
                stmt = tag
                break
        if stmt:
            break
    item = None
    for line in lines[:8]:
        match = ITEM.match(line)
        if match:
            item = match.group(1).upper()
            break
    return stmt, item, bool(INDEX_PAGE.search(" ".join(lines[:6])))


INTENTS: tuple[tuple[tuple[str, ...], tuple[str, ...]], ...] = (
    (("geograph", "region", "regions", "americas", "emea", "asia pacific"), ("geo", "business")),
    (("product", "service", "sells", "sell", "business", "industry"), ("business",)),
    (("customer", "customers", "concentration"), ("risk", "business")),
    (("cyclical", "cyclicality", "risk"), ("risk",)),
    (("production rate", "production rates", "forecasting"), ("risk", "mda")),
    (("legal", "lawsuit", "litigation", "battle", "proceeding", "regulatory", "settlement"), ("legal",)),
    (("segment", "reporting segment"), ("mda", "fin")),
    (("drove", "drive", "change", "changed", "increase", "decrease", "compare"), ("mda",)),
    (("restructuring",), ("fin", "mda")),
    (("acquisition", "acquisitions", "acquired", "divestiture", "divestitures", "merger"), ("fin", "mda")),
    (("registered", "securities exchange"), ("front",)),
    (("ratio", "liquidity", "liability", "liabilities", "balance sheet", "current assets"), ("stmt:balance",)),
    (("margin", "ebitda", "income", "tax rate", "operating", "gross"), ("stmt:income",)),
    (
        ("cash flow", "cash flows", "activities", "investing", "financing", "capex", "capital expenditure"),
        ("stmt:cashflow",),
    ),
)

COMPANY_ALIASES = {
    "amex": "americanexpress",
    "pepsi": "pepsico",
    "boeing": "boeing",
    "amd": "amd",
    "amcor": "amcor",
    "jnj": "johnsonjohnson",
    "j&j": "johnsonjohnson",
    "3m": "3m",
    "cvs": "cvshealth",
    "vz": "verizon",
    "pfe": "pfizer",
}


def intents(question: str) -> set[str]:
    low = " " + question.lower() + " "
    tags: set[str] = set()
    for phrases, names in INTENTS:
        if any(phrase in low for phrase in phrases):
            tags.update(names)
    if not tags:
        tags.add("mda")
    return tags


def _doc_base(doc: str) -> str:
    return doc.split("_")[0].lower()


_NON_NAME_TOKENS = frozenset({"10k", "10q", "20f", "8k", "inc", "plc", "corp", "corporation", "company", "the", "ltd"})


def _signatures(doc: str) -> set[str]:
    """Distinctive lowercase tokens of a document id, ignoring form and year tokens."""
    return {
        token
        for token in re.findall(r"[a-z0-9]+", doc.lower())
        if len(token) >= 4 and token not in _NON_NAME_TOKENS and not token.isdigit()
    }


def build_facts(pages: Iterable[tuple[str, int, str]], tokenize: Callable[[str], Sequence[str]]) -> list[PageFacts]:
    return [PageFacts(doc, page, text, tokenize) for doc, page, text in pages]


class PageRouter:
    """Route a question to the pages of one filing under a page-level corpus."""

    def __init__(self, facts: Iterable[PageFacts]) -> None:
        self.facts: list[PageFacts] = list(facts)
        self.by_doc: dict[str, list[int]] = defaultdict(list)
        for i, fact in enumerate(self.facts):
            self.by_doc[fact.doc].append(i)
        for doc, idxs in self.by_doc.items():
            idxs.sort(key=lambda i: self.facts[i].page)
            self._assign_sections(doc, idxs)
        self.canon: dict[str, dict[str, int]] = {}
        for doc, idxs in self.by_doc.items():
            for tag, _ in STMT:
                hits = [self.facts[i].page for i in idxs if self.facts[i].stmt == tag and not self.facts[i].is_index]
                if hits:
                    self.canon.setdefault(doc, {})[tag] = min(hits)
        total = len(self.facts)
        self.total = total
        self.average = sum(f.length for f in self.facts) / total or 1.0
        self.df: Counter[str] = Counter()
        for fact in self.facts:
            self.df.update(fact.counts.keys())
        self.index_of = {(f.doc, f.page): i for i, f in enumerate(self.facts)}

    def _assign_sections(self, doc: str, idxs: Sequence[int]) -> None:
        first_index = None
        for i in idxs:
            if self.facts[i].is_index:
                first_index = self.facts[i].page
                break
        current = "FRONT"
        for i in idxs:
            fact = self.facts[i]
            item = fact.item
            if item:
                current = f"ITEM{item}"
            fact.section = "FIN" if first_index is not None and fact.page >= first_index else current

    # ---------------------------------------------------------------- scoring
    def idf(self, term: str) -> float:
        df = self.df[term]
        return math.log(1 + (self.total - df + 0.5) / (df + 0.5)) if df else 0.0

    def score(self, i: int, terms: Sequence[str]) -> float:
        fact = self.facts[i]
        score = 0.0
        for term in terms:
            freq = fact.counts.get(term, 0)
            if not freq:
                continue
            score += self.idf(term) * freq * (_K1 + 1) / (freq + _K1 * (1 - _B + _B * fact.length / self.average))
        score += _HEADING_WEIGHT * sum(self.idf(term) for term in terms if term in fact.headings)
        return score

    def bm25_rank(self, terms: Sequence[str]) -> list[int]:
        ranked = [(self.score(i, terms), i) for i in range(self.total)]
        ranked.sort(key=lambda item: item[1])
        ranked.sort(key=lambda item: item[0], reverse=True)
        return [i for score, i in ranked if score > 0]

    # ---------------------------------------------------------------- routing
    def document_of(self, question: str, terms: Sequence[str]) -> str:
        candidates = list(self.by_doc)
        if len(candidates) == 1:
            return candidates[0]
        low = COMPANY_TOKEN.sub("", question.lower())
        tokens = set(re.findall(r"[a-z0-9]+", question.lower()))
        best: tuple[int, str] | None = None
        for doc in candidates:
            stripped = COMPANY_TOKEN.sub("", doc.lower())
            for signature in _signatures(doc):
                if signature in low and (best is None or len(signature) > best[0]):
                    best = (len(signature), doc)
            for alias, canonical in COMPANY_ALIASES.items():
                if alias in tokens and canonical in stripped and (best is None or len(alias) > best[0]):
                    best = (len(alias), doc)
        if best:
            return best[1]
        head = self.bm25_rank(terms)[:_HEADING_MAX_TERMS]
        if not head:
            return candidates[0]
        votes = Counter(self.facts[i].doc for i in head)
        return votes.most_common(1)[0][0]

    def _pages_in(self, doc: str, sections: Sequence[str]) -> list[int]:
        return [i for i in self.by_doc[doc] if self.facts[i].section in sections]

    def _bucket(self, doc: str, tag: str, limit: int, terms: Sequence[str]) -> list[int]:
        if tag.startswith("stmt:"):
            page = self.canon.get(doc, {}).get(tag.split(":")[1])
            return [self.index_of[(doc, page)]] if page else []
        if tag == "front":
            first = min(self.by_doc[doc])
            return [first]
        if tag == "geo":
            pages = [i for i in self.by_doc[doc] if GEO.search(" ".join(self.facts[i].lines[:8]))]
        elif tag == "legal":
            pages = [
                i
                for i in self.by_doc[doc]
                if self.facts[i].section in ("ITEM2", "ITEM3")
                or (self.facts[i].section == "FIN" and LEGAL.search(self.facts[i].text))
            ]
        else:
            sections = {"business": ("ITEM1",), "risk": ("ITEM1A",), "mda": ("ITEM7",), "fin": ("FIN", "ITEM8")}[tag]
            pages = self._pages_in(doc, sections)
        if not pages:
            return []
        scored = sorted(((self.score(i, terms), i) for i in pages), key=lambda item: item[1])
        scored.sort(key=lambda item: item[0], reverse=True)
        ranked = [i for _, i in scored[:limit]]
        opening = sorted(pages[:_OPENING_PAGES])
        return opening + [i for i in ranked if i not in opening]

    def _note_pages(self, doc: str, terms: Sequence[str], limit: int = _NOTE_LIMIT) -> list[int]:
        scored = []
        for i in self.by_doc[doc]:
            title = self.facts[i].title
            if title is None:
                continue
            matched = [term for term in terms if title.get(term)]
            if matched:
                scored.append((sum(self.idf(term) for term in matched), i))
        scored.sort(key=lambda item: item[1])
        scored.sort(key=lambda item: item[0], reverse=True)
        return [i for _, i in scored[:limit]]

    def rank(self, question: str, terms: Sequence[str], limit: int = 20) -> list[int]:
        doc = self.document_of(question, terms)
        tags = intents(question)
        seeds: list[int] = []
        for tag in (
            "stmt:income",
            "stmt:balance",
            "stmt:cashflow",
            "stmt:equity",
            "front",
            "geo",
            "legal",
            "business",
            "risk",
            "mda",
        ):
            if tag in tags:
                seeds.extend(
                    self._bucket(doc, tag, _STMT_LIMIT if tag.startswith("stmt:") else _BUCKET_LIMITS[tag], terms)
                )
        if tags & {"mda", "fin", "legal", "business"}:
            seeds.extend(self._note_pages(doc, terms))
        if "fin" in tags:
            seeds.extend(self._bucket(doc, "fin", _BUCKET_LIMITS["fin"], terms))
        seen: set[int] = set()
        out: list[int] = []
        for i in seeds + self.bm25_rank(terms):
            if i in seen:
                continue
            seen.add(i)
            out.append(i)
            if len(out) >= limit:
                break
        return out
