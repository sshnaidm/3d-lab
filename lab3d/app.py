#!/usr/bin/env python3
"""
3D Lab service: HTTP API over the topology store, refresh jobs, and the built viewer.

Run:
    3d-lab                       # or: python -m lab3d.app
    VIEWER_API_TOKEN=... 3d-lab --config config.yaml --bind 0.0.0.0 --port 8080

Reads are open on the internal network unless ``viewer.open_reads: false``. Every write (refresh, add,
remove) needs ``Authorization: Bearer $VIEWER_API_TOKEN``; without a configured token, writes are accepted
only from loopback clients that send ``X-Viewer-Request: 1`` (a header browsers cannot add cross-site).
"""

import argparse
import contextlib
import hmac
import ipaddress
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from lab3d.collector import Collector
from lab3d.inventory import Inventory, InventoryError
from lab3d.settings import ViewerSettings, load_settings
from lab3d.store import Store, diff_topologies, parse_iso
from lab3d.wiring import Wiring, link_summary

logger = logging.getLogger("viewer.app")

_FILTERS = ("lab", "rack", "model", "vendor", "tag", "health", "state")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _bearer(request: Request) -> Optional[str]:
    header = request.headers.get("authorization") or ""
    return header[7:].strip() if header.lower().startswith("bearer ") else None


def _is_loopback(request: Request) -> bool:
    host = request.client.host if request.client else ""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _token_ok(settings: ViewerSettings, supplied: Optional[str]) -> bool:
    if not (settings.api_token and supplied):
        return False
    return hmac.compare_digest(settings.api_token.encode(), supplied.encode())


_LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}


def _host_header(request: Request) -> str:
    host = (request.headers.get("host") or "").strip().lower()
    if host.startswith("["):  # [::1]:8080
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


class _LocalHostGuard:
    """Refuse loopback requests whose Host header is not a local name.

    A web page can rebind its own domain to 127.0.0.1 (DNS rebinding) and then call this service as a
    same-origin request, custom headers included. Checking Host closes that hole for the no-token mode and
    for fleet data on a loopback-only service. Remote clients are not affected.
    """

    def __init__(self, app, allowed_hosts: List[str]):
        self.app = app
        self.allowed = _LOCAL_HOSTNAMES | {h.lower() for h in allowed_hosts}

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            request = Request(scope)
            if _is_loopback(request) and _host_header(request) not in self.allowed:
                response = JSONResponse({"error": "Unexpected Host header for a local request"}, status_code=403)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def require_write(request: Request) -> str:
    """Authorize a write; returns who asked (for job records). Bearer header only: cookies would allow CSRF."""
    settings: ViewerSettings = request.app.state.settings
    if settings.api_token:
        if not _token_ok(settings, _bearer(request)):
            raise HTTPException(401, "A valid API token is required (Authorization: Bearer ...)")
        return "token"
    if _is_loopback(request) and request.headers.get("x-viewer-request") == "1":
        return "local"
    raise HTTPException(403, "Writes need VIEWER_API_TOKEN on the server, or a local request with X-Viewer-Request: 1")


def require_read(request: Request) -> None:
    settings: ViewerSettings = request.app.state.settings
    if settings.open_reads:
        return
    if _token_ok(settings, _bearer(request) or request.cookies.get("viewer_token")):
        return
    if not settings.api_token and _is_loopback(request):
        return
    raise HTTPException(401, "A valid API token is required")


class _RateLimiter:
    """Minimum interval between refreshes of the same key."""

    def __init__(self, interval: float):
        self.interval = interval
        self._last: Dict[str, float] = {}

    def retry_after(self, key: str) -> float:
        last = self._last.get(key)
        return max(0.0, self.interval - (time.monotonic() - last)) if last is not None else 0.0

    def hit(self, key: str) -> None:
        self._last[key] = time.monotonic()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _layouts(settings: ViewerSettings) -> List[Dict]:
    try:
        with open(settings.layouts_file) as f:
            return json.load(f).get("layouts") or []
    except (OSError, ValueError):
        return []


def _layout_for(model: Optional[str], layouts: List[Dict]) -> str:
    for layout in layouts:
        if model and re.search(layout["match"], model, re.IGNORECASE):
            return layout["id"]
    return "generic"


def _state(row: Dict, now: datetime, max_age: float) -> str:
    if not row.get("captured_at"):
        return "error" if row.get("last_error") else "pending"
    if row.get("last_error"):
        return "error"
    captured = parse_iso(row["captured_at"])
    return "stale" if captured and (now - captured).total_seconds() > max_age else "ok"


def _rows(request: Request) -> List[Dict]:
    """Inventory joined with the store index (hosts in the store but no longer configured are kept)."""
    app = request.app
    index = app.state.store.index()
    hosts = app.state.inventory.hosts()
    layouts = _layouts(app.state.settings)
    now = datetime.now(timezone.utc)
    rows = []
    for host_id in sorted(set(hosts) | set(index)):
        meta = hosts.get(host_id) or {"id": host_id, "tags": [], "source": "store"}
        row = {**meta, **(index.get(host_id) or {})}
        row.pop("vendor_hint", None)
        row.setdefault("vendor", meta.get("vendor_hint"))
        row["configured"] = host_id in hosts
        row["state"] = _state(row, now, app.state.settings.max_age)
        row["layout"] = _layout_for(row["model"], layouts) if row.get("model") else None
        row["busy"] = app.state.collector.is_busy(host_id)
        if row.get("captured_at"):
            row.update(_link_counts(app, host_id, row["captured_at"]))
        rows.append(row)
    return rows


def _link_counts(app, host_id: str, captured_at: str) -> Dict[str, int]:
    """Wiring-derived port counts for the fleet table, cached until the topology or the wiring files change."""
    wiring: Wiring = app.state.wiring
    version = wiring.version()
    if version is None:
        return {}
    cache = app.state.link_cache
    key = (captured_at, version)
    hit = cache.get(host_id)
    if hit and hit[0] == key:
        return hit[1]
    topo = app.state.store.get(host_id)
    counts = link_summary(wiring.apply(topo)) if topo else {}
    cache[host_id] = (key, counts)
    return counts


def _matches(row: Dict, filters: Dict[str, str]) -> bool:
    for key, wanted in filters.items():
        wanted_l = wanted.lower()
        if key == "tag":
            if wanted_l not in [t.lower() for t in row.get("tags") or []]:
                return False
        elif key == "model":
            if wanted_l not in (row.get("model") or "").lower():
                return False
        elif key == "ids":
            if row["id"] not in wanted.split(","):
                return False
        elif (row.get(key) or "").lower() != wanted_l:
            return False
    return True


def _filters(params: Dict[str, Any]) -> Dict[str, str]:
    out = {}
    for k in (*_FILTERS, "ids"):
        value = params.get(k)
        if value:
            out[k] = ",".join(map(str, value)) if isinstance(value, list) else str(value)
    return out


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _summary(rows: List[Dict]) -> Dict:
    def count(pred) -> int:
        return sum(1 for r in rows if pred(r))

    return {
        "hosts": len(rows),
        "collected": count(lambda r: r.get("captured_at")),
        "pending": count(lambda r: r["state"] == "pending"),
        "stale": count(lambda r: r["state"] == "stale"),
        "errors": count(lambda r: r["state"] == "error"),
        "warnings": count(lambda r: r.get("health") in ("Warning", "Critical")),
        "generic_layout": count(lambda r: r.get("captured_at") and r["layout"] == "generic"),
    }


def _host_or_404(request: Request, host_id: str) -> None:
    app = request.app
    if host_id not in app.state.inventory and app.state.store.get(host_id) is None:
        raise HTTPException(404, f"Unknown server '{host_id}'")


def _store_call(fn, *args):
    try:
        return fn(*args)
    except ValueError as e:
        raise HTTPException(400, str(e))


async def _json_body(request: Request) -> Dict:
    if not (await request.body()):
        return {}
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Body must be JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "Body must be a JSON object")
    return body


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


async def health(request: Request) -> JSONResponse:
    collector: Collector = request.app.state.collector
    return JSONResponse(
        {
            "status": "ok",
            "hosts": len(request.app.state.inventory.hosts()),
            "active_jobs": len(collector.active_jobs()),
            "writes": "token" if request.app.state.settings.api_token else "local-only",
            "adhoc": bool(request.app.state.settings.allowed_bmc_cidrs),
            "wiring": request.app.state.wiring.version() is not None,
        }
    )


async def list_servers(request: Request) -> JSONResponse:
    require_read(request)
    rows = _rows(request)
    filters = _filters(dict(request.query_params))
    selected = [r for r in rows if _matches(r, filters)]
    facets: Dict[str, Dict[str, int]] = {}
    for key in ("lab", "rack", "model", "vendor", "state", "layout"):
        for r in rows:
            if r.get(key):
                facets.setdefault(key, {}).setdefault(r[key], 0)
                facets[key][r[key]] += 1
    return JSONResponse({"servers": selected, "summary": _summary(selected), "facets": facets})


async def get_server(request: Request) -> JSONResponse:
    require_read(request)
    host_id = request.path_params["host_id"]
    raw = _truthy(request.query_params.get("raw"))
    topo = _store_call(request.app.state.store.get, host_id, raw)
    if topo is None:
        _host_or_404(request, host_id)
        raise HTTPException(404, f"'{host_id}' has not been collected yet; POST /api/servers/{host_id}/refresh")
    return JSONResponse(request.app.state.wiring.apply(topo))


async def get_raw(request: Request) -> JSONResponse:
    require_read(request)
    host_id = request.path_params["host_id"]
    raw = _store_call(request.app.state.store.get_raw, host_id)
    if raw is None:
        raise HTTPException(404, f"No data for '{host_id}'")
    component = request.query_params.get("component")
    if component:
        if component not in raw:
            raise HTTPException(404, f"No component '{component}'")
        return JSONResponse(raw[component] or {})
    return JSONResponse(raw)


async def get_history(request: Request) -> JSONResponse:
    require_read(request)
    host_id = request.path_params["host_id"]
    _host_or_404(request, host_id)
    return JSONResponse({"server_id": host_id, "history": _store_call(request.app.state.store.history, host_id)})


async def get_history_snapshot(request: Request) -> JSONResponse:
    require_read(request)
    host_id, ts = request.path_params["host_id"], request.path_params["ts"]
    snap = _store_call(request.app.state.store.history_snapshot, host_id, ts)
    if snap is None:
        raise HTTPException(404, "No such snapshot")
    return JSONResponse(snap)


async def get_history_diff(request: Request) -> JSONResponse:
    """Diff snapshot ``ts`` against ``?against=<ts>`` (default: the current topology)."""
    require_read(request)
    store: Store = request.app.state.store
    host_id, ts = request.path_params["host_id"], request.path_params["ts"]
    old = _store_call(store.history_snapshot, host_id, ts)
    against = request.query_params.get("against")
    new = _store_call(store.history_snapshot, host_id, against) if against else store.get(host_id)
    if old is None or new is None:
        raise HTTPException(404, "No such snapshot")
    return JSONResponse(diff_topologies(old, new))


async def refresh_server(request: Request) -> JSONResponse:
    who = require_write(request)
    host_id = request.path_params["host_id"]
    if host_id not in request.app.state.inventory:
        raise HTTPException(404, f"Unknown server '{host_id}'")
    collector: Collector = request.app.state.collector
    limiter: _RateLimiter = request.app.state.limiter
    if not collector.is_busy(host_id):
        wait = limiter.retry_after(host_id)
        if wait > 0:
            return JSONResponse(
                {"error": f"'{host_id}' was refreshed recently", "retry_after": round(wait)},
                status_code=429,
                headers={"Retry-After": str(int(wait) + 1)},
            )
        limiter.hit(host_id)
    force = _truthy(request.query_params.get("force"))
    job = collector.submit([host_id], kind="refresh", requested_by=who, force=force)
    return JSONResponse(job.to_dict(), status_code=202)


async def bulk_refresh(request: Request) -> JSONResponse:
    """Refresh every host matching the filters (query or JSON body).

    ``stale_only`` skips fresh hosts; hosts refreshed within ``refresh_min_interval`` are skipped too.
    """
    who = require_write(request)
    params = {**dict(request.query_params), **(await _json_body(request))}
    filters = _filters(params)
    collector: Collector = request.app.state.collector
    if collector.active_jobs("bulk"):
        raise HTTPException(409, "A bulk refresh is already running")
    limiter: _RateLimiter = request.app.state.limiter
    rows = [r for r in _rows(request) if r["configured"] and _matches(r, filters)]
    if not rows:
        return JSONResponse({"error": "No hosts match", "filters": filters}, status_code=404)
    hosts = [r["id"] for r in rows if collector.is_busy(r["id"]) or limiter.retry_after(r["id"]) == 0]
    if _truthy(params.get("stale_only")):
        stale = set(collector.stale_hosts(hosts))
        hosts = [h for h in hosts if h in stale]
    if not hosts:
        return JSONResponse(
            {"error": f"All {len(rows)} matching hosts are fresh or were refreshed recently", "filters": filters},
            status_code=409,
        )
    for h in hosts:
        limiter.hit(h)
    job = collector.submit(hosts, kind="bulk", requested_by=who, force=_truthy(params.get("force")))
    return JSONResponse(job.to_dict(details=False), status_code=202)


async def list_jobs(request: Request) -> JSONResponse:
    require_read(request)
    jobs = list(request.app.state.collector.jobs.values())[-50:]
    return JSONResponse({"jobs": [j.to_dict(details=False) for j in reversed(jobs)]})


async def get_job(request: Request) -> JSONResponse:
    require_read(request)
    job = request.app.state.collector.jobs.get(request.path_params["job_id"])
    if job is None:
        raise HTTPException(404, "No such job")
    return JSONResponse(job.to_dict())


async def add_server(request: Request) -> JSONResponse:
    """Ad-hoc server: ``{name, bmc_ip, username, password, vendor?, lab?, rack?, tags?, remember?}``."""
    who = require_write(request)
    body = await _json_body(request)
    inventory: Inventory = request.app.state.inventory
    tags = body.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    try:
        meta = inventory.add(
            name=str(body.get("name") or ""),
            bmc_ip=str(body.get("bmc_ip") or ""),
            username=str(body.get("username") or ""),
            password=str(body.get("password") or ""),
            vendor=body.get("vendor") or None,
            lab=body.get("lab") or None,
            rack=body.get("rack") or None,
            tags=tags,
            remember=_truthy(body.get("remember")),
        )
    except InventoryError as e:
        raise HTTPException(e.status, str(e)) from None
    request.app.state.limiter.hit(meta["id"])
    job = request.app.state.collector.submit([meta["id"]], kind="add", requested_by=who)
    return JSONResponse({"server": meta, "job": job.to_dict()}, status_code=202)


async def remove_server(request: Request) -> Response:
    require_write(request)
    host_id = request.path_params["host_id"]
    if request.app.state.collector.is_busy(host_id):
        raise HTTPException(409, f"'{host_id}' is being collected; try again when the job finishes")
    try:
        request.app.state.inventory.remove(host_id)
    except InventoryError as e:
        raise HTTPException(e.status, str(e)) from None
    if not _truthy(request.query_params.get("keep_data")):
        await request.app.state.store.delete(host_id)
    return Response(status_code=204)


async def coverage(request: Request) -> JSONResponse:
    """Which chassis models exist, how many hosts each, and whether the viewer has a dedicated layout."""
    require_read(request)
    models: Dict[str, Dict] = {}
    for row in _rows(request):
        if not row.get("model"):
            continue
        entry = models.setdefault(
            row["model"], {"model": row["model"], "vendor": row.get("vendor"), "layout": row["layout"], "hosts": []}
        )
        entry["hosts"].append(row["id"])
    out = sorted(models.values(), key=lambda m: (m["layout"] != "generic", -len(m["hosts"]), m["model"]))
    for m in out:
        m["count"] = len(m["hosts"])
    return JSONResponse({"models": out, "layouts": _layouts(request.app.state.settings)})


def _norm_mac(text: str) -> str:
    return re.sub(r"[^0-9a-f]", "", text.lower())


def _compact(text: str) -> str:
    return re.sub(r"[^0-9a-z]", "", text.lower())


def _text_matcher(q: str):
    """Substring match that also ignores punctuation and spaces, so `ConnectX-6` finds "ConnectX6"."""
    loose = _compact(q)
    if len(loose) < 2:
        return lambda value: q in value.lower()
    return lambda value: q in value.lower() or loose in _compact(value)


async def search(request: Request) -> JSONResponse:
    """Case-insensitive substring search over host ids, models, serials, MACs, part names and switch ports.

    Text fields also match with punctuation and spaces ignored. Switch ports and MACs keep their own rules, so
    `ethernet1/1/1` doesn't find `ethernet1/11`.
    """
    require_read(request)
    q = (request.query_params.get("q") or "").strip().lower()
    if len(q) < 2:
        raise HTTPException(400, "q must be at least 2 characters")
    q_mac = _norm_mac(q) if re.fullmatch(r"[0-9a-f:.-]{4,}", q) and re.search(r"[:.-]", q) else None
    try:
        limit = max(1, min(int(request.query_params.get("limit") or 200), 1000))
    except ValueError:
        raise HTTPException(400, "limit must be an integer") from None
    matches = _text_matcher(q)
    store: Store = request.app.state.store
    results = []
    total = 0
    for row in _rows(request):
        hits = []
        for field in ("id", "model", "serial", "lab", "rack", "cpu_model", "description"):
            value = row.get(field)
            if isinstance(value, str) and matches(value):
                hits.append({"field": field, "value": value})
        if any(matches(t) for t in row.get("tags") or []):
            hits.append({"field": "tags", "value": ", ".join(row["tags"])})
        topo = request.app.state.wiring.apply(store.get(row["id"]) or {}) if row.get("captured_at") else None
        for c in (topo or {}).get("components") or []:
            summary = c.get("summary") or {}
            values = {
                "name": c.get("name"),
                "slot": c.get("slot_label"),
                "serial": c.get("serial"),
                "model": summary.get("model"),
                "part_number": summary.get("part_number"),
                "manufacturer": summary.get("manufacturer"),
                "health": c.get("health") if c.get("health") not in (None, "OK") else None,
            }
            for field, value in values.items():
                if isinstance(value, str) and matches(value):
                    hits.append({"field": field, "value": value, "component": c["id"], "slot_key": c.get("slot_key")})
            for port in summary.get("ports") or []:
                mac = port.get("mac") or ""
                if mac and (q in mac.lower() or (q_mac and q_mac in _norm_mac(mac))):
                    hits.append({"field": "mac", "value": mac, "component": c["id"], "port": port.get("id")})
                peer = port.get("peer") or {}
                switch_port = f"{peer.get('switch')} {peer.get('port')}" if peer else ""
                if peer and (q in switch_port.lower() or q == str(peer.get("vlan") or "").lower()):
                    hits.append(
                        {
                            "field": "switch",
                            "value": switch_port,
                            "component": c["id"],
                            "slot_key": c.get("slot_key"),
                            "port": port.get("id"),
                        }
                    )
        if hits:
            total += len(hits)
            results.append({"id": row["id"], "model": row.get("model"), "lab": row.get("lab"), "matches": hits[:50]})
            if len(results) >= limit:
                break
    return JSONResponse({"q": q, "hosts": len(results), "matches": total, "results": results})


# Compatibility routes for the current static viewer: same files it reads from public/topology.


async def compat_index(request: Request) -> JSONResponse:
    require_read(request)
    rows = [r for r in _rows(request) if r.get("captured_at")]
    return JSONResponse({"servers": [{"id": r["id"], "model": r.get("model")} for r in rows]})


async def compat_topology(request: Request) -> JSONResponse:
    require_read(request)
    name = request.path_params["name"]
    if not name.endswith(".json"):
        raise HTTPException(404)
    topo = _store_call(request.app.state.store.get, name[:-5], True)
    if topo is None:
        raise HTTPException(404, "Not collected")
    return JSONResponse(topo)


async def wiring_status(request: Request) -> JSONResponse:
    """Configured wiring files and how many links they describe (file names only, never their contents)."""
    require_read(request)
    return JSONResponse(request.app.state.wiring.summary())


async def _http_error(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------


def create_app(settings: Optional[ViewerSettings] = None) -> Starlette:
    settings = settings or load_settings()
    store = Store(settings.data_dir)
    inventory = Inventory(settings)
    collector = Collector(store, inventory, settings)

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette):
        yield
        await collector.stop()

    routes = [
        Route("/api/health", health),
        Route("/api/servers", list_servers, methods=["GET"]),
        Route("/api/servers", add_server, methods=["POST"]),
        Route("/api/servers/{host_id}", get_server, methods=["GET"]),
        Route("/api/servers/{host_id}", remove_server, methods=["DELETE"]),
        Route("/api/servers/{host_id}/raw", get_raw),
        Route("/api/servers/{host_id}/history", get_history),
        Route("/api/servers/{host_id}/history/{ts}", get_history_snapshot),
        Route("/api/servers/{host_id}/history/{ts}/diff", get_history_diff),
        Route("/api/servers/{host_id}/refresh", refresh_server, methods=["POST"]),
        Route("/api/refresh", bulk_refresh, methods=["POST"]),
        Route("/api/jobs", list_jobs),
        Route("/api/jobs/{job_id}", get_job),
        Route("/api/coverage", coverage),
        Route("/api/search", search),
        Route("/api/wiring", wiring_status),
        Route("/topology/index.json", compat_index),
        Route("/topology/{name}", compat_topology),
    ]
    if os.path.isdir(settings.static_dir):
        routes.append(Mount("/", StaticFiles(directory=settings.static_dir, html=True), name="viewer"))
    else:
        logger.warning(
            "Viewer build not found at %s (run `npm run build` in web/); serving API only", settings.static_dir
        )

    app = Starlette(routes=routes, lifespan=lifespan, exception_handlers={HTTPException: _http_error})
    app.add_middleware(_LocalHostGuard, allowed_hosts=settings.allowed_hosts)
    app.state.settings = settings
    app.state.store = store
    app.state.inventory = inventory
    app.state.collector = collector
    app.state.wiring = Wiring(settings.wiring_files)
    app.state.link_cache = {}
    app.state.limiter = _RateLimiter(settings.refresh_min_interval)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="3D Lab: fleet 3D hardware viewer service")
    parser.add_argument("--config", help="Settings file (default $LAB3D_CONFIG or ./config.yaml)")
    parser.add_argument("--bind", help="Address to listen on (default from the config, 127.0.0.1)")
    parser.add_argument("--port", type=int, help="Port (default from the config, 8080)")
    parser.add_argument("--data-dir", help="Store directory (default from the config, ./data)")
    args = parser.parse_args()

    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = load_settings({"bind": args.bind, "port": args.port, "data_dir": args.data_dir}, args.config)
    if not settings.api_token and settings.bind not in ("127.0.0.1", "::1", "localhost"):
        logger.warning(
            "VIEWER_API_TOKEN is not set: refresh and add-server are limited to loopback clients. "
            "Behind a reverse proxy on this host, set a token: proxied requests can look local."
        )
    uvicorn.run(create_app(settings), host=settings.bind, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
