"""Tests for lab3d/topology.py and the read-only Redfish client."""

import json
import os

import httpx
import pytest

from conftest import make_mock_response
from lab3d.cli import ReplayClient, write_static
from lab3d.redfish import BMCClient, detect_vendor
from lab3d.topology import collect_topology, component_counts, dimm_slot, fan_slot, nic_slot, u_height

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _routes(name: str) -> dict:
    with open(os.path.join(FIXTURES, name)) as f:
        data = json.load(f)
    return {path: make_mock_response(200, body) for path, body in data.items() if path.startswith("/")}


async def _collect(vendor="dell", host="host1"):
    return await collect_topology(BMCClient(host, "10.0.0.1", "root", "pw", vendor))


def _by_kind(topology: dict, kind: str) -> list:
    return [c for c in topology["components"] if c["kind"] == kind]


def _by_key(topology: dict) -> dict:
    return {c["slot_key"]: c for c in topology["components"] if c["slot_key"]}


class TestSlotNormalization:
    @pytest.mark.parametrize(
        "label,expected",
        [
            ("DIMM A1", "A1"),
            ("DIMM.Socket.B12", "B12"),
            ("P1-DIMMA1", "P1-A1"),
            ("P2_DIMMF2", "P2-F2"),
            ("PROC 1 DIMM 12", "P1-12"),
        ],
    )
    def test_dimm_slot(self, label, expected):
        assert dimm_slot(label) == expected

    @pytest.mark.parametrize(
        "name,expected",
        [("System Board Fan1A", "1"), ("System Board Fan6B", "6"), ("FAN3", "3"), ("FANA", "A"), ("Pump", None)],
    )
    def test_fan_slot(self, name, expected):
        assert fan_slot(name) == expected

    @pytest.mark.parametrize(
        "adapter,expected",
        [
            ({"Id": "NIC.Slot.3"}, ("pcie", 3)),
            ({"Id": "NIC.Integrated.1"}, ("ocp", 1)),
            ({"Id": "NIC.Embedded.1"}, ("lom", 1)),
            (
                {"Controllers": [{"Location": {"PartLocation": {"ServiceLabel": "CPU1 SLOT1 PCI-E 3.0 X16"}}}]},
                ("pcie", 1),
            ),
            ({"Controllers": [{"Location": {"PartLocation": {"LocationType": "Embedded"}}}]}, ("lom", 1)),
            ({"Location": {"PartLocation": {"ServiceLabel": "OCP 3.0", "LocationOrdinalValue": 1}}}, ("ocp", 1)),
            ({"Id": "2"}, ("pcie", None)),
        ],
    )
    def test_nic_slot(self, adapter, expected):
        assert nic_slot(adapter) == expected

    def test_u_height(self):
        assert u_height("PowerEdge R750", {}) == 2
        assert u_height("PowerEdge R650", {}) == 1
        assert u_height("Super Server", {"Model": "CSE-515-R407"}) == 1
        assert u_height("Super Server", {"Model": "CSE-825TQ"}) == 2
        assert u_height("Anything", {"HeightMm": 87.3}) == 2
        assert u_height("Unknown", {}) is None


class TestDellR750Topology:
    async def _topology(self, mock_redfish_client):
        mock_redfish_client(_routes("dell_r750.json"))
        return await _collect()

    async def test_system_and_chassis(self, mock_redfish_client):
        topo = await self._topology(mock_redfish_client)
        assert topo["schema_version"] == 1
        assert topo["system"]["vendor"] == "dell"
        assert topo["system"]["model"] == "PowerEdge R750"
        assert topo["system"]["bmc"] == "7.10.70.00"
        assert topo["chassis"]["u_height"] == 2

    async def test_cpus_and_dimms(self, mock_redfish_client):
        topo = await self._topology(mock_redfish_client)
        keys = _by_key(topo)
        assert [c["slot_key"] for c in _by_kind(topo, "cpu")] == ["cpu:1", "cpu:2"]
        assert keys["cpu:1"]["summary"]["cores"] == 28
        dimms = _by_kind(topo, "dimm")
        assert len(dimms) == 16
        assert {"dimm:A1", "dimm:A8", "dimm:B1", "dimm:B8"} <= set(keys)
        assert keys["dimm:A1"]["summary"]["capacity_gib"] == 32
        assert keys["dimm:A1"]["name"] == "Micron Technology 32GB DDR4-3200"
        assert keys["dimm:B4"]["health"] == "Critical"

    async def test_pcie_slots_nics_and_empty_slots(self, mock_redfish_client):
        topo = await self._topology(mock_redfish_client)
        keys = _by_key(topo)
        pcie = [c for c in _by_kind(topo, "pcie")]
        assert [c["slot_key"] for c in pcie] == [f"pcie:{n}" for n in range(1, 9)]
        assert [c["slot_key"] for c in pcie if c["present"]] == ["pcie:3", "pcie:6"]
        nic = keys["pcie:3"]
        assert nic["summary"]["category"] == "network"
        assert nic["summary"]["port_count"] == 4
        assert nic["summary"]["pcie_gen"] == "Gen4"
        assert nic["summary"]["form"] == "low_profile"
        assert [p["link_status"] for p in nic["summary"]["ports"]] == ["Up", "Up", "Down", "Down"]
        assert keys["pcie:1"]["present"] is False
        assert keys["pcie:1"]["summary"]["form"] == "full_height"
        assert keys["ocp:1"]["summary"]["port_count"] == 2
        assert keys["lom:1"]["name"] == "Broadcom Gigabit Ethernet BCM5720"
        # The chipset has no slot and is not rendered.
        assert not any("Chipset" in c["name"] for c in topo["components"])

    async def test_psus_fans_drives(self, mock_redfish_client):
        topo = await self._topology(mock_redfish_client)
        keys = _by_key(topo)
        assert keys["psu:1"]["summary"]["capacity_w"] == 1400
        assert keys["psu:2"]["health"] == "Warning"
        fans = _by_kind(topo, "fan")
        assert [c["slot_key"] for c in fans] == [f"fan:{n}" for n in range(1, 7)]
        assert len(keys["fan:1"]["summary"]["rpm"]) == 2
        drives = _by_kind(topo, "drive")
        assert [c["slot_key"] for c in drives] == [f"bay:{n}" for n in range(8)]
        assert keys["bay:0"]["summary"]["capacity_gb"] == 960
        storage = _by_kind(topo, "storage")
        assert storage[0]["slot_key"] is None
        assert storage[0]["name"] == "PERC H755 Front"

    async def test_ids_unique_and_raw_trimmed(self, mock_redfish_client):
        topo = await self._topology(mock_redfish_client)
        ids = [c["id"] for c in topo["components"]]
        assert len(ids) == len(set(ids))
        assert all("Links" not in c["raw"] for c in topo["components"])


class TestSupermicroTopology:
    async def test_x11(self, mock_redfish_client):
        mock_redfish_client(_routes("supermicro_x11.json"))
        topo = await _collect("supermicro", "smc1")
        keys = _by_key(topo)
        assert topo["system"]["vendor"] == "supermicro"
        assert topo["chassis"]["u_height"] == 1
        assert [c["slot_key"] for c in _by_kind(topo, "cpu")] == ["cpu:1"]
        dimms = _by_kind(topo, "dimm")
        assert len([d for d in dimms if d["present"]]) == 6
        assert keys["dimm:P1-A2"]["present"] is False
        assert keys["pcie:1"]["name"] == "AOC-S25G-i2S"
        assert keys["pcie:1"]["summary"]["port_count"] == 2
        assert keys["lom:1"]["present"] is True
        assert [c["slot_key"] for c in _by_kind(topo, "psu")] == ["psu:1", "psu:2"]
        assert keys["fan:5"]["present"] is False
        assert _by_kind(topo, "drive") == []


class TestClientAndExport:
    async def test_counts_and_static_export(self, mock_redfish_client, tmp_path):
        mock_redfish_client(_routes("dell_r750.json"))
        topo = await _collect()
        counts = component_counts(topo)
        assert counts["dimm"] == {"present": 16, "empty": 0}
        assert counts["pcie"] == {"present": 2, "empty": 6}
        write_static(str(tmp_path), topo)
        assert json.loads((tmp_path / "host1.json").read_text())["server_id"] == "host1"
        index = json.loads((tmp_path / "index.json").read_text())
        assert index == {"servers": [{"id": "host1", "model": "PowerEdge R750"}]}

    async def test_replay_matches_live(self, mock_redfish_client):
        mock_redfish_client(_routes("dell_r750_captured.json"))
        live = await _collect(host="r750")
        with open(os.path.join(FIXTURES, "dell_r750_captured.json")) as f:
            replayed = await collect_topology(ReplayClient("r750", json.load(f)))
        live.pop("captured_at"), replayed.pop("captured_at")
        assert replayed == live

    async def test_system_failure_raises(self, mock_redfish_client):
        mock_redfish_client({})
        with pytest.raises(httpx.HTTPStatusError):
            await _collect()

    async def test_vendor_detected_once(self, mock_redfish_client):
        routes = _routes("dell_r750.json")
        routes["/redfish/v1"] = make_mock_response(200, {"Oem": {"Dell": {}}})
        mock_redfish_client(routes)
        client = BMCClient("host1", "10.0.0.1", "root", "pw")
        await collect_topology(client)
        assert client.vendor == "dell"

    async def test_vendor_detection_failure(self, mock_redfish_client):
        mock_redfish_client({"/redfish/v1": make_mock_response(200, {"Oem": {"Acme": {}}})})
        with pytest.raises(ConnectionError, match="auto-detect vendor"):
            await detect_vendor("10.0.0.9")

    async def test_get_only_with_basic_auth_and_retries(self, monkeypatch, mock_redfish_client):
        calls = []

        def flaky(method, url, **kwargs):
            calls.append((method, kwargs.get("auth")))
            return make_mock_response(503 if len(calls) == 1 else 200, {"Id": "x"})

        mock_redfish_client({"/redfish/v1/Systems/1": flaky})
        monkeypatch.setattr("lab3d.redfish.asyncio.sleep", lambda *_: _noop())
        client = BMCClient("h", "10.0.0.1", vendor="hpe")
        assert await client.get("/redfish/v1/Systems/1") == {"Id": "x"}
        assert calls == [("GET", ("Administrator", "password"))] * 2  # vendor default credentials
        assert "password" not in repr(client)

    def test_unknown_vendor_rejected(self):
        with pytest.raises(ValueError):
            BMCClient("h", "10.0.0.1", vendor="acme")


async def _noop():
    return None


class TestCapturedDell:
    """Real iDRAC9 captures (`3d-lab capture`) of an R750 and an R650, identifiers replaced by invented ones."""

    async def _topology(self, name, mock_redfish_client):
        mock_redfish_client(_routes(name))
        return await _collect(host="captured")

    async def test_r750(self, mock_redfish_client):
        topo = await self._topology("dell_r750_captured.json", mock_redfish_client)
        keys = _by_key(topo)
        assert topo["chassis"]["u_height"] == 2
        assert len([c for c in _by_kind(topo, "dimm") if c["present"]]) == 16
        assert keys["pcie:6"]["name"] == "MLNX 100GbE 2P ConnectX6 Adpt"
        assert keys["pcie:2"]["slot_label"] == "Slot 2"
        assert keys["pcie:2"]["present"] is False
        assert keys["ocp:1"]["summary"]["port_count"] == 2
        # Onboard LOM has no Model on iDRAC9; the name is built from manufacturer and port count.
        assert keys["lom:1"]["name"].endswith("2-port NIC")
        # Chipset SATA controllers without drives are dropped.
        assert [c["name"] for c in _by_kind(topo, "storage")] == ["PERC H745 Front"]

    async def test_r650_u2_bays_are_drives_not_cards(self, mock_redfish_client):
        topo = await self._topology("dell_r650_captured.json", mock_redfish_client)
        keys = _by_key(topo)
        assert topo["chassis"]["u_height"] == 1
        assert [c["slot_key"] for c in _by_kind(topo, "pcie")] == ["pcie:1", "pcie:2"]
        assert [c["slot_key"] for c in _by_kind(topo, "drive")] == ["bay:0", "bay:1", "bay:7", "bay:8", "bay:9"]
        assert keys["bay:7"]["summary"]["protocol"] == "PCIe"
        assert "CPU-attached NVMe (CPU.1)" in [c["name"] for c in _by_kind(topo, "storage")]
        assert len(keys["fan:1"]["summary"]["rpm"]) == 4

    async def test_components_sorted_naturally(self, mock_redfish_client):
        topo = await self._topology("dell_r650_captured.json", mock_redfish_client)
        dimms = [c["slot_key"] for c in _by_kind(topo, "dimm")]
        assert dimms[:3] == ["dimm:A1", "dimm:A2", "dimm:A3"]
        assert [c["kind"] for c in topo["components"]][:2] == ["cpu", "cpu"]
