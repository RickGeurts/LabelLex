"""Runtime config. v0 spike — no env file needed yet, sensible defaults."""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LABELLEX_", extra="ignore")

    db_url: str = f"sqlite:///{REPO_ROOT / 'backend' / 'labellex.db'}"
    storage_dir: Path = REPO_ROOT / "storage"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # v0 single-user — no auth yet. Seed creates this user on startup.
    default_user_id: int = 1
    default_project_id: int = 1

    # Ollama configuration. Override via env: LABELLEX_OLLAMA_BASE_URL,
    # LABELLEX_OLLAMA_MODEL. Default model targets RTX 5070 Ti / 16 GB VRAM.
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5:14b-instruct"
    ollama_timeout_seconds: float = 180.0


settings = Settings()
settings.storage_dir.mkdir(parents=True, exist_ok=True)
(settings.storage_dir / "uploads").mkdir(parents=True, exist_ok=True)