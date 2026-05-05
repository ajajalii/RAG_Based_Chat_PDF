from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

import chromadb
from chromadb.utils import embedding_functions
from django.conf import settings
from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from .pdf_extract import extract_pages_text

CHUNK_SIZE = 900
CHUNK_OVERLAP = 120


def _chunk_page_text(page_num: int, text: str) -> list[dict[str, Any]]:
    t = text.strip()
    if not t:
        return []
    chunks: list[dict[str, Any]] = []
    start = 0
    while start < len(t):
        end = min(start + CHUNK_SIZE, len(t))
        piece = t[start:end].strip()
        if piece:
            chunks.append({"text": piece, "page": page_num})
        if end >= len(t):
            break
        start = max(0, end - CHUNK_OVERLAP)
    return chunks


def _get_chroma_client():
    return chromadb.PersistentClient(path=settings.CHROMA_PATH)


def _embedding_fn():
    return embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name="all-MiniLM-L6-v2"
    )


def _collection_name(document_id) -> str:
    # Django <uuid:document_id> passes uuid.UUID; upload uses str.
    return f"doc_{str(document_id).replace('-', '_')}"


def _page_from_metadata(meta: dict[str, Any] | None, default: int = 1) -> int:
    if not meta:
        return default
    p = meta.get("page", default)
    if p is None:
        return default
    try:
        return int(p)
    except (TypeError, ValueError):
        return default


def ingest_pdf(document_id: str, pdf_path: str | Path) -> dict[str, Any]:
    path = Path(pdf_path)
    pages = extract_pages_text(path)
    all_chunks: list[dict[str, Any]] = []
    for page_num, text in pages:
        all_chunks.extend(_chunk_page_text(page_num, text))

    client = _get_chroma_client()
    ef = _embedding_fn()
    name = _collection_name(document_id)
    try:
        client.delete_collection(name)
    except Exception:
        pass
    col = client.create_collection(name=name, embedding_function=ef)

    if not all_chunks:
        return {"document_id": document_id, "pages": len(pages), "chunks": 0}

    ids = [str(uuid.uuid4()) for _ in all_chunks]
    documents = [c["text"] for c in all_chunks]
    metadatas = [{"page": c["page"]} for c in all_chunks]
    col.add(ids=ids, documents=documents, metadatas=metadatas)
    return {"document_id": document_id, "pages": len(pages), "chunks": len(all_chunks)}


def _gemini_api_key() -> str:
    return (settings.GEMINI_API_KEY or "").strip()


def _gemini_model_name() -> str:
    name = (settings.GEMINI_MODEL or "gemini-2.5-flash").strip()
    if name.startswith("models/"):
        return name[len("models/") :]
    return name


def _gemini_client():
    key = _gemini_api_key()
    if not key:
        return None
    return genai.Client(api_key=key)


def _gemini_text_response(response) -> str:
    try:
        return (response.text or "").strip()
    except (ValueError, AttributeError):
        return ""


def _gemini_generate(
    user_prompt: str,
    *,
    system_instruction: str | None = None,
    temperature: float = 0.2,
    json_mode: bool = False,
) -> str:
    client = _gemini_client()
    if client is None:
        return ""
    model_name = _gemini_model_name()
    cfg_kwargs: dict[str, Any] = {"temperature": temperature}
    if system_instruction is not None:
        cfg_kwargs["system_instruction"] = system_instruction
    if json_mode:
        cfg_kwargs["response_mime_type"] = "application/json"
    config = types.GenerateContentConfig(**cfg_kwargs)
    try:
        response = client.models.generate_content(
            model=model_name,
            contents=user_prompt,
            config=config,
        )
    except genai_errors.APIError as e:
        msg = str(e).strip() or e.__class__.__name__
        raise RuntimeError(f"Gemini API error: {msg[:800]}") from e
    except Exception as e:
        raise RuntimeError(f"Gemini request failed: {e!s}") from e
    return _gemini_text_response(response)


def _retrieve(document_id: str, query: str, k: int = 6) -> list[dict[str, Any]]:
    client = _get_chroma_client()
    name = _collection_name(document_id)
    col = client.get_collection(name=name, embedding_function=_embedding_fn())
    res = col.query(query_texts=[query], n_results=k, include=["documents", "metadatas", "distances"])
    hits: list[dict[str, Any]] = []
    if not res["ids"] or not res["ids"][0]:
        return hits
    metas = (res["metadatas"] or [[]])[0]
    for i, doc_id in enumerate(res["ids"][0]):
        row_meta = metas[i] if i < len(metas) else None
        hits.append(
            {
                "id": doc_id,
                "text": (res["documents"] or [[]])[0][i] or "",
                "page": _page_from_metadata(row_meta if isinstance(row_meta, dict) else None, 1),
                "distance": (res["distances"] or [[]])[0][i] if res.get("distances") else None,
            }
        )
    return hits


def chat_with_citations(document_id: str, user_message: str) -> dict[str, Any]:
    if not _gemini_api_key():
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Add it to your environment or backend/.env to enable chat."
        )

    hits = _retrieve(document_id, user_message, k=8)
    if not hits:
        return {
            "answer": "I could not find relevant passages in this PDF. Try rephrasing or upload a text-based PDF.",
            "citations": [],
        }

    context_blocks = []
    for h in hits:
        context_blocks.append(f"[Page {h['page']}]\n{h['text']}")
    context = "\n\n---\n\n".join(context_blocks)

    system = (
        "You are a helpful assistant that answers ONLY using the provided PDF excerpts. "
        "Each excerpt is labeled with [Page N]. "
        "When you state a fact, cite the page in parentheses like (p. 3) or (pp. 2–4). "
        "If the excerpts do not contain the answer, say you cannot find it in the document. "
        "Be concise and accurate."
    )
    user = f"Question: {user_message}\n\nExcerpts from the document:\n{context}"

    answer = _gemini_generate(
        user,
        system_instruction=system,
        temperature=0.2,
        json_mode=False,
    )
    if not answer:
        answer = "The model did not return a readable answer. Try again or shorten your question."

    seen: set[int] = set()
    citations: list[dict[str, Any]] = []
    for h in hits[:6]:
        p = h["page"]
        if p in seen:
            continue
        seen.add(p)
        snippet = (h["text"] or "")[:240].replace("\n", " ").strip()
        if len((h["text"] or "")) > 240:
            snippet += "…"
        citations.append({"page": p, "snippet": snippet})

    return {"answer": answer, "citations": citations}






def summarize_document(document_id: str) -> dict[str, Any]:
    if not _gemini_api_key():
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Add it to your environment or backend/.env to enable analysis."
        )

    hits = _retrieve(document_id, "summary overview main topics architecture purpose", k=12)
    if not hits:
        return {"summary": ["No extractable text found in this PDF (it may be scanned images)."], "suggested_questions": []}

    context_blocks = []
    for h in hits:
        context_blocks.append(f"[Page {h['page']}]\n{h['text']}")
    context = "\n\n---\n\n".join(context_blocks)

    prompt = (
        "Based only on the following excerpts, produce a JSON object with two keys:\n"
        '1) "summary": an array of 5 to 7 short bullet strings (no numbering inside strings).\n'
        '2) "suggested_questions": an array of exactly 5 concise questions a user might ask about this document.\n'
        "Return ONLY valid JSON, no markdown fences."
    )
    user = f"{prompt}\n\nExcerpts:\n{context}"

    raw = _gemini_generate(
        user,
        system_instruction="You output only strict JSON matching the requested schema.",
        temperature=0.3,
        json_mode=True,
    )
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {
            "summary": [raw[:2000]] if raw else [],
            "suggested_questions": [
                "What is this document about?",
                "What are the main conclusions?",
                "What technologies are mentioned?",
                "What are the key requirements?",
                "Are there any risks or limitations discussed?",
            ],
        }
    summary = data.get("summary") or []
    if isinstance(summary, str):
        summary = [summary]
    questions = data.get("suggested_questions") or []
    if isinstance(questions, str):
        questions = [questions]
    return {
        "summary": [str(s).strip() for s in summary if str(s).strip()][:10],
        "suggested_questions": [str(q).strip() for q in questions if str(q).strip()][:8],
    }


def delete_document_index(document_id: str) -> None:
    client = _get_chroma_client()
    try:
        client.delete_collection(_collection_name(document_id))
    except Exception:
        pass
