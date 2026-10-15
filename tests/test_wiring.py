"""Switch wiring: file parsing, port matching and the API enrichment."""

import os

import pytest
from starlette.testclient import TestClient

from lab3d.app import create_app
from lab3d.wiring import Wiring, link_summary, match, norm_host, norm_mac, parse_rows, read_file
from tests.test_service import LOCAL, LOCAL_WRITE, _wait_jobs, fleet  # noqa: F401 (fixture)

HEADER = (
    "observed_at,host,interface,mac_address,nic_slot,nic_fqdd,host_physical_port,"
    "switch_id,switch_port,switch_link_state,vlan_id,correlation_status,notes\n"
)


def _topology():
    def port(pid, mac, link):
        return {"id": pid, "mac": mac, "link_status": link, "speed_mbps": 25000}

    return {
        "server_id": "host1",
        "components": [
            {
                "id": "ocp:1",
                "kind": "ocp",
                "slot_key": "ocp:1",
                "present": True,
                "summary": {
                    "ports": [
                        port("NIC.Integrated.1-1", "B4:96:91:00:00:01", "LinkUp"),
                        port("NIC.Integrated.1-2", "B4:96:91:00:00:02", "LinkUp"),
                    ]
                },
            },
            {
                "id": "pcie:3",
                "kind": "pcie",
                "slot_key": "pcie:3",
                "present": True,
                "summary": {
                    "ports": [
                        port("NIC.Slot.3-1", None, "LinkDown"),
                        port("NIC.Slot.3-2", None, "Up"),
                    ]
                },
            },
            {"id": "dimm:A1", "kind": "dimm", "slot_key": "dimm:A1", "present": True, "summary": {}},
        ],
    }


class TestParsing:
    @pytest.mark.parametrize(
        "name,expected", [("DB01.lab.example.com", "db01"), (" host1 ", "host1"), ("10.0.0.1", "10.0.0.1")]
    )
    def test_norm_host(self, name, expected):
        assert norm_host(name) == expected

    def test_norm_mac_rejects_redacted(self):
        assert norm_mac("B4:96:91:00:00:01") == "b49691000001"
        assert norm_mac("00:00:00:00:00:00") is None
        assert norm_mac("") is None
        assert norm_mac("xx") is None

    def test_columns_and_aliases(self):
        rows = parse_rows(
            [
                {
                    "host": "HOST1.example.com",
                    "mac_address": "b4:96:91:00:00:01",
                    "switch_id": "sw01",
                    "switch_port": "ethernet1/1/1:3",
                    "vlan_id": "306",
                    "correlation_status": "confirmed",
                    "observed_at": "2026-10-01T00:00:00Z",
                    "interface": "eno1",
                },
                {
                    "host": "host1",
                    "linux_interface": "ens3f0",
                    "nic_slot": "",
                    "host_physical_port": "Slot 3 Port 2",
                    "switch_id": "sw02",
                    "switch_port": "ethernet1/1/2",
                    "vlan": 305,
                    "status": "proposed",
                },
                {"host": "host1", "mac_address": "b4:96:91:00:00:02", "switch_id": "", "switch_port": ""},
            ],
            "a.csv",
        )
        assert len(rows) == 2  # the unresolved row has no peer
        assert rows[0].host == "host1" and rows[0].mac == "b49691000001" and rows[0].vlan == "306"
        assert rows[0].peer("mac")["interface"] == "eno1"
        assert rows[1].physical == ("pcie", 3, 1) and rows[1].vlan == "305" and rows[1].status == "proposed"

    @pytest.mark.parametrize(
        "slot,port,expected",
        [
            ("Slot 3", "p0", ("pcie", 3, 0)),
            ("PCI-E Slot 2", "p1", ("pcie", 2, 1)),
            ("Slot 1", "2", ("pcie", 1, 1)),
            ("Integrated/OCP", "p1", ("ocp", None, 1)),
            ("OCP 3.0 Slot 10", "p0", ("ocp", 10, 0)),
            ("Embedded", "p0", ("lom", None, 0)),
            ("", "Onboard/OCP Port 2", ("ocp", None, 1)),
            ("unknown slot", "p0", None),
            ("Slot 3", "", None),
        ],
    )
    def test_physical_location(self, slot, port, expected):
        rows = parse_rows(
            [{"host": "h", "nic_slot": slot, "host_physical_port": port, "switch_id": "s", "switch_port": "p"}], "x"
        )
        assert rows[0].physical == expected

    def test_yaml_file(self, tmp_path):
        path = tmp_path / "links.yaml"
        path.write_text("links:\n  - {host: host1, nic_fqdd: NIC.Slot.3-1-1, switch_id: sw01, switch_port: et-0/0/1}\n")
        rows = read_file(str(path))
        assert rows[0].fqdd_port == "NIC.Slot.3-1" and rows[0].source == "links.yaml"


class TestMatching:
    def test_mac_then_fqdd_then_slot(self):
        rows = parse_rows(
            [
                {"host": "host1", "mac_address": "b4:96:91:00:00:01", "switch_id": "sw01", "switch_port": "1"},
                {"host": "host1", "nic_fqdd": "NIC.Integrated.1-2-1", "switch_id": "sw01", "switch_port": "2"},
                {
                    "host": "host1",
                    "nic_slot": "Slot 3",
                    "host_physical_port": "p0",
                    "switch_id": "sw02",
                    "switch_port": "3",
                },
            ],
            "a.csv",
        )
        got = {k: (row.switch_port, how) for k, (row, how) in match(_topology(), rows).items()}
        assert got == {("ocp:1", 0): ("1", "mac"), ("ocp:1", 1): ("2", "fqdd"), ("pcie:3", 0): ("3", "slot")}

    def test_unknown_mac_does_not_fall_back_to_slot(self):
        # A MAC that is not on this host means another card: the slot text must not attach it here.
        rows = parse_rows(
            [
                {
                    "host": "host1",
                    "mac_address": "aa:bb:cc:dd:ee:ff",
                    "nic_slot": "Slot 3",
                    "host_physical_port": "p0",
                    "switch_id": "sw",
                    "switch_port": "1",
                }
            ],
            "a.csv",
        )
        assert match(_topology(), rows) == {}

    def test_ambiguous_or_missing_slot_is_skipped(self):
        topo = _topology()
        topo["components"].append(
            {"id": "ocp:2", "kind": "ocp", "slot_key": "ocp:2", "present": True, "summary": {"ports": [{"id": "x"}]}}
        )
        rows = parse_rows(
            [
                {
                    "host": "host1",
                    "nic_slot": "Integrated/OCP",
                    "host_physical_port": "p0",
                    "switch_id": "s",
                    "switch_port": "1",
                },
                {
                    "host": "host1",
                    "nic_slot": "Slot 3",
                    "host_physical_port": "p7",
                    "switch_id": "s",
                    "switch_port": "2",
                },
                {
                    "host": "host1",
                    "nic_slot": "Slot 9",
                    "host_physical_port": "p0",
                    "switch_id": "s",
                    "switch_port": "3",
                },
            ],
            "a.csv",
        )
        assert match(topo, rows) == {}

    def test_observed_beats_planned_and_newest_wins(self):
        rows = parse_rows(
            [
                {
                    "host": "host1",
                    "nic_fqdd": "NIC.Slot.3-1-1",
                    "switch_id": "old",
                    "switch_port": "1",
                    "observed_at": "2026-09-01T00:00:00Z",
                },
                {
                    "host": "host1",
                    "nic_fqdd": "NIC.Slot.3-1-1",
                    "switch_id": "new",
                    "switch_port": "1",
                    "observed_at": "2026-10-01T00:00:00Z",
                },
                {"host": "host1", "nic_fqdd": "NIC.Slot.3-1-1", "switch_id": "plan", "switch_port": "1"},
            ],
            "a.csv",
        )
        ((row, _),) = match(_topology(), rows).values()
        assert row.switch == "new"

    def test_apply_copies_and_link_summary(self, tmp_path):
        path = tmp_path / "w.csv"
        path.write_text(
            HEADER
            + "2026-10-01T00:00:00Z,host1,eno1,b4:96:91:00:00:01,,,,sw01,ethernet1/1/1:3,up,306,confirmed,\n"
            + "2026-10-01T00:00:00Z,host1,ens3f0,,Slot 3,,p0,sw01,ethernet1/1/6,up,306,confirmed,\n"
            + "2026-10-01T00:00:00Z,other,ens3f0,,Slot 3,,p1,sw01,ethernet1/1/7,up,306,confirmed,\n"
        )
        topo = _topology()
        out = Wiring([str(path)]).apply(topo)
        assert "peer" not in topo["components"][0]["summary"]["ports"][0]  # input untouched
        peer = out["components"][0]["summary"]["ports"][0]["peer"]
        assert peer == {
            "switch": "sw01",
            "port": "ethernet1/1/1:3",
            "matched_by": "mac",
            "source": "w.csv",
            "vlan": "306",
            "status": "confirmed",
            "switch_link_state": "up",
            "observed_at": "2026-10-01T00:00:00Z",
            "interface": "eno1",
        }
        assert out["components"][2] is topo["components"][2]  # untouched components are shared
        # ocp:1 port 2 is up without a peer; pcie:3 port 1 is cabled with the link down, port 2 up and unknown.
        assert link_summary(out) == {"cabled": 2, "cabled_down": 1, "unknown_peer": 2}

    def test_reload_on_change_and_missing_files(self, tmp_path):
        path = tmp_path / "w.csv"
        path.write_text(HEADER + ",host1,,,,NIC.Slot.3-1-1,,sw01,1,,,,\n")
        wiring = Wiring([str(path), str(tmp_path / "missing.csv")])
        wiring.CHECK_INTERVAL = 0
        assert wiring.summary()["links"] == 1
        assert wiring.summary()["errors"] == {"missing.csv": "not found"}
        v1 = wiring.version()
        path.write_text(HEADER + ",host1,,,,NIC.Slot.3-1-1,,sw01,1,,,,\n,host1,,,,NIC.Slot.3-2-1,,sw01,2,,,,\n")
        os.utime(path, ns=(1, 1))
        assert wiring.version() != v1 and wiring.summary()["links"] == 2

    def test_no_files_configured(self):
        wiring = Wiring([])
        assert wiring.version() is None
        topo = _topology()
        assert wiring.apply(topo) is topo


class TestApi:
    @pytest.fixture
    def client(self, fleet, tmp_path):  # noqa: F811
        path = tmp_path / "wiring" / "h61.csv"
        path.parent.mkdir()
        path.write_text(
            HEADER
            # Redacted fixture MACs are all zero: these rows must match by FQDD and slot instead.
            + "2026-10-01T00:00:00Z,r750-a,eno12399np0,00:00:00:00:00:00,Integrated,NIC.Integrated.1-1-1,p0,"
            "leaf-sw01,ethernet1/1/1:3,up,306,confirmed,\n"
            + "2026-10-01T00:00:00Z,r750-a,ens6f0np0,,Slot 6,,p0,leaf-sw01,ethernet1/1/6,up,306,confirmed,\n"
            + ",r750-a,ens6f0np0,,Slot 6,,p0,leaf-sw09,ethernet1/1/9,,305,proposed,\n"
            + "2026-10-01T00:00:00Z,r750-a,eno8303,,Embedded,,p0,,,,,unresolved,not learned\n"
        )
        fleet.wiring_files = [str(tmp_path / "wiring" / "*.csv")]
        with TestClient(create_app(fleet), base_url="http://localhost:8080", client=LOCAL) as client:
            job = client.post("/api/servers/r750-a/refresh", headers=LOCAL_WRITE).json()
            _wait_jobs(client, job["id"])
            yield client

    def test_topology_has_peers(self, client):
        topo = client.get("/api/servers/r750-a").json()
        ports = {p["id"]: p for c in topo["components"] for p in (c["summary"].get("ports") or [])}
        assert ports["NIC.Integrated.1-1"]["peer"]["port"] == "ethernet1/1/1:3"
        assert ports["NIC.Integrated.1-1"]["peer"]["matched_by"] == "fqdd"
        assert ports["NIC.Slot.6-1"]["peer"]["switch"] == "leaf-sw01"  # observed beats the plan
        assert "peer" not in ports["NIC.Embedded.1-1"]
        # The store keeps the plain topology: wiring is applied on read.
        stored = client.app.state.store.get("r750-a")
        assert not any(p.get("peer") for c in stored["components"] for p in c["summary"].get("ports") or [])

    def test_rows_health_search_and_status(self, client):
        row = next(r for r in client.get("/api/servers").json()["servers"] if r["id"] == "r750-a")
        # Slot 6 port 1 is LinkDown but cabled; Integrated port 2 and Slot 6 port 2 are up with no peer.
        assert (row["cabled"], row["cabled_down"], row["unknown_peer"]) == (2, 1, 2)
        assert client.get("/api/health").json()["wiring"] is True
        hits = client.get("/api/search", params={"q": "ethernet1/1/1:3"}).json()["results"]
        assert hits[0]["id"] == "r750-a"
        assert hits[0]["matches"][0] == {
            "field": "switch",
            "value": "leaf-sw01 ethernet1/1/1:3",
            "component": "ocp:1",
            "slot_key": "ocp:1",
            "port": "NIC.Integrated.1-1",
        }
        status = client.get("/api/wiring").json()
        assert status == {"files": ["h61.csv"], "hosts": 1, "links": 3, "errors": {}}

    def test_without_wiring(self, fleet):  # noqa: F811
        with TestClient(create_app(fleet), base_url="http://localhost:8080", client=LOCAL) as client:
            assert client.get("/api/health").json()["wiring"] is False
            assert client.get("/api/wiring").json()["links"] == 0
