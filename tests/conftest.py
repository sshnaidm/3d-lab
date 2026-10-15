"""Shared fixtures: a fake BMC HTTP client and inventory files."""

import json
from unittest.mock import MagicMock

import httpx
import pytest
import yaml


def make_mock_response(status_code=200, json_data=None, content=b"", headers=None):
    """Build a fake httpx.Response."""
    if json_data is not None:
        body = json.dumps(json_data).encode()
        content_type = "application/json"
    else:
        body = content
        content_type = "application/octet-stream"
    resp_headers = {"content-type": content_type}
    if headers:
        resp_headers.update(headers)
    return httpx.Response(
        status_code=status_code,
        headers=resp_headers,
        content=body,
        request=httpx.Request("GET", "https://fake"),
    )


def write_inventory(directory, servers: dict, secrets: dict):
    """Write servers/secrets YAML files (baremetal-mcp format) and return their paths."""
    servers_file, secrets_file = directory / "servers.yaml", directory / "secrets.yaml"
    servers_file.write_text(yaml.safe_dump({"servers": servers}))
    secrets_file.write_text(yaml.safe_dump(secrets))
    return str(servers_file), str(secrets_file)


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """Fresh HTTP client per test; no config file or VIEWER_* settings leak in from the environment."""
    import lab3d.redfish as redfish

    redfish._http = None
    monkeypatch.setattr("lab3d.settings.DEFAULT_CONFIG", str(tmp_path / "absent-config.yaml"))
    for name in ("LAB3D_CONFIG", "REDFISH_CONFIG", "REDFISH_SECRETS", "VIEWER_API_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    yield
    redfish._http = None


@pytest.fixture
def mock_redfish_client(monkeypatch):
    """Return a setup function that answers BMC GETs from a ``{path substring: response}`` map.

    A value may be an ``httpx.Response`` or a callable ``(method, url, **kwargs) -> httpx.Response``.
    Only ``get`` exists on the fake client, so any other HTTP method fails the test.
    """

    def _setup(route_map: dict):
        def _resolve(method, url, **kwargs):
            url_str = str(url)
            for pattern in sorted(route_map.keys(), key=len, reverse=True):
                if pattern in url_str:
                    resp = route_map[pattern]
                    if callable(resp) and not isinstance(resp, httpx.Response):
                        return resp(method, url, **kwargs)
                    return resp
            return make_mock_response(404, {"error": {"message": f"Not Found: {url_str}"}})

        mock_client = MagicMock(spec=["get"])

        async def _async_get(url, **kwargs):
            return _resolve("GET", url, **kwargs)

        mock_client.get = _async_get
        monkeypatch.setattr("lab3d.redfish.http_client", lambda *a, **k: mock_client)
        return mock_client

    return _setup
