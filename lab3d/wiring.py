#!/usr/bin/env python3
"""
Switch wiring: which switch port each NIC port is cabled to, from optional CSV/YAML files.

The files come from outside (LLDP/MAC-table correlation, cabling plans). Accepted columns, with aliases:

    host                         required
    mac | mac_address            matched against the port MAC Redfish reports
    nic_fqdd                     Dell FQDD, e.g. NIC.Integrated.1-1-1 (matches port NIC.Integrated.1-1)
    nic_slot + host_physical_port   "Slot 3" + "p0", or host_physical_port "Slot 3 Port 1" alone
    interface | linux_interface  kept for display only (Redfish does not know Linux names)
    switch_id, switch_port       required for a row to describe a peer
    switch_link_state, vlan_id | vlan, observed_at, correlation_status | status, notes, cable_id, cable_type

Rows are matched to ports by MAC, then FQDD, then slot and port number. Several files are merged per port:
an observed row (with ``observed_at``) beats a planned one, and the newest ``observed_at`` wins.
Wiring is applied when a topology is read, so editing the files never touches the store or its history.
"""

import copy
import csv
import glob
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import yaml

logger = logging.getLogger("viewer.wiring")

_ALIASES = {
    "mac": ("mac", "mac_address"),
    "interface": ("interface", "linux_interface"),
    "vlan": ("vlan_id", "vlan"),
    "status": ("correlation_status", "status"),
}
_PEER_FIELDS = ("switch_link_state", "observed_at", "notes", "cable_id", "cable_type", "interface")


def norm_host(name: str) -> str:
    """``DB01.example.com`` -> ``db01``; an IP-style name such as ``10.0.0.1`` is kept whole."""
    name = (name or "").strip().lower()
    return name if re.fullmatch(r"[\d.]+", name) else name.split(".")[0]


def norm_mac(mac: Optional[str]) -> Optional[str]:
    """Hex digits only; None for empty or redacted (all-zero) addresses, which must never match."""
    digits = re.sub(r"[^0-9a-f]", "", (mac or "").lower())
    return digits if len(digits) == 12 and digits.strip("0") else None


def _fqdd_port(fqdd: Optional[str]) -> Optional[str]:
    """``NIC.Integrated.1-1-1`` (port 1, partition 1) -> ``NIC.Integrated.1-1``, the Redfish port Id."""
    m = re.match(r"^(NIC\.\w+\.\d+-\d+)(-\d+)?$", (fqdd or "").strip())
    return m.group(1) if m else None


def _physical(nic_slot: Optional[str], port: Optional[str]) -> Optional[Tuple[str, Optional[int], int]]:
    """(kind, slot number or None, 0-based port index) from free-text slot and port columns."""
    text = f"{nic_slot or ''} {port or ''}".strip()
    m = re.search(r"\bport\s*(\d+)\b", text, re.IGNORECASE)
    if m:
        index = int(m.group(1)) - 1
    else:
        m = re.fullmatch(r"\s*p?(\d+)\s*", port or "", re.IGNORECASE)
        if not m:
            return None
        index = int(m.group(1)) - (0 if (port or "").strip().lower().startswith("p") else 1)
    upper = text.upper()
    slot = re.search(r"SLOT\s*(\d+)", upper)
    if "OCP" in upper or "INTEGRATED" in upper:
        return "ocp", int(slot.group(1)) if slot else None, index
    if "EMBEDDED" in upper or "ONBOARD" in upper or "LOM" in upper:
        return "lom", None, index
    if slot:
        return "pcie", int(slot.group(1)), index
    return None


@dataclass
class WiringRow:
    host: str
    switch: str
    switch_port: str
    source: str
    mac: Optional[str] = None
    fqdd_port: Optional[str] = None
    physical: Optional[Tuple[str, Optional[int], int]] = None
    vlan: Optional[str] = None
    status: Optional[str] = None
    extra: Dict[str, str] = field(default_factory=dict)

    @property
    def observed_at(self) -> str:
        return self.extra.get("observed_at") or ""

    def peer(self, matched_by: str) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "switch": self.switch,
            "port": self.switch_port,
            "matched_by": matched_by,
            "source": self.source,
        }
        if self.vlan:
            out["vlan"] = self.vlan
        if self.status:
            out["status"] = self.status
        out.update({k: v for k, v in self.extra.items() if v})
        return out


def _pick(row: Dict[str, Any], key: str) -> Optional[str]:
    for name in _ALIASES.get(key, (key,)):
        value = row.get(name)
        if value not in (None, ""):
            return str(value).strip()
    return None


def parse_rows(records: List[Dict[str, Any]], source: str) -> List[WiringRow]:
    rows = []
    for rec in records:
        rec = {str(k).strip().lower(): v for k, v in (rec or {}).items() if k}
        host, switch, port = _pick(rec, "host"), _pick(rec, "switch_id"), _pick(rec, "switch_port")
        if not (host and switch and port):
            continue  # unresolved rows say nothing about the peer
        rows.append(
            WiringRow(
                host=norm_host(host),
                switch=switch,
                switch_port=port,
                source=source,
                mac=norm_mac(_pick(rec, "mac")),
                fqdd_port=_fqdd_port(_pick(rec, "nic_fqdd")),
                physical=_physical(_pick(rec, "nic_slot"), _pick(rec, "host_physical_port")),
                vlan=_pick(rec, "vlan"),
                status=_pick(rec, "status"),
                extra={k: v for k in _PEER_FIELDS if (v := _pick(rec, k))},
            )
        )
    return rows


def read_file(path: str) -> List[WiringRow]:
    source = os.path.basename(path)
    with open(path, newline="") as f:
        if path.lower().endswith((".yaml", ".yml")):
            data = yaml.safe_load(f) or []
            records = (data.get("links") or data.get("wiring") or []) if isinstance(data, dict) else data
        else:
            records = list(csv.DictReader(f))
    if not isinstance(records, list):
        raise ValueError(f"{path}: expected a list of rows")
    return parse_rows(records, source)


def _better(new: WiringRow, old: WiringRow) -> bool:
    """Observed beats planned; then the newest observation wins; on a tie the later file wins."""
    return (bool(new.observed_at), new.observed_at) >= (bool(old.observed_at), old.observed_at)


def _ports(topology: Dict) -> List[Tuple[Dict, int, Dict]]:
    out = []
    for c in topology.get("components") or []:
        for i, port in enumerate((c.get("summary") or {}).get("ports") or []):
            out.append((c, i, port))
    return out


def _slot_num(component: Dict) -> Optional[int]:
    m = re.search(r":(\d+)$", component.get("slot_key") or "")
    return int(m.group(1)) if m else None


def match(topology: Dict, rows: List[WiringRow]) -> Dict[Tuple[str, int], Tuple[WiringRow, str]]:
    """(component id, port index) -> (best row, how it matched)."""
    ports = _ports(topology)
    by_mac: Dict[str, List[Tuple[str, int]]] = {}
    by_fqdd: Dict[str, Tuple[str, int]] = {}
    for c, i, port in ports:
        mac = norm_mac(port.get("mac"))
        if mac:
            by_mac.setdefault(mac, []).append((c["id"], i))
        if port.get("id"):
            by_fqdd[str(port["id"])] = (c["id"], i)

    def by_physical(phys: Tuple[str, Optional[int], int]) -> Optional[Tuple[str, int]]:
        kind, slot, index = phys
        candidates = [c for c in topology.get("components") or [] if c.get("kind") == kind and c.get("present")]
        if slot is not None:
            numbered = [c for c in candidates if _slot_num(c) == slot]
            # OCP numbering differs between tools (Dell "NIC.Integrated.1" vs. "OCP 3.0 Slot 10").
            candidates = numbered if numbered or kind != "ocp" else candidates
        if len(candidates) != 1:  # "Onboard/OCP Port 1" with two OCP cards is ambiguous
            return None
        c = candidates[0]
        n = len((c.get("summary") or {}).get("ports") or [])
        return (c["id"], index) if 0 <= index < n else None

    out: Dict[Tuple[str, int], Tuple[WiringRow, str]] = {}
    for row in rows:
        target, how = None, None
        if row.mac and len(by_mac.get(row.mac, [])) == 1:
            target, how = by_mac[row.mac][0], "mac"
        elif row.fqdd_port and row.fqdd_port in by_fqdd:
            target, how = by_fqdd[row.fqdd_port], "fqdd"
        elif row.physical and not row.mac:  # a MAC that matches nothing means a different card, not this slot
            target, how = by_physical(row.physical), "slot"
        if target is None:
            continue
        current = out.get(target)
        if current is None or _better(row, current[0]):
            out[target] = (row, how)
    return out


class Wiring:
    """Wiring files, reloaded when any of them changes (checked at most every few seconds)."""

    CHECK_INTERVAL = 5.0

    def __init__(self, patterns: List[str]):
        self.patterns = list(patterns)
        self._lock = threading.Lock()
        self._stamp: Optional[Tuple] = None
        self._checked = 0.0
        self._by_host: Dict[str, List[WiringRow]] = {}
        self.errors: Dict[str, str] = {}

    def files(self) -> List[str]:
        out: List[str] = []
        for pattern in self.patterns:
            matches = sorted(glob.glob(os.path.expanduser(pattern))) if glob.has_magic(pattern) else [pattern]
            out += [p for p in matches if p not in out]
        return out

    def _current_stamp(self) -> Tuple:
        stamp = []
        for path in self.files():
            try:
                st = os.stat(path)
                stamp.append((path, st.st_mtime_ns, st.st_size))
            except OSError:
                stamp.append((path, None, None))
        return tuple(stamp)

    def _reload(self, stamp: Tuple) -> None:
        by_host: Dict[str, List[WiringRow]] = {}
        errors: Dict[str, str] = {}
        for path, mtime, _ in stamp:
            if mtime is None:
                errors[os.path.basename(path)] = "not found"
                continue
            try:
                rows = read_file(path)
            except (OSError, ValueError, csv.Error, yaml.YAMLError) as e:
                errors[os.path.basename(path)] = str(e)
                continue
            for row in rows:
                by_host.setdefault(row.host, []).append(row)
        for name, err in errors.items():
            logger.warning("Wiring file %s skipped: %s", name, err)
        self._by_host, self.errors, self._stamp = by_host, errors, stamp

    def version(self) -> Optional[Tuple]:
        """Changes whenever the loaded rows change; None when no wiring is configured."""
        if not self.patterns:
            return None
        with self._lock:
            now = time.monotonic()
            if self._stamp is None or now - self._checked >= self.CHECK_INTERVAL:
                self._checked = now
                stamp = self._current_stamp()
                if stamp != self._stamp:
                    self._reload(stamp)
            return self._stamp

    def rows_for(self, host_id: str) -> List[WiringRow]:
        self.version()
        return self._by_host.get(norm_host(host_id), [])

    def summary(self) -> Dict[str, Any]:
        self.version()
        return {
            "files": [os.path.basename(p) for p in self.files()],
            "hosts": len(self._by_host),
            "links": sum(len(r) for r in self._by_host.values()),
            "errors": self.errors,
        }

    def apply(self, topology: Dict) -> Dict:
        """A copy of ``topology`` with ``peer`` on every matched port (the input is never modified)."""
        rows = self.rows_for(topology.get("server_id") or "")
        if not rows:
            return topology
        matched = match(topology, rows)
        if not matched:
            return topology
        out = dict(topology)
        out["components"] = []
        for c in topology.get("components") or []:
            hits = {i: m for (cid, i), m in matched.items() if cid == c["id"]}
            if hits:
                c = copy.deepcopy(c)
                for i, (row, how) in hits.items():
                    c["summary"]["ports"][i]["peer"] = row.peer(how)
            out["components"].append(c)
        return out


def is_up(status: Optional[str]) -> bool:
    return bool(re.fullmatch(r"(link)?up", (status or "").strip(), re.IGNORECASE))


def link_summary(topology: Dict) -> Dict[str, int]:
    """Counts over ports of a wiring-enriched topology: cabled, cabled with the link down, up without a known peer."""
    cabled = cabled_down = unknown_peer = 0
    for _, _, port in _ports(topology):
        peer = port.get("peer")
        if peer:
            cabled += 1
            if not is_up(port.get("link_status")):
                cabled_down += 1
        elif is_up(port.get("link_status")):
            unknown_peer += 1
    return {"cabled": cabled, "cabled_down": cabled_down, "unknown_peer": unknown_peer}
