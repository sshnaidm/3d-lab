#!/usr/bin/env python3
"""
JSON file store for fleet topologies.

Layout under ``data_dir``::

    index.json                       one row per collected host (counts, health, fingerprints, last error)
    hosts/<id>.json                  latest topology, without per-component ``raw`` (small, served to the viewer)
    hosts/<id>.raw.json              ``{component_id: raw}`` loaded lazily
    history/<id>/<timestamp>.json    snapshot written only when the hardware or firmware fingerprint changes

Volatile readings (fan RPM, PSU watts, link state, health) are refreshed on every collection but never
create history, so the history directory is a log of real hardware and firmware changes.
"""

import asyncio
import contextlib
import copy
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from lab3d.topology import component_counts

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX
    fcntl = None

# ``<id>.raw`` would collide with the raw sidecar file.
HOST_ID_RE = re.compile(r"^(?!.*\.raw$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_TS_RE = re.compile(r"^\d{8}T\d{6}Z$")

# Summary fields that change without a hardware change; excluded from the hardware fingerprint.
_VOLATILE = {"rpm", "input_watts", "output_watts", "line_input_voltage", "firmware", "ports"}
_HEALTH_RANK = {"OK": 0, "Warning": 1, "Critical": 2}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _ts_name(iso: str) -> str:
    dt = parse_iso(iso) or datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _digest(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:16]


def _serial(component: Dict) -> Optional[str]:
    raw = component.get("raw") or {}
    serial = raw.get("SerialNumber")
    return serial.strip() if isinstance(serial, str) and serial.strip() else None


def hardware_view(component: Dict) -> Dict:
    """The identity of a component: what it is and where, without readings or firmware."""
    summary = {k: v for k, v in (component.get("summary") or {}).items() if k not in _VOLATILE}
    ports = (component.get("summary") or {}).get("ports") or []
    view = {
        "kind": component.get("kind"),
        "slot_key": component.get("slot_key"),
        "present": component.get("present"),
        "name": component.get("name"),
        "summary": summary,
    }
    if ports:
        view["ports"] = [{"id": p.get("id"), "mac": p.get("mac")} for p in ports]
    serial = component.get("serial") or _serial(component)
    if serial:
        view["serial"] = serial
    return view


def firmware_view(topology: Dict) -> Dict:
    system = topology.get("system") or {}
    components = topology.get("components") or []
    versions = {c["id"]: c["summary"]["firmware"] for c in components if c["summary"].get("firmware")}
    return {"bios": system.get("bios"), "bmc": system.get("bmc"), "components": versions}


def fingerprints(topology: Dict) -> Tuple[str, str]:
    """(hardware fingerprint, firmware fingerprint)."""
    hardware = {
        "model": (topology.get("system") or {}).get("model"),
        "serial": (topology.get("system") or {}).get("serial"),
        "components": {c["id"]: hardware_view(c) for c in topology.get("components") or []},
    }
    return _digest(hardware), _digest(firmware_view(topology))


def _worst(values: List[Optional[str]]) -> Optional[str]:
    known = [v for v in values if v in _HEALTH_RANK]
    return max(known, key=_HEALTH_RANK.get) if known else None


def _is_up(status: Optional[str]) -> bool:
    return bool(re.match(r"^(link)?up$", status or "", re.IGNORECASE))


def summarize(topology: Dict) -> Dict:
    """Index row fields derived from a topology."""
    comps = topology.get("components") or []
    ports = [p for c in comps for p in ((c.get("summary") or {}).get("ports") or [])]
    hw, fw = fingerprints(topology)
    unhealthy = [c for c in comps if c.get("present") and c.get("health") in ("Warning", "Critical")]
    system = topology.get("system") or {}
    memory_gib = sum((c["summary"].get("capacity_gib") or 0) for c in comps if c["kind"] == "dimm" and c["present"])
    return {
        "vendor": system.get("vendor"),
        "model": system.get("model"),
        "serial": system.get("serial"),
        "u_height": (topology.get("chassis") or {}).get("u_height"),
        "health": _worst([system.get("health")] + [c.get("health") for c in unhealthy]) or system.get("health"),
        "power_state": system.get("power_state"),
        "bios": system.get("bios"),
        "bmc": system.get("bmc"),
        "captured_at": topology.get("captured_at"),
        "fingerprint": hw,
        "firmware_fingerprint": fw,
        "counts": component_counts(topology),
        "memory_gib": memory_gib,
        "cpu_model": next((c["summary"].get("model") for c in comps if c["kind"] == "cpu" and c["present"]), None),
        "ports_up": sum(1 for p in ports if _is_up(p.get("link_status"))),
        "ports_total": len(ports),
        "warnings": [{"id": c["id"], "name": c["name"], "health": c["health"]} for c in unhealthy],
    }


# Kinds whose sudden disappearance means the BMC answered only partly (a sub-collection failed), not that
# every part of that kind was physically removed.
_GUARDED_KINDS = ("cpu", "dimm", "psu", "fan", "drive", "pcie", "ocp", "lom")


def missing_kinds(previous: Optional[Dict], topology: Dict) -> List[str]:
    """Kinds that had present parts in the previous collection but none now."""
    before = (previous or {}).get("counts") or {}
    now = component_counts(topology)
    return [k for k in _GUARDED_KINDS if (before.get(k) or {}).get("present") and not (now.get(k) or {}).get("present")]


def split_raw(topology: Dict) -> Tuple[Dict, Dict[str, Any]]:
    """Return (topology without component raw, {component_id: raw}). Component serials stay for search/diff."""
    lean = copy.deepcopy(topology)
    raw: Dict[str, Any] = {}
    for c in lean.get("components") or []:
        serial = _serial(c)
        if serial:
            c["serial"] = serial
        raw[c["id"]] = c.pop("raw", None)
    return lean, raw


def merge_raw(topology: Dict, raw: Dict[str, Any]) -> Dict:
    full = copy.deepcopy(topology)
    for c in full.get("components") or []:
        c["raw"] = raw.get(c["id"]) or {}
    return full


def diff_topologies(old: Dict, new: Dict) -> Dict:
    """Component-level hardware and firmware diff keyed by component id."""
    old_c = {c["id"]: c for c in old.get("components") or []}
    new_c = {c["id"]: c for c in new.get("components") or []}
    changed = []
    for cid in sorted(old_c.keys() & new_c.keys()):
        a, b = hardware_view(old_c[cid]), hardware_view(new_c[cid])
        fields = {}
        for key in ("present", "name", "serial"):
            if a.get(key) != b.get(key):
                fields[key] = {"old": a.get(key), "new": b.get(key)}
        for key in sorted(set(a["summary"]) | set(b["summary"])):
            if a["summary"].get(key) != b["summary"].get(key):
                fields[key] = {"old": a["summary"].get(key), "new": b["summary"].get(key)}
        fw_a, fw_b = old_c[cid]["summary"].get("firmware"), new_c[cid]["summary"].get("firmware")
        if fw_a != fw_b:
            fields["firmware"] = {"old": fw_a, "new": fw_b}
        if fields:
            changed.append({"id": cid, "slot_key": new_c[cid].get("slot_key"), "fields": fields})

    def brief(c: Dict) -> Dict:
        return {"id": c["id"], "slot_key": c.get("slot_key"), "kind": c["kind"], "name": c["name"]}

    sys_changes = {}
    for key in ("model", "serial", "bios", "bmc"):
        a, b = (old.get("system") or {}).get(key), (new.get("system") or {}).get(key)
        if a != b:
            sys_changes[key] = {"old": a, "new": b}
    return {
        "from": old.get("captured_at"),
        "to": new.get("captured_at"),
        "system": sys_changes,
        "added": [brief(new_c[k]) for k in sorted(new_c.keys() - old_c.keys())],
        "removed": [brief(old_c[k]) for k in sorted(old_c.keys() - new_c.keys())],
        "changed": changed,
    }


def _write_json(path: str, data: Any, mode: Optional[int] = None) -> None:
    """Atomic write: readers never see a half-written file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1, sort_keys=False)
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)


def _read_json(path: str) -> Any:
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


class Store:
    """Writes go through an asyncio lock plus an flock on ``data_dir/.lock`` (the service, the batch CLI and
    other tools such as baremetal-mcp may write the same store); files are replaced atomically, so readers
    never need a lock."""

    def __init__(self, data_dir: str):
        self.data_dir = os.path.abspath(data_dir)
        self._lock = asyncio.Lock()
        self._cache: Dict[str, Tuple[Any, Any]] = {}

    # -- paths ---------------------------------------------------------------

    def _check_id(self, host_id: str) -> str:
        if not HOST_ID_RE.match(host_id or ""):
            raise ValueError(f"Invalid host id: {host_id!r}")
        return host_id

    def host_path(self, host_id: str) -> str:
        return os.path.join(self.data_dir, "hosts", f"{self._check_id(host_id)}.json")

    def raw_path(self, host_id: str) -> str:
        return os.path.join(self.data_dir, "hosts", f"{self._check_id(host_id)}.raw.json")

    def history_dir(self, host_id: str) -> str:
        return os.path.join(self.data_dir, "history", self._check_id(host_id))

    @property
    def index_path(self) -> str:
        return os.path.join(self.data_dir, "index.json")

    # -- reads ---------------------------------------------------------------

    def _cached(self, path: str) -> Any:
        try:
            st = os.stat(path)
            mtime = (st.st_mtime_ns, st.st_ino, st.st_size)
        except FileNotFoundError:
            self._cache.pop(path, None)
            return None
        hit = self._cache.get(path)
        if hit and hit[0] == mtime:
            return hit[1]
        data = _read_json(path)
        self._cache[path] = (mtime, data)
        return data

    def index(self) -> Dict[str, Dict]:
        return dict((self._cached(self.index_path) or {}).get("hosts") or {})

    def get(self, host_id: str, with_raw: bool = False) -> Optional[Dict]:
        topo = self._cached(self.host_path(host_id))
        if topo is None:
            return None
        return merge_raw(topo, self.get_raw(host_id) or {}) if with_raw else topo

    def get_raw(self, host_id: str) -> Optional[Dict]:
        return _read_json(self.raw_path(host_id))

    def history(self, host_id: str) -> List[Dict]:
        directory = self.history_dir(host_id)
        if not os.path.isdir(directory):
            return []
        out = []
        for name in sorted(os.listdir(directory), reverse=True):
            ts = name[:-5]
            if name.endswith(".json") and _TS_RE.match(ts):
                snap = self._cached(os.path.join(directory, name)) or {}
                out.append({"ts": ts, "captured_at": snap.get("captured_at"), **(snap.get("_history") or {})})
        return out

    def history_snapshot(self, host_id: str, ts: str) -> Optional[Dict]:
        if not _TS_RE.match(ts or ""):
            raise ValueError(f"Invalid history timestamp: {ts!r}")
        return self._cached(os.path.join(self.history_dir(host_id), f"{ts}.json"))

    def host_ids(self) -> List[str]:
        return sorted(self.index())

    # -- writes --------------------------------------------------------------

    async def save(self, topology: Dict) -> Dict:
        """Store a fresh topology; returns the index row plus ``history`` (snapshot name or None)."""
        host_id = self._check_id(topology["server_id"])
        lean, raw = split_raw(topology)
        row = summarize(topology)
        async with self._lock:
            with self._file_lock():
                index = self.index()
                prev = index.get(host_id) or {}
                reasons = []
                if prev.get("fingerprint") != row["fingerprint"]:
                    reasons.append("hardware" if prev.get("fingerprint") else "first")
                if prev.get("fingerprint") and prev.get("firmware_fingerprint") != row["firmware_fingerprint"]:
                    reasons.append("firmware")
                snapshot = None
                if reasons:
                    snapshot = _ts_name(lean["captured_at"])
                    history = {"reasons": reasons, "fingerprint": row["fingerprint"]}
                    path = os.path.join(self.history_dir(host_id), f"{snapshot}.json")
                    _write_json(path, {**lean, "_history": history})
                _write_json(self.raw_path(host_id), raw)
                _write_json(self.host_path(host_id), lean)
                row.update(
                    {
                        "last_attempt_at": now_iso(),
                        "last_error": None,
                        "changed_at": lean["captured_at"] if reasons else prev.get("changed_at"),
                    }
                )
                index[host_id] = row
                self._write_index(index)
        return {**row, "history": snapshot}

    async def record_error(self, host_id: str, kind: str, message: str) -> Dict:
        """Remember a failed collection; previously collected data stays in place."""
        self._check_id(host_id)
        async with self._lock:
            with self._file_lock():
                index = self.index()
                row = dict(index.get(host_id) or {})
                at = now_iso()
                row["last_attempt_at"] = at
                row["last_error"] = {"kind": kind, "message": message, "at": at}
                index[host_id] = row
                self._write_index(index)
        return row

    async def delete(self, host_id: str) -> None:
        """Drop a host's current data and index row (history is kept)."""
        async with self._lock:
            with self._file_lock():
                index = self.index()
                index.pop(host_id, None)
                for path in (self.host_path(host_id), self.raw_path(host_id)):
                    if os.path.exists(path):
                        os.remove(path)
                self._write_index(index)

    @contextlib.contextmanager
    def _file_lock(self):
        os.makedirs(self.data_dir, exist_ok=True)
        with open(os.path.join(self.data_dir, ".lock"), "w") as f:
            if fcntl:
                fcntl.flock(f, fcntl.LOCK_EX)
            yield

    def _write_index(self, index: Dict[str, Dict]) -> None:
        _write_json(self.index_path, {"version": 1, "updated_at": now_iso(), "hosts": dict(sorted(index.items()))})
