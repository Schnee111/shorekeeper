"""Unit tests Sprint A: build_session_context + memory_search.

Mock MemPalace HTTP (sukses + gagal → graceful) dan timeout → narasi error.
Tidak ada network call nyata.
"""

import asyncio
from unittest.mock import patch

import pytest

import agent_gemini_live as agl

# ---------------------------------------------------------------------------
# memory_search / search_mempalace
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status, payload=None):
        self.status = status
        self._payload = payload or {}

    async def json(self):
        return self._payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class FakeSession:
    def __init__(self, response):
        self._response = response

    def get(self, url, **kwargs):
        return self._response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class RaisingSession:
    """ClientSession yang raise saat dipakai (simulasi down/timeout)."""

    def __init__(self, exc):
        self._exc = exc

    def get(self, url, **kwargs):
        raise self._exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


@pytest.mark.asyncio
async def test_memory_search_success(monkeypatch):
    monkeypatch.setenv("MEMPALACE_MCP_HTTP_ENDPOINT", "http://fake:9999")
    monkeypatch.setenv("MEMPALACE_MCP_HTTP_TOKEN", "tok")
    payload = {"results": [{"title": "ADR-002", "content": "transport decision", "wing": "decisions"}]}
    resp = FakeResponse(200, payload)
    with patch.object(agl.aiohttp, "ClientSession", return_value=FakeSession(resp)):
        out = await agl.search_mempalace("keputusan transport")
    assert "ADR-002" in out
    assert "decisions" in out


@pytest.mark.asyncio
async def test_memory_search_timeout_returns_narrative(monkeypatch):
    monkeypatch.setenv("MEMPALACE_MCP_HTTP_ENDPOINT", "http://fake:9999")
    monkeypatch.setenv("MEMPALACE_MCP_HTTP_TOKEN", "tok")
    with patch.object(agl.aiohttp, "ClientSession", return_value=RaisingSession(asyncio.TimeoutError())):
        out = await agl.search_mempalace("apapun")
    # Narasi natural, bukan error mentah
    assert "kesulitan" in out
    assert "Traceback" not in out


@pytest.mark.asyncio
async def test_memory_search_no_config_returns_narrative(monkeypatch):
    monkeypatch.delenv("MEMPALACE_MCP_HTTP_ENDPOINT", raising=False)
    monkeypatch.delenv("MEMPALACE_MCP_HTTP_TOKEN", raising=False)
    out = await agl.search_mempalace("test")
    assert "kesulitan" in out


# ---------------------------------------------------------------------------
# build_session_context
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_build_session_context_mempalace_success(monkeypatch, tmp_path):
    # Point DB at a temp empty db so task query returns no rows but doesn't error.
    monkeypatch.setattr(agl, "DB_PATH", str(tmp_path / "tasks.db"))
    monkeypatch.setenv("MEMPALACE_MCP_HTTP_ENDPOINT", "http://fake:9999")
    monkeypatch.setenv("MEMPALACE_MCP_HTTP_TOKEN", "tok")
    payload = {"results": [{"content": "Schnee suka ringkas"}]}
    resp = FakeResponse(200, payload)
    with patch.object(agl.aiohttp, "ClientSession", return_value=FakeSession(resp)):
        out = await agl.build_session_context("room-1")
    assert "[KONTEKS SAAT INI]" in out


@pytest.mark.asyncio
async def test_build_session_context_mempalace_fail_graceful(monkeypatch, tmp_path):
    """Jika MemPalace gagal → tidak crash, tetap lanjut (task context / empty)."""
    monkeypatch.setattr(agl, "DB_PATH", str(tmp_path / "tasks.db"))
    monkeypatch.setenv("MEMPALACE_MCP_HTTP_ENDPOINT", "http://fake:9999")
    monkeypatch.setenv("MEMPALACE_MCP_HTTP_TOKEN", "tok")
    with patch.object(agl.aiohttp, "ClientSession", return_value=RaisingSession(ConnectionError("down"))):
        out = await agl.build_session_context("room-1")
    # Tidak boleh raise; boleh kosong atau berisi task context saja
    assert isinstance(out, str)


@pytest.mark.asyncio
async def test_build_session_context_with_tasks(monkeypatch, tmp_path):
    """Task terakhir dari SQLite masuk ke konteks."""
    db_path = str(tmp_path / "tasks.db")
    monkeypatch.setattr(agl, "DB_PATH", db_path)
    monkeypatch.delenv("MEMPALACE_MCP_HTTP_ENDPOINT", raising=False)
    monkeypatch.delenv("MEMPALACE_MCP_HTTP_TOKEN", raising=False)
    agl.init_db()
    import sqlite3

    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO tasks (task_id, session_room, user_intent, lane, status, created_at) "
            "VALUES ('task_a', 'room-1', 'perbaiki bug login', 'debug', 'done', 1000)"
        )
    out = await agl.build_session_context("room-1")
    assert "task_a" in out
    assert "[KONTEKS SAAT INI]" in out
