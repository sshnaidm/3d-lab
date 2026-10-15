#!/usr/bin/env python3
"""
Hardware topology: Redfish data normalized into a slot-level hardware map (schema v1) for the 3D viewer.

Every component (CPU, DIMM, PCIe card, OCP/LOM NIC, PSU, fan, drive, storage
controller) is normalized to a stable ``slot_key`` such as ``dimm:A1``,
``pcie:3``, ``psu:1`` or ``bay:4``. The viewer's per-model layout templates map
these keys to 3D positions.
"""

import asyncio
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from lab3d.redfish import BMCClient

SCHEMA_VERSION = 1

# Keys dropped from the raw Redfish payload kept on each component.
_RAW_DROP = {"Links", "Actions", "@odata.context", "@odata.etag", "@odata.type", "Assembly", "Metrics"}

_HEALTH_RANK = {"OK": 0, "Warning": 1, "Critical": 2}


# ---------------------------------------------------------------------------
# Small normalization helpers
# ---------------------------------------------------------------------------


def _status(obj: Dict) -> Dict:
    return obj.get("Status") or {}


def _health(obj: Dict) -> Optional[str]:
    status = _status(obj)
    return status.get("Health") or status.get("HealthRollup")


def _worst_health(values: List[Optional[str]]) -> Optional[str]:
    known = [v for v in values if v in _HEALTH_RANK]
    return max(known, key=_HEALTH_RANK.get) if known else None


def _present(obj: Dict) -> bool:
    return _status(obj).get("State") != "Absent"


def _last_int(text: Optional[str]) -> Optional[int]:
    if not text:
        return None
    found = re.findall(r"\d+", str(text))
    return int(found[-1]) if found else None


def _slot_number(label: Optional[str]) -> Optional[int]:
    """``CPU1 SLOT1 PCI-E 3.0 X16`` -> 1 (prefer the number after SLOT), else the last number."""
    m = re.search(r"slot\s*(\d+)", label or "", re.IGNORECASE)
    return int(m.group(1)) if m else _last_int(label)


def _trim(obj: Dict) -> Dict:
    return {k: v for k, v in obj.items() if k not in _RAW_DROP and not k.endswith("@odata.count")}


def _part_location(obj: Dict) -> Dict:
    """Return PartLocation from ``Location`` or ``Slot.Location`` (dicts or Dell-style lists)."""
    for loc in (obj.get("Location"), (obj.get("Slot") or {}).get("Location")):
        if isinstance(loc, list):
            loc = loc[0] if loc else None
        if isinstance(loc, dict) and loc.get("PartLocation"):
            return loc["PartLocation"]
    return {}


def _component(
    kind: str,
    slot_key: Optional[str],
    slot_label: Optional[str],
    raw: Dict,
    name: str,
    summary: Dict,
    present: Optional[bool] = None,
    health: Optional[str] = None,
) -> Dict:
    return {
        "id": slot_key or f"{kind}:{raw.get('Id') or name}",
        "kind": kind,
        "slot_key": slot_key,
        "slot_label": slot_label,
        "present": _present(raw) if present is None else present,
        "health": health if health is not None else _health(raw),
        "name": name,
        "summary": {k: v for k, v in summary.items() if v is not None},
        "raw": _trim(raw),
    }


# ---------------------------------------------------------------------------
# Slot key normalization
# ---------------------------------------------------------------------------


def dimm_slot(label: str) -> str:
    """``DIMM A1``/``DIMM.Socket.A1`` -> ``A1``; ``P1-DIMMA1`` -> ``P1-A1``; ``PROC 1 DIMM 12`` -> ``P1-12``."""
    up = label.upper()
    m = re.search(r"(?:P(\d+)[-_ ]?)?DIMM[\s._-]*(?:SOCKET[\s._-]*)?([A-Z]{1,2}\d{1,2})\b", up)
    if m:
        return f"P{m.group(1)}-{m.group(2)}" if m.group(1) else m.group(2)
    m = re.search(r"PROC(?:ESSOR)?\s*(\d+)\s*DIMM\s*(\d+)", up)
    if m:
        return f"P{m.group(1)}-{m.group(2)}"
    return re.sub(r"[^A-Z0-9-]+", "-", up).strip("-")


def fan_slot(name: str) -> Optional[str]:
    """``System Board Fan1A`` -> ``1``; ``FAN3`` -> ``3``; ``FANA`` -> ``A``."""
    m = re.search(r"fan[\s._-]*(\d+)", name, re.IGNORECASE)
    if m:
        return str(int(m.group(1)))
    m = re.search(r"fan[\s._-]*([a-z])\b", name, re.IGNORECASE)
    return m.group(1).upper() if m else None


def nic_slot(adapter: Dict) -> Tuple[str, Optional[int]]:
    """Map a NetworkAdapter to (kind, ordinal): ``pcie``, ``ocp`` or ``lom``."""
    adapter_id = adapter.get("Id") or ""
    m = re.match(r"NIC\.(Slot|Integrated|Embedded)\.(\d+)", adapter_id)
    if m:  # Dell: Integrated is the OCP 3.0 mezzanine, Embedded is the rear LOM
        return {"Slot": "pcie", "Integrated": "ocp", "Embedded": "lom"}[m.group(1)], int(m.group(2))

    locations = [_part_location(adapter)]
    locations += [_part_location(c) for c in adapter.get("Controllers") or []]
    for loc in locations:
        if not loc:
            continue
        label = (loc.get("ServiceLabel") or "").upper()
        ordinal = loc.get("LocationOrdinalValue")
        if loc.get("LocationType") == "Embedded" or re.search(r"ONBOARD|LOM|\bLAN\b", label):
            return "lom", ordinal or 1
        if "OCP" in label:
            return "ocp", ordinal or _last_int(label) or 1
        slot = ordinal if ordinal is not None else _slot_number(label)
        if slot is not None:
            return "pcie", slot
    return "pcie", None


def _slot_kind(slot_type: Optional[str]) -> Optional[str]:
    """Slot kind for a Redfish SlotType; None for drive bays (U.2/M.2), which appear as drives instead."""
    upper = (slot_type or "").upper()
    if upper in ("U2", "M2"):
        return None
    return "ocp" if upper.startswith("OCP") else "pcie"


def _slot_form(slot_type: Optional[str]) -> Optional[str]:
    return {"LowProfile": "low_profile", "FullLength": "full_height", "HalfLength": "full_height"}.get(slot_type or "")


def _pcie_category(device: Dict, functions: List[Dict]) -> str:
    classes = " ".join(f.get("DeviceClass") or f.get("FunctionType") or "" for f in functions)
    text = f"{classes} {device.get('DeviceType') or ''} {device.get('Name') or ''} {device.get('Description') or ''}"
    text = text.lower()
    if "network" in text or "ethernet" in text:
        return "network"
    if "storage" in text or "raid" in text or "nvme" in text:
        return "storage"
    if "display" in text or "accelerat" in text or "gpu" in text:
        return "gpu"
    return "other"


def u_height(system_model: str, chassis: Dict) -> Optional[int]:
    height = chassis.get("HeightMm")
    if height:
        return max(1, round(height / 44.45))
    model = f"{chassis.get('Model') or ''} {system_model}".upper()
    m = re.search(r"\bR([6-9])\d{2}\b", model)  # Dell PowerEdge R6xx = 1U, R7xx = 2U
    if m:
        return 1 if m.group(1) == "6" else 2
    m = re.search(r"CSE-\d(\d)", model)  # Supermicro CSE-515 = 1U, CSE-825 = 2U
    if m:
        return int(m.group(1))
    return None


# ---------------------------------------------------------------------------
# Component builders
# ---------------------------------------------------------------------------


def build_cpus(processors: List[Dict]) -> List[Dict]:
    out = []
    for idx, p in enumerate(processors):
        if p.get("ProcessorType") not in (None, "CPU"):
            continue
        num = _last_int(p.get("Socket")) or _last_int(p.get("Id")) or idx + 1
        out.append(
            _component(
                "cpu",
                f"cpu:{num}",
                p.get("Socket") or f"CPU{num}",
                p,
                (p.get("Model") or "Processor").strip(),
                {
                    "model": p.get("Model"),
                    "manufacturer": p.get("Manufacturer"),
                    "cores": p.get("TotalCores"),
                    "threads": p.get("TotalThreads"),
                    "max_speed_mhz": p.get("MaxSpeedMHz"),
                    "architecture": p.get("InstructionSet"),
                },
            )
        )
    return out


def build_dimms(memory: List[Dict]) -> List[Dict]:
    out = []
    for m in memory:
        label = m.get("DeviceLocator") or m.get("Name") or m.get("Id") or ""
        capacity_mib = m.get("CapacityMiB") or 0
        present = _present(m) and capacity_mib > 0
        capacity_gib = round(capacity_mib / 1024) if capacity_mib else None
        mem_type = m.get("MemoryDeviceType")
        speed = m.get("OperatingSpeedMhz")
        name = " ".join(
            str(x)
            for x in [
                (m.get("Manufacturer") or "").strip(),
                f"{capacity_gib}GB" if capacity_gib else None,
                f"{mem_type}-{speed}" if mem_type and speed else mem_type,
            ]
            if x
        )
        out.append(
            _component(
                "dimm",
                f"dimm:{dimm_slot(label)}",
                label,
                m,
                name if present else f"Empty {label}",
                {
                    "capacity_gib": capacity_gib,
                    "speed_mts": speed,
                    "type": mem_type,
                    "manufacturer": (m.get("Manufacturer") or "").strip() or None,
                    "part_number": (m.get("PartNumber") or "").strip() or None,
                    "rank_count": m.get("RankCount"),
                    "memory_location": m.get("MemoryLocation"),
                },
                present=present,
            )
        )
    return out


def _port_summary(port: Dict) -> Dict:
    speed = port.get("CurrentLinkSpeedMbps")
    if speed is None and port.get("CurrentSpeedGbps") is not None:
        speed = int(port["CurrentSpeedGbps"] * 1000)
    macs = port.get("AssociatedNetworkAddresses") or (port.get("Ethernet") or {}).get("AssociatedMACAddresses") or []
    return {
        "id": port.get("Id"),
        "link_status": port.get("LinkStatus"),
        "speed_mbps": speed,
        "mac": macs[0] if macs else None,
    }


def build_pcie(
    devices: List[Tuple[Dict, List[Dict]]],
    slots: List[Dict],
    adapters: List[Tuple[Dict, List[Dict]]],
) -> List[Dict]:
    """Merge PCIeSlots, PCIeDevices and NetworkAdapters into one component per slot."""
    by_key: Dict[str, Dict] = {}
    slot_info: Dict[str, Dict] = {}
    device_slot: Dict[str, str] = {}

    for slot in slots:
        loc = _part_location(slot)
        num = loc.get("LocationOrdinalValue") or _slot_number(loc.get("ServiceLabel"))
        kind = _slot_kind(slot.get("SlotType"))
        key = f"{kind}:{num}" if kind and num is not None else None
        if key:
            slot_info[key] = slot
        for link in (slot.get("Links") or {}).get("PCIeDevice") or []:
            device_slot[link.get("@odata.id", "")] = key or ""

    for device, functions in devices:
        key = device_slot.get(device.get("@odata.id", ""))
        if key is None:
            loc = _part_location(device)
            num = loc.get("LocationOrdinalValue") or _slot_number(loc.get("ServiceLabel"))
            kind = _slot_kind((device.get("Slot") or {}).get("SlotType"))
            key = f"{kind}:{num}" if kind and num is not None else ""
        if not key:
            continue  # embedded device (chipset, BMC video, ...) or a drive-bay device: not a card slot
        kind = key.split(":")[0]
        pcie_iface = device.get("PCIeInterface") or {}
        by_key[key] = _component(
            kind,
            key,
            _part_location(device).get("ServiceLabel") or f"Slot {key.split(':')[1]}",
            device,
            device.get("Model") or device.get("Name") or "PCIe device",
            {
                "category": _pcie_category(device, functions),
                "manufacturer": device.get("Manufacturer"),
                "model": device.get("Model"),
                "part_number": device.get("PartNumber"),
                "firmware": device.get("FirmwareVersion"),
                "pcie_gen": pcie_iface.get("PCIeType"),
                "lanes": pcie_iface.get("LanesInUse"),
            },
        )

    for adapter, ports in adapters:
        kind, num = nic_slot(adapter)
        if num is None:
            continue
        key = f"{kind}:{num}"
        controller = (adapter.get("Controllers") or [{}])[0]
        port_count = (controller.get("ControllerCapabilities") or {}).get("NetworkPortCount")
        summary = {
            "category": "network",
            "manufacturer": adapter.get("Manufacturer"),
            "model": adapter.get("Model"),
            "part_number": adapter.get("PartNumber"),
            "firmware": controller.get("FirmwarePackageVersion"),
            "port_count": port_count or len(ports) or None,
            "ports": [_port_summary(p) for p in ports] or None,
        }
        name = adapter.get("Model") or " ".join(
            x
            for x in [
                adapter.get("Manufacturer"),
                f"{summary['port_count']}-port" if summary["port_count"] else None,
                "NIC",
            ]
            if x
        )
        if key in by_key:
            existing = by_key[key]
            existing["name"] = name
            existing["summary"].update({k: v for k, v in summary.items() if v is not None})
            existing["raw"]["NetworkAdapter"] = _trim(adapter)
        else:
            by_key[key] = _component(kind, key, key.replace(":", " ").upper(), adapter, name, summary)

    for key, slot in slot_info.items():
        extra = {
            "slot_type": slot.get("SlotType"),
            "slot_pcie_gen": slot.get("PCIeType"),
            "slot_lanes": slot.get("Lanes"),
            "form": _slot_form(slot.get("SlotType")),
        }
        if key in by_key:
            by_key[key]["summary"].update({k: v for k, v in extra.items() if v is not None})
        else:
            kind, num = key.split(":")
            label = _part_location(slot).get("ServiceLabel") or f"{'OCP' if kind == 'ocp' else 'Slot'} {num}"
            by_key[key] = _component(key.split(":")[0], key, label, slot, f"Empty {label}", extra, present=False)

    return [by_key[k] for k in sorted(by_key, key=lambda k: (k.split(":")[0], _last_int(k) or 0))]


def build_psus(power: Dict) -> List[Dict]:
    out = []
    for idx, psu in enumerate(power.get("PowerSupplies") or []):
        num = _last_int(psu.get("Name")) or _last_int(psu.get("MemberId")) or idx + 1
        capacity = psu.get("PowerCapacityWatts")
        out.append(
            _component(
                "psu",
                f"psu:{num}",
                f"PSU{num}",
                psu,
                " ".join(x for x in [psu.get("Manufacturer"), f"{capacity}W" if capacity else None, "PSU"] if x),
                {
                    "capacity_w": capacity,
                    "model": psu.get("Model"),
                    "manufacturer": psu.get("Manufacturer"),
                    "part_number": psu.get("PartNumber"),
                    "firmware": psu.get("FirmwareVersion"),
                    "input_watts": psu.get("PowerInputWatts"),
                    "output_watts": psu.get("PowerOutputWatts") or psu.get("LastPowerOutputWatts"),
                    "line_input_voltage": psu.get("LineInputVoltage"),
                },
            )
        )
    return out


def build_fans(thermal: Dict) -> List[Dict]:
    """One component per fan module; dual-rotor readings (Fan1A/Fan1B) are merged."""
    groups: Dict[str, List[Dict]] = {}
    for fan in thermal.get("Fans") or []:
        name = fan.get("Name") or fan.get("FanName") or fan.get("MemberId") or ""
        slot = fan_slot(name) or str(len(groups) + 1)
        groups.setdefault(slot, []).append(fan)
    out = []
    for slot, rotors in groups.items():
        out.append(
            _component(
                "fan",
                f"fan:{slot}",
                f"Fan {slot}",
                {"Id": f"Fan{slot}", "Rotors": rotors},
                f"Fan {slot}",
                {
                    "rpm": [r.get("Reading") for r in rotors if r.get("Reading") is not None],
                    "rotor_names": [r.get("Name") for r in rotors],
                },
                present=any(_present(r) for r in rotors),
                health=_worst_health([_health(r) for r in rotors]),
            )
        )
    return sorted(out, key=lambda c: (_last_int(c["slot_key"]) is None, _last_int(c["slot_key"]) or 0, c["slot_key"]))


_CPU_STORAGE = re.compile(r"CPU\.\d")


def build_storage(storages: List[Tuple[Dict, List[Dict]]]) -> List[Dict]:
    out = []
    for idx, (storage, drives) in enumerate(storages):
        controllers = storage.get("StorageControllers") or [{}]
        if drives:  # controllers without drives (chipset SATA, empty HBAs) are not interesting here
            out.append(
                _component(
                    "storage",
                    None,
                    None,
                    storage,
                    controllers[0].get("Model")
                    or (f"CPU-attached NVMe ({storage['Id']})" if _CPU_STORAGE.match(storage.get("Id") or "") else None)
                    or storage.get("Name")
                    or "Storage controller",
                    {
                        "model": controllers[0].get("Model"),
                        "firmware": controllers[0].get("FirmwareVersion"),
                        "drive_count": len(drives),
                    },
                )
            )
        for didx, drive in enumerate(drives):
            loc = _part_location({"Location": drive.get("PhysicalLocation")}) or _part_location(drive)
            bay = loc.get("LocationOrdinalValue")
            if bay is None:
                m = re.search(r"Bay\.(\d+)", drive.get("Id") or "")
                bay = int(m.group(1)) if m else None
            capacity = drive.get("CapacityBytes")
            capacity_gb = round(capacity / 1e9) if capacity else None
            model = (drive.get("Model") or "").strip()
            out.append(
                _component(
                    "drive",
                    f"bay:{bay}" if bay is not None else None,
                    loc.get("ServiceLabel") or (f"Bay {bay}" if bay is not None else drive.get("Id")),
                    drive,
                    " ".join(x for x in [model, f"{capacity_gb}GB" if capacity_gb else None] if x) or "Drive",
                    {
                        "capacity_gb": capacity_gb,
                        "media_type": drive.get("MediaType"),
                        "protocol": drive.get("Protocol"),
                        "model": model or None,
                        "manufacturer": drive.get("Manufacturer"),
                        "firmware": drive.get("Revision"),
                        "controller": controllers[0].get("Model") or storage.get("Id"),
                    },
                )
            )
    return out


_KIND_ORDER = ["cpu", "dimm", "pcie", "ocp", "lom", "psu", "fan", "drive", "storage"]


def _sort_key(c: Dict) -> Tuple:
    """Kind order, then natural order of the slot key (A2 before A10)."""
    natural = [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", c["slot_key"] or c["id"])]
    return (_KIND_ORDER.index(c["kind"]) if c["kind"] in _KIND_ORDER else 99, c["slot_key"] is None, natural)


def _dedupe_ids(components: List[Dict]) -> List[Dict]:
    seen: Dict[str, int] = {}
    for c in components:
        base = c["id"]
        if base in seen:
            seen[base] += 1
            c["id"] = f"{base}#{seen[base]}"
        else:
            seen[base] = 0
    return components


def build_topology(server_id: str, vendor: str, raw: Dict[str, Any]) -> Dict:
    """Pure transformation of fetched Redfish data into topology schema v1."""
    system = raw.get("system") or {}
    manager = raw.get("manager") or {}
    chassis = raw.get("chassis") or {}
    components = (
        build_cpus(raw.get("processors") or [])
        + build_dimms(raw.get("memory") or [])
        + build_pcie(raw.get("pcie_devices") or [], raw.get("pcie_slots") or [], raw.get("adapters") or [])
        + build_psus(raw.get("power") or {})
        + build_fans(raw.get("thermal") or {})
        + build_storage(raw.get("storages") or [])
    )
    model = system.get("Model") or chassis.get("Model") or ""
    return {
        "schema_version": SCHEMA_VERSION,
        "server_id": server_id,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "system": {
            "vendor": vendor,
            "model": model,
            "serial": system.get("SerialNumber"),
            "health": _health(system),
            "power_state": system.get("PowerState"),
            "bios": system.get("BiosVersion"),
            "bmc": manager.get("FirmwareVersion"),
        },
        "chassis": {"model": chassis.get("Model"), "u_height": u_height(model, chassis)},
        "components": _dedupe_ids(sorted(components, key=_sort_key)),
    }


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def _link(data: Dict, key: str) -> Optional[str]:
    value = data.get(key)
    return value.get("@odata.id") if isinstance(value, dict) else None


async def fetch_raw(client: BMCClient) -> Dict[str, Any]:
    """Every Redfish resource ``build_topology`` needs. Only the system resource is required."""
    vendor = await client.resolve_vendor()
    system = await client.get(vendor.system_path)
    chassis_links = (system.get("Links") or {}).get("Chassis") or []
    chassis_path = chassis_links[0].get("@odata.id") if chassis_links else "/redfish/v1/Chassis/1"

    manager, chassis, processors, memory, storages = await asyncio.gather(
        client.get_optional(vendor.manager_path),
        client.get_optional(chassis_path),
        client.get_members(f"{vendor.system_path}/Processors"),
        client.get_members(f"{vendor.system_path}/Memory"),
        client.get_members(f"{vendor.system_path}/Storage"),
    )

    thermal, power, pcie_slots, sys_devices, chassis_devices, adapters = await asyncio.gather(
        client.get_optional(_link(chassis, "Thermal") or f"{chassis_path}/Thermal"),
        client.get_optional(_link(chassis, "Power") or f"{chassis_path}/Power"),
        client.get_optional(_link(chassis, "PCIeSlots")),
        client.get_members(f"{vendor.system_path}/PCIeDevices"),
        client.get_members(_link(chassis, "PCIeDevices") or f"{chassis_path}/PCIeDevices"),
        client.get_members(_link(chassis, "NetworkAdapters") or f"{chassis_path}/NetworkAdapters"),
    )

    # The same device may be listed under both Systems and Chassis.
    devices = list({d.get("@odata.id"): d for d in sys_devices + chassis_devices}.values())

    async def _functions(device: Dict) -> List[Dict]:
        path = _link(device, "PCIeFunctions")
        return await client.get_members(path) if path else []

    async def _ports(adapter: Dict) -> List[Dict]:
        path = _link(adapter, "Ports") or _link(adapter, "NetworkPorts")
        return await client.get_members(path) if path else []

    async def _drives(storage: Dict) -> List[Dict]:
        paths = [d.get("@odata.id") for d in storage.get("Drives") or [] if d.get("@odata.id")]
        return [d for d in await asyncio.gather(*[client.get_optional(p) for p in paths]) if d]

    device_functions, adapter_ports, storage_drives = await asyncio.gather(
        asyncio.gather(*[_functions(d) for d in devices]),
        asyncio.gather(*[_ports(a) for a in adapters]),
        asyncio.gather(*[_drives(s) for s in storages]),
    )

    return {
        "system": system,
        "manager": manager,
        "chassis": chassis,
        "processors": processors,
        "memory": memory,
        "pcie_devices": list(zip(devices, device_functions)),
        "pcie_slots": pcie_slots.get("Slots") or [],
        "adapters": list(zip(adapters, adapter_ports)),
        "thermal": thermal,
        "power": power,
        "storages": list(zip(storages, storage_drives)),
    }


async def collect_topology(client: BMCClient) -> Dict:
    """Fetch and normalize one server's topology from its BMC (always live)."""
    raw = await fetch_raw(client)
    return build_topology(client.host_id, client.vendor or "", raw)


def component_counts(topology: Dict) -> Dict[str, Dict[str, int]]:
    """``{kind: {"present": n, "empty": m}}``."""
    counts: Dict[str, Dict[str, int]] = {}
    for c in topology["components"]:
        entry = counts.setdefault(c["kind"], {"present": 0, "empty": 0})
        entry["present" if c["present"] else "empty"] += 1
    return counts
