import pytest


@pytest.fixture(autouse=True)
def isolated_user_data(monkeypatch, tmp_path):
    """Keep every test away from the real user's settings and Verify data."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "cfg"))
    monkeypatch.setenv("APPDATA", str(tmp_path / "cfg"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
