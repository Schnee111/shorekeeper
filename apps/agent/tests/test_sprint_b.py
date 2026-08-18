"""Unit tests Sprint B: session resumption (get/save handle).

Tidak ada network call — hanya SQLite test di tmp path.
"""


import pytest

from agent_gemini_live import get_session_handle, save_session_handle


@pytest.mark.asyncio
async def test_save_and_get_session_handle(tmp_path):
    """Test round-trip: save → retrieve handle from SQLite."""
    db_path = str(tmp_path / "test_resumption.db")
    with pytest.MonkeyPatch.context() as mp:
        import agent_gemini_live as agl
        mp.setattr(agl, "DB_PATH", db_path)
        agl.init_db()  # Create tables

    # Save handle
    result = save_session_handle("room-alpha", "handle-abc123")
    assert result is True

    # Retrieve handle
    retrieved = get_session_handle("room-alpha")
    assert retrieved == "handle-abc123"

    # Non-existent room returns None
    missing = get_session_handle("room-zeta")
    assert missing is None


@pytest.mark.asyncio
async def test_save_handle_overwrites_previous(tmp_path):
    """Test that saving updates existing handle + timestamp."""
    db_path = str(tmp_path / "test_override.db")
    with pytest.MonkeyPatch.context() as mp:
        import agent_gemini_live as agl
        mp.setattr(agl, "DB_PATH", db_path)
        agl.init_db()

    # Initial save
    save_session_handle("room-beta", "handle-old")
    old = get_session_handle("room-beta")
    assert old == "handle-old"

    # Overwrite with new handle
    save_session_handle("room-beta", "handle-new")
    new = get_session_handle("room-beta")
    assert new == "handle-new"
