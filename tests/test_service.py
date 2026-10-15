"""Tests for the fleet viewer service: store, inventory, collector and HTTP API (service/)."""

import asyncio
import json
import os
import stat

import pytest
from starlette.testclient import TestClient

from conftest import make_mock_response, write_inventory
from lab3d.app import create_app
from lab3d.collector import Collector, classify_error
from lab3d.inventory import Inventory, InventoryError
from lab3d.settings import ViewerSettings, load_settings, parse_duration
from lab3d.store import Store, diff_topologies, fingerprints, split_raw

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
DENIED_IP = "10.0.0.66"
LOCAL = ("127.0.0.1", 50000)
LOCAL_WRITE = {"X-Viewer-Request": "1"}


def _routes(name: str) -> dict:
    with open(os.path.join(FIXTURES, name)) as f:
        data = json.load(f)

    def route(body):
        def respond(method, url, **kwargs):
            if DENIED_IP in str(url):
                return make_mock_response(401, {"error": "unauthorized"})
            return make_mock_response(200, body)

        return respond

    return {path: route(body) for path, body in data.items() if path.startswith("/")}


@pytest.fixture
def fleet(monkeypatch, mock_redfish_client, tmp_path):
    """Three configured hosts (r750, r750, one with bad credentials) backed by the captured R750 fixture."""
    servers = {
        "r750-a": {"bmc_ip": "10.0.0.1", "vendor": "dell", "tags": ["lab1", "rack-h61", "r750"]},
        "r750-b": {"bmc_ip": "10.0.0.2", "vendor": "dell", "tags": ["lab2", "rack-i61"]},
        "badauth": {"bmc_ip": DENIED_IP, "vendor": "dell", "tags": ["lab1"], "lab": "special"},
    }
    servers_file, secrets_file = write_inventory(
        tmp_path, servers, {h: {"username": "root", "password": "secret-pw"} for h in servers}
    )
    mock_redfish_client(_routes("dell_r750_captured.json"))
    return ViewerSettings(
        servers_file=servers_file,
        secrets_file=secrets_file,
        data_dir=str(tmp_path / "data"),
        static_dir=str(tmp_path / "no-dist"),
        lab_tags=["lab1", "lab2"],
        allowed_bmc_cidrs=["10.20.0.0/16"],
        refresh_min_interval=60,
    )


def _components(store: Store, host: str) -> dict:
    return {c["id"]: c for c in store.get(host)["components"]}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


class TestSettings:
    @pytest.mark.parametrize("value,seconds", [(30, 30), ("45", 45), ("5m", 300), ("12h", 43200), ("7d", 604800)])
    def test_parse_duration(self, value, seconds):
        assert parse_duration(value) == seconds

    def test_yaml_env_and_overrides(self, monkeypatch, tmp_path):
        cfg = tmp_path / "global.yaml"
        cfg.write_text(
            "viewer:\n  data_dir: store\n  max_age: 2d\n  allowed_bmc_cidrs: [10.1.0.0/16]\n"
            "  wiring_files: [wiring/*.csv, /abs/w.yaml]\n"
        )
        monkeypatch.setenv("LAB3D_CONFIG", str(cfg))
        monkeypatch.setenv("VIEWER_MAX_CONCURRENT_BMCS", "3")
        monkeypatch.setenv("VIEWER_OPEN_READS", "false")
        monkeypatch.setenv("VIEWER_API_TOKEN", "tok")
        s = load_settings({"port": 9000})
        assert s.data_dir == str(tmp_path / "store")
        assert s.max_age == 2 * 86400
        assert s.allowed_bmc_cidrs == ["10.1.0.0/16"]
        assert s.wiring_files == [str(tmp_path / "wiring" / "*.csv"), "/abs/w.yaml"]
        assert (s.max_concurrent_bmcs, s.open_reads, s.port, s.api_token) == (3, False, 9000, "tok")
        assert "tok" not in repr(s)
        # Inventory files default to the config file's directory.
        assert (s.servers_file, s.secrets_file) == (
            str(tmp_path / "redfish_servers.yaml"),
            str(tmp_path / "redfish_secrets.yaml"),
        )

    def test_top_level_keys_and_redfish_env_aliases(self, monkeypatch, tmp_path):
        cfg = tmp_path / "config.yaml"
        cfg.write_text("servers_file: inv/servers.yaml\nbmc_timeout: 30s\nverify_tls: true\n")
        monkeypatch.setenv("REDFISH_SECRETS", "creds.yaml")
        monkeypatch.chdir(tmp_path)
        s = load_settings(config_file=str(cfg))
        assert s.servers_file == str(tmp_path / "inv" / "servers.yaml")
        assert s.secrets_file == str(tmp_path / "creds.yaml")
        assert (s.bmc_timeout, s.verify_tls) == (30, True)

    def test_missing_explicit_config_is_an_error(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_settings(config_file=str(tmp_path / "nope.yaml"))

    def test_bad_cidr_rejected(self, monkeypatch, tmp_path):
        monkeypatch.setenv("VIEWER_ALLOWED_BMC_CIDRS", "not-a-network")
        with pytest.raises(ValueError):
            load_settings()


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


def _topology(serial="S1", dimm_serial="D1", rpm=5000, link="LinkUp", firmware="1.0", present=True):
    return {
        "schema_version": 1,
        "server_id": "h1",
        "captured_at": "2026-10-01T10:00:00+00:00",
        "system": {"vendor": "dell", "model": "PowerEdge R750", "serial": serial, "health": "OK", "bios": "1.2"},
        "chassis": {"model": "PowerEdge R750", "u_height": 2},
        "components": [
            {
                "id": "dimm:A1",
                "kind": "dimm",
                "slot_key": "dimm:A1",
                "slot_label": "A1",
                "present": present,
                "health": "OK",
                "name": "32GB",
                "summary": {"capacity_gib": 32},
                "raw": {"SerialNumber": dimm_serial, "Big": "x" * 100},
            },
            {
                "id": "fan:1",
                "kind": "fan",
                "slot_key": "fan:1",
                "slot_label": "Fan 1",
                "present": True,
                "health": "OK",
                "name": "Fan 1",
                "summary": {"rpm": [rpm]},
                "raw": {},
            },
            {
                "id": "pcie:1",
                "kind": "pcie",
                "slot_key": "pcie:1",
                "slot_label": "Slot 1",
                "present": True,
                "health": "OK",
                "name": "NIC",
                "raw": {},
                "summary": {
                    "firmware": firmware,
                    "ports": [{"id": "1", "link_status": link, "mac": "aa:bb:cc:00:11:22"}],
                },
            },
        ],
    }


class TestStore:
    def test_fingerprint_ignores_readings_but_not_parts(self):
        base = fingerprints(_topology())
        assert fingerprints(_topology(rpm=9000, link="LinkDown")) == base
        assert fingerprints(_topology(dimm_serial="D2"))[0] != base[0]
        assert fingerprints(_topology(present=False))[0] != base[0]
        fw = fingerprints(_topology(firmware="2.0"))
        assert fw[0] == base[0] and fw[1] != base[1]

    def test_split_raw_keeps_serial(self):
        lean, raw = split_raw(_topology())
        assert "raw" not in lean["components"][0]
        assert lean["components"][0]["serial"] == "D1"
        assert raw["dimm:A1"]["Big"] == "x" * 100
        assert fingerprints(lean) == fingerprints(_topology())

    async def test_history_only_on_change(self, tmp_path):
        store = Store(str(tmp_path))
        first = await store.save(_topology())
        assert first["history"] == "20261001T100000Z"
        topo = _topology(rpm=9999, link="LinkDown")
        topo["captured_at"] = "2026-10-02T10:00:00+00:00"
        assert (await store.save(topo))["history"] is None
        assert store.index()["h1"]["ports_up"] == 0
        assert store.index()["h1"]["changed_at"] == "2026-10-01T10:00:00+00:00"
        swapped = _topology(dimm_serial="D2", firmware="2.0")
        swapped["captured_at"] = "2026-10-03T10:00:00+00:00"
        row = await store.save(swapped)
        assert row["history"] == "20261003T100000Z"
        history = store.history("h1")
        assert [h["ts"] for h in history] == ["20261003T100000Z", "20261001T100000Z"]
        assert history[0]["reasons"] == ["hardware", "firmware"]
        diff = diff_topologies(store.history_snapshot("h1", "20261001T100000Z"), store.get("h1"))
        changed = {c["id"]: c["fields"] for c in diff["changed"]}
        assert changed["dimm:A1"]["serial"] == {"old": "D1", "new": "D2"}
        assert changed["pcie:1"]["firmware"] == {"old": "1.0", "new": "2.0"}
        assert "fan:1" not in changed

    async def test_raw_is_lazy_and_mergeable(self, tmp_path):
        store = Store(str(tmp_path))
        await store.save(_topology())
        assert "raw" not in store.get("h1")["components"][0]
        assert store.get("h1", with_raw=True)["components"][0]["raw"]["SerialNumber"] == "D1"

    async def test_error_keeps_previous_data(self, tmp_path):
        store = Store(str(tmp_path))
        await store.save(_topology())
        row = await store.record_error("h1", "unreachable", "no route")
        assert row["captured_at"] and row["last_error"]["kind"] == "unreachable"
        assert store.get("h1") is not None
        # A successful collection clears the error.
        assert (await store.save(_topology()))["last_error"] is None

    @pytest.mark.parametrize("bad", ["../etc", "a/b", "", "x.raw", ".hidden"])
    def test_rejects_unsafe_ids(self, tmp_path, bad):
        with pytest.raises(ValueError):
            Store(str(tmp_path)).host_path(bad)


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------


class TestInventory:
    def test_lab_and_rack_from_tags(self, fleet):
        hosts = Inventory(fleet).hosts()
        assert (hosts["r750-a"]["lab"], hosts["r750-a"]["rack"]) == ("lab1", "h61")
        assert hosts["r750-b"]["lab"] == "lab2"
        assert hosts["badauth"]["lab"] == "special"  # explicit lab key wins

    def test_lab_pattern(self, fleet):
        fleet.lab_tags = []
        fleet.lab_tag_pattern = r"^(lab[13])$"
        hosts = Inventory(fleet).hosts()
        assert hosts["r750-a"]["lab"] == "lab1"
        assert hosts["r750-b"]["lab"] is None

    @pytest.mark.parametrize(
        "ip,status",
        [("10.20.1.5", None), ("10.30.1.5", 403), ("bmc.example.com", 400), ("127.0.0.1", 403)],
    )
    def test_adhoc_target_allowlist(self, fleet, ip, status):
        inv = Inventory(fleet)
        if status is None:
            assert inv.add("new", ip, "root", "pw")["source"] == "adhoc"
        else:
            with pytest.raises(InventoryError) as err:
                inv.add("new", ip, "root", "pw")
            assert err.value.status == status

    def test_adhoc_disabled_without_cidrs(self, fleet):
        fleet.allowed_bmc_cidrs = []
        with pytest.raises(InventoryError) as err:
            Inventory(fleet).add("new", "10.20.1.5", "root", "pw")
        assert err.value.status == 403

    def test_adhoc_cannot_shadow_configured_host(self, fleet):
        with pytest.raises(InventoryError) as err:
            Inventory(fleet).add("r750-a", "10.20.1.5", "root", "pw")
        assert err.value.status == 409

    def test_remembered_adhoc_persisted_private(self, fleet):
        Inventory(fleet).add("kept", "10.20.1.5", "root", "pw", remember=True, tags=["x"])
        Inventory(fleet).add("temp", "10.20.1.6", "root", "pw")
        secrets = os.path.join(fleet.data_dir, "adhoc", "secrets.yaml")
        assert stat.S_IMODE(os.stat(secrets).st_mode) == 0o600
        assert "temp" not in open(secrets).read()
        reloaded = Inventory(fleet)
        assert "kept" in reloaded and "temp" not in reloaded
        reloaded.remove("kept")
        assert "kept" not in open(secrets).read()


# ---------------------------------------------------------------------------
# Collector
# ---------------------------------------------------------------------------


class TestCollector:
    def _collector(self, settings):
        return Collector(Store(settings.data_dir), Inventory(settings), settings)

    async def test_job_isolates_failures(self, fleet):
        collector = self._collector(fleet)
        job = await collector.wait(collector.submit(["r750-a", "badauth", "r750-b"]))
        summary = job.to_dict()
        assert (summary["state"], summary["succeeded"], summary["failed"]) == ("done", 2, 1)
        assert summary["hosts"]["badauth"]["kind"] == "auth"
        index = collector.store.index()
        assert index["r750-a"]["model"] == "PowerEdge R750"
        assert index["badauth"]["last_error"]["kind"] == "auth"
        assert DENIED_IP not in json.dumps(index)
        assert _components(collector.store, "r750-a")["pcie:6"]["name"] == "MLNX 100GbE 2P ConnectX6 Adpt"

    async def test_same_host_collected_once(self, fleet):
        collector = self._collector(fleet)
        jobs = [collector.submit(["r750-a"]), collector.submit(["r750-a", "r750-b"])]
        assert collector.is_busy("r750-a")
        await asyncio.gather(*[collector.wait(j) for j in jobs])
        assert len(collector.store.history("r750-a")) == 1
        assert not collector.is_busy("r750-a")

    async def test_bmc_request_limit(self, fleet, monkeypatch):
        from lab3d import redfish

        in_flight, peak = 0, 0
        real = redfish.http_client()
        original = real.get

        async def counting(url, **kwargs):
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.001)
            in_flight -= 1
            return await original(url, **kwargs)

        real.get = counting
        fleet.max_requests_per_bmc = 2
        fleet.max_concurrent_bmcs = 1
        collector = self._collector(fleet)
        await collector.wait(collector.submit(["r750-a"]))
        assert peak == 2

    async def test_timeout_recorded(self, fleet, monkeypatch):
        async def slow(_host):
            await asyncio.sleep(1)

        monkeypatch.setattr("lab3d.collector.collect_topology", slow)
        fleet.host_timeout = 0.01
        collector = self._collector(fleet)
        job = await collector.wait(collector.submit(["r750-a"]))
        assert job.results["r750-a"]["kind"] == "timeout"

    async def test_stale_hosts(self, fleet):
        collector = self._collector(fleet)
        assert sorted(collector.stale_hosts()) == ["badauth", "r750-a", "r750-b"]
        await collector.wait(collector.submit(["r750-a", "badauth"]))
        # Fresh hosts and recently failed hosts are skipped.
        assert collector.stale_hosts() == ["r750-b"]
        assert sorted(collector.stale_hosts(max_age=0)) == ["r750-a", "r750-b"]

    def test_classify_error_strips_addresses(self):
        err = classify_error(RuntimeError("Client error '401 Unauthorized' for url 'https://10.1.2.3/redfish/v1'"))
        assert err["kind"] == "auth"
        assert "10.1.2.3" not in err["message"]
        assert classify_error(RuntimeError("[Errno 113] No route to host 10.9.9.9"))["kind"] == "unreachable"
        assert classify_error(asyncio.TimeoutError())["kind"] == "timeout"

    def test_classify_vendor_detection_failures_by_cause(self):
        import httpx

        def wrapped(cause):
            try:
                try:
                    raise cause
                except (httpx.HTTPError, ValueError):
                    raise ConnectionError("Could not auto-detect vendor for 10.1.2.3")
            except ConnectionError as e:
                return classify_error(e, "10.1.2.3")

        unreachable = wrapped(httpx.ConnectError("All connection attempts failed"))
        assert unreachable["kind"] == "unreachable"
        assert "10.1.2.3" not in unreachable["message"]
        assert wrapped(httpx.ReadTimeout(""))["kind"] == "timeout"
        assert wrapped(ValueError("Unknown vendor in OEM data"))["kind"] == "unsupported"


# ---------------------------------------------------------------------------
# HTTP API
# ---------------------------------------------------------------------------


def _wait_jobs(client: TestClient, job_id: str) -> dict:
    for _ in range(200):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["state"] == "done":
            return job
        import time

        time.sleep(0.01)
    raise AssertionError("job did not finish")


@pytest.fixture
def api(fleet):
    with TestClient(create_app(fleet), base_url="http://localhost:8080", client=LOCAL) as client:
        yield client


class TestApi:
    def test_list_before_collection(self, api):
        body = api.get("/api/servers").json()
        assert body["summary"]["hosts"] == 3
        assert {s["state"] for s in body["servers"]} == {"pending"}
        assert body["facets"]["lab"] == {"lab1": 1, "lab2": 1, "special": 1}
        assert all("bmc_ip" not in s for s in body["servers"])
        assert api.get("/api/servers/r750-a").status_code == 404
        assert api.get("/api/servers/nope").status_code == 404

    def test_refresh_then_read(self, api):
        resp = api.post("/api/servers/r750-a/refresh", headers=LOCAL_WRITE)
        assert resp.status_code == 202
        job = _wait_jobs(api, resp.json()["id"])
        assert job["hosts"]["r750-a"]["status"] == "success"

        topo = api.get("/api/servers/r750-a").json()
        assert topo["system"]["model"] == "PowerEdge R750"
        assert "raw" not in topo["components"][0]
        assert "raw" in api.get("/api/servers/r750-a?raw=1").json()["components"][0]
        cid = topo["components"][0]["id"]
        assert isinstance(api.get(f"/api/servers/r750-a/raw?component={cid}").json(), dict)

        rows = {s["id"]: s for s in api.get("/api/servers").json()["servers"]}
        assert rows["r750-a"]["state"] == "ok"
        assert rows["r750-a"]["layout"] == "dell-r750"
        assert rows["r750-a"]["counts"]["dimm"]["present"] == 16

        # Compatibility routes for the static viewer.
        assert api.get("/topology/index.json").json() == {"servers": [{"id": "r750-a", "model": "PowerEdge R750"}]}
        assert "raw" in api.get("/topology/r750-a.json").json()["components"][0]

        history = api.get("/api/servers/r750-a/history").json()["history"]
        assert history[0]["reasons"] == ["first"]
        diff = api.get(f"/api/servers/r750-a/history/{history[0]['ts']}/diff").json()
        assert diff["added"] == diff["removed"] == diff["changed"] == []

    def test_refresh_rate_limited(self, api):
        first = api.post("/api/servers/r750-b/refresh", headers=LOCAL_WRITE)
        _wait_jobs(api, first.json()["id"])
        second = api.post("/api/servers/r750-b/refresh", headers=LOCAL_WRITE)
        assert second.status_code == 429
        assert int(second.headers["retry-after"]) > 0

    def test_filters_and_bulk_refresh(self, api):
        resp = api.post("/api/refresh", json={"lab": "lab1"}, headers=LOCAL_WRITE)
        assert resp.status_code == 202
        job = _wait_jobs(api, resp.json()["id"])
        assert job["hosts"] == {"r750-a": {**job["hosts"]["r750-a"], "status": "success"}}
        rows = api.get("/api/servers?lab=lab1").json()["servers"]
        assert [r["id"] for r in rows] == ["r750-a"]
        assert api.get("/api/servers?tag=rack-i61").json()["servers"][0]["id"] == "r750-b"
        assert api.post("/api/refresh", json={"lab": "nowhere"}, headers=LOCAL_WRITE).status_code == 404

    def test_error_state(self, api):
        _wait_jobs(api, api.post("/api/servers/badauth/refresh", headers=LOCAL_WRITE).json()["id"])
        row = api.get("/api/servers?state=error").json()["servers"][0]
        assert row["id"] == "badauth"
        assert row["last_error"]["kind"] == "auth"

    def test_search(self, api):
        _wait_jobs(api, api.post("/api/servers/r750-a/refresh", headers=LOCAL_WRITE).json()["id"])
        body = api.get("/api/search", params={"q": "connectx6"}).json()
        assert body["results"][0]["id"] == "r750-a"
        assert any(m.get("slot_key") == "pcie:6" for m in body["results"][0]["matches"])
        assert api.get("/api/search", params={"q": "rack-i61"}).json()["results"][0]["id"] == "r750-b"
        assert api.get("/api/search", params={"q": "x"}).status_code == 400

    def test_coverage(self, api):
        _wait_jobs(api, api.post("/api/servers/r750-a/refresh", headers=LOCAL_WRITE).json()["id"])
        models = api.get("/api/coverage").json()["models"]
        assert models == [
            {"model": "PowerEdge R750", "vendor": "dell", "layout": "dell-r750", "hosts": ["r750-a"], "count": 1}
        ]

    def test_add_and_remove_adhoc(self, api, fleet):
        body = {"name": "guest", "bmc_ip": "10.20.3.4", "username": "root", "password": "pw", "lab": "lab3"}
        resp = api.post("/api/servers", json=body, headers=LOCAL_WRITE)
        assert resp.status_code == 202
        assert "password" not in resp.text
        _wait_jobs(api, resp.json()["job"]["id"])
        row = {s["id"]: s for s in api.get("/api/servers").json()["servers"]}["guest"]
        assert (row["source"], row["lab"], row["state"]) == ("adhoc", "lab3", "ok")
        assert api.post("/api/servers", json={**body, "bmc_ip": "8.8.8.8"}, headers=LOCAL_WRITE).status_code == 403
        assert api.delete("/api/servers/r750-a", headers=LOCAL_WRITE).status_code == 409
        assert api.delete("/api/servers/guest", headers=LOCAL_WRITE).status_code == 204
        assert "guest" not in {s["id"] for s in api.get("/api/servers").json()["servers"]}


class TestApiAuth:
    def test_local_writes_need_header(self, api):
        assert api.post("/api/servers/r750-a/refresh").status_code == 403

    def test_remote_writes_refused_without_token(self, fleet):
        with TestClient(create_app(fleet), client=("192.0.2.10", 1234)) as client:
            assert client.get("/api/servers").status_code == 200
            assert client.post("/api/servers/r750-a/refresh", headers=LOCAL_WRITE).status_code == 403

    def test_token_required_when_configured(self, fleet):
        fleet.api_token = "s3cret"
        with TestClient(create_app(fleet), client=("192.0.2.10", 1234)) as client:
            assert client.post("/api/servers/r750-a/refresh", headers=LOCAL_WRITE).status_code == 401
            bad = {"Authorization": "Bearer nope"}
            assert client.post("/api/servers/r750-a/refresh", headers=bad).status_code == 401
            ok = client.post("/api/servers/r750-a/refresh", headers={"Authorization": "Bearer s3cret"})
            assert ok.status_code == 202
            assert ok.json()["requested_by"] == "token"
            # Cookies are accepted for reads only (no CSRF on writes).
            client.cookies.set("viewer_token", "s3cret")
            assert client.post("/api/servers/r750-b/refresh").status_code == 401

    def test_closed_reads(self, fleet):
        fleet.api_token = "s3cret"
        fleet.open_reads = False
        with TestClient(create_app(fleet), client=("192.0.2.10", 1234)) as client:
            assert client.get("/api/servers").status_code == 401
            assert client.get("/api/servers", headers={"Authorization": "Bearer s3cret"}).status_code == 200
            client.cookies.set("viewer_token", "s3cret")
            assert client.get("/topology/index.json").status_code == 200
            assert client.get("/api/health").status_code == 200

    def test_static_viewer_served(self, fleet, tmp_path):
        dist = tmp_path / "dist"
        dist.mkdir()
        (dist / "index.html").write_text("<html>viewer</html>")
        fleet.static_dir = str(dist)
        with TestClient(create_app(fleet), base_url="http://localhost:8080", client=LOCAL) as client:
            assert "viewer" in client.get("/").text
            assert client.get("/api/health").json()["status"] == "ok"


# ---------------------------------------------------------------------------
# Review fixes
# ---------------------------------------------------------------------------


class TestIncompleteCollection:
    async def test_partial_answer_keeps_previous_data(self, fleet, monkeypatch):
        import lab3d.collector as collector_mod

        collector = Collector(Store(fleet.data_dir), Inventory(fleet), fleet)
        await collector.wait(collector.submit(["r750-a"]))
        before = collector.store.get("r750-a")
        real = collector_mod.collect_topology

        async def without_dimms(host_id):
            topo = await real(host_id)
            topo["components"] = [c for c in topo["components"] if c["kind"] != "dimm"]
            return topo

        monkeypatch.setattr(collector_mod, "collect_topology", without_dimms)
        job = await collector.wait(collector.submit(["r750-a"]))
        assert job.results["r750-a"]["kind"] == "incomplete"
        assert "dimm" in job.results["r750-a"]["message"]
        assert collector.store.get("r750-a") == before
        assert len(collector.store.history("r750-a")) == 1

        job = await collector.wait(collector.submit(["r750-a"], force=True))
        assert job.results["r750-a"]["status"] == "success"
        assert collector.store.history("r750-a")[0]["reasons"] == ["hardware"]

    def test_bmc_hostname_stripped_from_errors(self):
        err = classify_error(RuntimeError("Name or service not known: idrac-7.lab.example"), "idrac-7.lab.example")
        assert err["kind"] == "unreachable"
        assert "idrac-7" not in err["message"]

    def test_network_word_is_not_unreachable(self):
        assert classify_error(RuntimeError("bad NetworkAdapters payload"))["kind"] == "error"


class TestReviewFixes:
    def test_dns_rebinding_host_refused(self, fleet):
        with TestClient(create_app(fleet), base_url="http://evil.example:8080", client=LOCAL) as client:
            assert client.get("/api/servers").status_code == 403
            assert client.post("/api/servers/r750-a/refresh", headers=LOCAL_WRITE).status_code == 403
        fleet.allowed_hosts = ["viewer.internal"]
        with TestClient(create_app(fleet), base_url="http://viewer.internal", client=LOCAL) as client:
            assert client.get("/api/servers").status_code == 200
        # Remote clients are not subject to the local Host check.
        with TestClient(create_app(fleet), base_url="http://anything", client=("192.0.2.10", 1)) as client:
            assert client.get("/api/servers").status_code == 200

    def test_non_ascii_token_is_401_not_500(self, fleet):
        fleet.api_token = "s3cret"
        with TestClient(create_app(fleet), client=("192.0.2.10", 1)) as client:
            resp = client.post("/api/servers/r750-a/refresh", headers={"Authorization": "Bearer café".encode()})
            assert resp.status_code == 401

    def test_bulk_ids_list_and_recent_message(self, api):
        job = api.post("/api/refresh", json={"ids": ["r750-a", "r750-b"]}, headers=LOCAL_WRITE).json()
        assert job["total"] == 2
        _wait_jobs(api, job["id"])
        again = api.post("/api/refresh", json={"ids": ["r750-a"]}, headers=LOCAL_WRITE)
        assert again.status_code == 409
        assert "refreshed recently" in again.json()["error"]

    def test_remove_busy_adhoc_refused(self, api, monkeypatch):
        import lab3d.collector as collector_mod

        real = collector_mod.collect_topology

        async def slow(host_id):
            await asyncio.sleep(0.3)
            return await real(host_id)

        monkeypatch.setattr(collector_mod, "collect_topology", slow)
        body = {"name": "guest", "bmc_ip": "10.20.3.4", "username": "root", "password": "pw"}
        job = api.post("/api/servers", json=body, headers=LOCAL_WRITE).json()["job"]
        assert api.delete("/api/servers/guest", headers=LOCAL_WRITE).status_code == 409
        _wait_jobs(api, job["id"])
        assert api.delete("/api/servers/guest", headers=LOCAL_WRITE).status_code == 204

    def test_search_limit_validated(self, api):
        assert api.get("/api/search", params={"q": "r750", "limit": "abc"}).status_code == 400
        assert api.get("/api/search", params={"q": "r750", "limit": "-5"}).json()["hosts"] == 1

    def test_ipv6_target_bracketed(self, fleet):
        fleet.allowed_bmc_cidrs = ["fd00::/8"]
        inv = Inventory(fleet)
        inv.add("v6", "fd00::10", "root", "pw")
        assert inv.servers["v6"]["bmc_ip"] == "[fd00::10]"
        assert inv.client("v6").address == "[fd00::10]"

    def test_readd_without_remember_forgets_credentials(self, fleet):
        inv = Inventory(fleet)
        inv.add("kept", "10.20.1.5", "root", "pw", remember=True)
        inv.add("kept", "10.20.1.5", "root", "pw2")
        assert "kept" not in open(os.path.join(fleet.data_dir, "adhoc", "secrets.yaml")).read()

    def test_remembered_host_outside_new_allowlist_skipped(self, fleet):
        Inventory(fleet).add("kept", "10.20.1.5", "root", "pw", remember=True)
        fleet.allowed_bmc_cidrs = ["10.99.0.0/16"]
        assert "kept" not in Inventory(fleet)

    def test_cli_and_env_paths_relative_to_cwd(self, monkeypatch, tmp_path):
        cfg_dir = tmp_path / "cfg"
        cfg_dir.mkdir()
        (cfg_dir / "global.yaml").write_text("viewer:\n  data_dir: from-yaml\n  static_dir: dist\n")
        monkeypatch.setenv("LAB3D_CONFIG", str(cfg_dir / "global.yaml"))
        monkeypatch.chdir(tmp_path)
        s = load_settings({"data_dir": "cli-dir"})
        assert s.data_dir == str(tmp_path / "cli-dir")
        assert s.static_dir == str(cfg_dir / "dist")

    async def test_store_shared_between_instances(self, tmp_path):
        a, b = Store(str(tmp_path)), Store(str(tmp_path))
        t1, t2 = _topology(), _topology()
        t2["server_id"] = "h2"
        await asyncio.gather(a.save(t1), b.save(t2))
        assert sorted(Store(str(tmp_path)).index()) == ["h1", "h2"]
