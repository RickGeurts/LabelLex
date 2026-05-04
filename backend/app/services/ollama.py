"""Thin synchronous client for a local Ollama daemon.

Why sync, not async: the rest of the FastAPI app is sync. Going async here
would just complicate things; Ollama calls are slow (seconds), so we
trade them off against request latency one at a time. If we move to a
queue-backed pre-labelling pipeline we'll switch to async.

Structured output: Ollama 0.5+ accepts a JSON schema in the `format` field
and returns a JSON-parseable string in `response`. We parse it here so
callers get a dict back.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from ..config import settings


class OllamaError(RuntimeError):
    """Raised when Ollama is unreachable or returns an error."""


class OllamaClient:
    def __init__(
        self,
        base_url: str | None = None,
        default_model: str | None = None,
        timeout: float | None = None,
    ) -> None:
        self.base_url = (base_url or settings.ollama_base_url).rstrip("/")
        self.default_model = default_model or settings.ollama_model
        self.timeout = timeout if timeout is not None else settings.ollama_timeout_seconds

    # --- Health / availability --------------------------------------------

    def status(self) -> dict[str, Any]:
        """Return reachability + the list of locally pulled models.

        Doesn't raise on connection failure — surfaces it as
        `{"reachable": False, "error": "..."}` so the UI can show it.
        """
        try:
            resp = httpx.get(f"{self.base_url}/api/tags", timeout=5.0)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            return {
                "reachable": False,
                "error": str(exc),
                "base_url": self.base_url,
                "configured_model": self.default_model,
                "configured_model_available": False,
                "models": [],
            }
        models = [m.get("name") for m in data.get("models", [])]
        return {
            "reachable": True,
            "error": None,
            "base_url": self.base_url,
            "configured_model": self.default_model,
            "configured_model_available": self.default_model in models,
            "models": models,
        }

    # --- Generation -------------------------------------------------------

    def generate_structured(
        self,
        prompt: str,
        schema: dict[str, Any],
        *,
        model: str | None = None,
        system: str | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Generate text and parse it as JSON conforming to `schema`."""
        body: dict[str, Any] = {
            "model": model or self.default_model,
            "prompt": prompt,
            "format": schema,
            "stream": False,
        }
        if system is not None:
            body["system"] = system
        if options is not None:
            body["options"] = options
        try:
            resp = httpx.post(
                f"{self.base_url}/api/generate",
                json=body,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            raise OllamaError(f"Ollama request failed: {exc}") from exc
        raw = data.get("response", "")
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise OllamaError(
                f"Ollama returned non-JSON response: {raw[:200]!r}"
            ) from exc


_client: OllamaClient | None = None


def get_ollama_client() -> OllamaClient:
    global _client
    if _client is None:
        _client = OllamaClient()
    return _client
