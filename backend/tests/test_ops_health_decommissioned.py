"""Κόμβος που ΔΙΑΓΡΑΦΗΚΕ δεν είναι «πεσμένος» — αλλά μόνο αν το Hetzner το επιβεβαιώνει ρητά.
(SRV04: διαγράφηκε 24/10/2026 και έστελνε «πιθανό down» ανά 3 ώρες για 19 ημέρες.)"""
import pytest

pytestmark = pytest.mark.asyncio


class _Resp:
    def __init__(self, code, body):
        self.status_code, self._b = code, body

    def json(self):
        return self._b


def _fake_httpx(monkeypatch, resp=None, exc=None):
    import httpx

    class _Cl:
        def __init__(self, *a, **k): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, *a, **k):
            if exc:
                raise exc
            return resp
    monkeypatch.setattr(httpx, "AsyncClient", _Cl)


async def _tok(db):
    return "t"


async def test_confirmed_missing_server_is_decommissioned(monkeypatch):
    from app.workers import capacity, ops_health
    monkeypatch.setattr(capacity, "_token", _tok)
    _fake_httpx(monkeypatch, _Resp(200, {"servers": []}))
    assert await ops_health._decommissioned(None, "RxVisionSRV04") is True


async def test_existing_server_still_alerts(monkeypatch):
    from app.workers import capacity, ops_health
    monkeypatch.setattr(capacity, "_token", _tok)
    _fake_httpx(monkeypatch, _Resp(200, {"servers": [{"id": 1}]}))
    assert await ops_health._decommissioned(None, "RxVisionSRV01") is False


@pytest.mark.parametrize("resp,exc", [(_Resp(500, {}), None), (None, RuntimeError("net"))])
async def test_unknown_answer_means_alert(monkeypatch, resp, exc):
    from app.workers import capacity, ops_health
    monkeypatch.setattr(capacity, "_token", _tok)
    _fake_httpx(monkeypatch, resp, exc)
    assert await ops_health._decommissioned(None, "RxVisionSRV04") is False


async def test_no_token_means_alert(monkeypatch):
    from app.workers import capacity, ops_health

    async def _none(db):
        return None
    monkeypatch.setattr(capacity, "_token", _none)
    assert await ops_health._decommissioned(None, "RxVisionSRV04") is False
