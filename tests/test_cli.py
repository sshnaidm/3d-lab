"""Tests for the command line (collect, capture, export)."""

import json
import os
import re
import sys

import pytest

from conftest import make_mock_response, write_inventory
from lab3d import cli
from lab3d.store import Store

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


@pytest.fixture
def configured(tmp_path, mock_redfish_client):
    with open(os.path.join(FIXTURES, "dell_r750_captured.json")) as f:
        routes = {p: make_mock_response(200, b) for p, b in json.load(f).items() if p.startswith("/")}
    mock_redfish_client(routes)
    servers, secrets = write_inventory(
        tmp_path,
        {
            "a": {"bmc_ip": "10.0.0.1", "vendor": "dell", "tags": ["lab1"]},
            "b": {"bmc_ip": "10.0.0.2", "vendor": "dell", "tags": ["lab2"]},
        },
        {"a": {"username": "root", "password": "pw"}, "b": {"username": "root", "password": "pw"}},
    )
    config = tmp_path / "config.yaml"
    config.write_text(f"servers_file: {servers}\nsecrets_file: {secrets}\ndata_dir: data\nlab_tags: [lab1, lab2]\n")
    return str(config)


def test_collect_into_store(configured, tmp_path):
    assert cli.collect_main(["--config", configured, "--lab", "lab1"]) == 0
    assert list(Store(str(tmp_path / "data")).index()) == ["a"]


def test_collect_dry_run_needs_selection(configured, capsys):
    assert cli.collect_main(["--config", configured, "--all", "--dry-run"]) == 0
    assert capsys.readouterr().out.split() == ["a", "b"]
    with pytest.raises(SystemExit):
        cli.collect_main(["--config", configured])


def test_capture_is_redacted(configured, tmp_path):
    out = tmp_path / "capture.json"
    assert cli.capture_main(["a", "--config", configured, "-o", str(out)]) == 0
    text = out.read_text()
    responses = json.loads(text)
    assert "/redfish/v1/Systems/System.Embedded.1" in responses
    assert '"SerialNumber": "REDACTED"' in text
    assert not re.search(r'"SerialNumber": "(?!REDACTED)', text)


def test_redact_dell_identifiers():
    raw = {
        "/redfish/v1/Systems/System.Embedded.1": {
            "SKU": "ABC1234",
            "Oem": {"Dell": {"DellSystem": {"ChassisServiceTag": "ABC1234", "ExpressServiceCode": "12345678901"}}},
            "Description": "Node ABC1234 at 10.1.2.3",
            "Links": {"Other": "ABC1234"},
        },
        "/redfish/v1/Chassis/System.Embedded.1/PCIeDevices/1": {
            "PartNumber": "TW-0C9X5T-ABCDE-14Q-02QI-A00",
            "MACAddress": "b4:96:91:12:34:56",
        },
        "/redfish/v1/Systems/System.Embedded.1/Storage/Disk.1": {"DurableName": "5000C500ABCDEF01"},
    }
    text = json.dumps(cli._redact(raw))
    for secret in ("ABC1234", "12345678901", "ABCDE", "02QI", "12:34:56", "10.1.2.3", "ABCDEF01"):
        assert secret not in text
    assert "XX-0C9X5T-00000-000-0000-A00" in text  # part number and revision are kept


def test_export_replay(tmp_path):
    out = tmp_path / "static"
    replay = os.path.join(FIXTURES, "dell_r650_captured.json")
    assert cli.export_main(["--replay", replay, "sample-r650", "-o", str(out)]) == 0
    assert json.loads((out / "sample-r650.json").read_text())["system"]["model"] == "PowerEdge R650"


def test_dispatch_defaults_to_serve(monkeypatch):
    seen = []
    monkeypatch.setattr("lab3d.app.main", lambda: seen.append(sys.argv[1:]))
    cli.main(["--port", "9"])
    cli.main(["serve", "--bind", "0.0.0.0"])
    assert seen == [["--port", "9"], ["--bind", "0.0.0.0"]]
