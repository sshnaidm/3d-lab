#!/usr/bin/env python3
"""
Fleet inventory: hosts from the servers file plus ad-hoc hosts added by BMC IP and credentials.

The servers and secrets files use the baremetal-mcp formats: ``{servers: {<id>: {bmc_ip, vendor?, tags?,
lab?, rack?, description?}}}`` (or the mapping at the top level) and ``{<id>: {username, password}}``.
Ad-hoc hosts with ``remember=True`` are persisted under ``<data_dir>/adhoc/`` (mode 0600); otherwise they
live in memory until the service restarts. Credentials never leave this module except inside a client.
"""

import ipaddress
import logging
import os
import re
from typing import Dict, List, Optional, Type

import yaml

from lab3d.redfish import VENDORS, BMCClient, HttpOptions
from lab3d.settings import ViewerSettings
from lab3d.store import HOST_ID_RE

logger = logging.getLogger("viewer.inventory")

_ADHOC_SERVERS = "servers.yaml"
_ADHOC_SECRETS = "secrets.yaml"


class InventoryError(ValueError):
    """Rejected ad-hoc registration; ``status`` is the HTTP status to report."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class Inventory:
    def __init__(self, settings: ViewerSettings):
        self.settings = settings
        self._lab_re = re.compile(settings.lab_tag_pattern) if settings.lab_tag_pattern else None
        self._rack_re = re.compile(settings.rack_tag_pattern) if settings.rack_tag_pattern else None
        self.adhoc: Dict[str, Dict] = {}
        self._adhoc_dir = os.path.join(settings.data_dir, "adhoc")
        self._http = HttpOptions(settings.bmc_timeout, settings.bmc_retries, verify_tls=settings.verify_tls)
        self.servers: Dict[str, Dict] = _read_servers(settings.servers_file)
        self._secrets: Dict[str, Dict] = _read_yaml(settings.secrets_file, "secrets")
        self._clients: Dict[str, BMCClient] = {}
        self._configured = set(self.servers)
        self._load_adhoc()

    # -- host metadata -------------------------------------------------------

    def _lab(self, entry: Dict, tags: List[str]) -> Optional[str]:
        if entry.get("lab"):
            return str(entry["lab"])
        for tag in tags:
            if tag in self.settings.lab_tags:
                return tag
        if self._lab_re:
            for tag in tags:
                m = self._lab_re.match(tag)
                if m:
                    return m.group(1) if m.groups() else tag
        return None

    def _rack(self, entry: Dict, tags: List[str]) -> Optional[str]:
        if entry.get("rack"):
            return str(entry["rack"])
        if self._rack_re:
            for tag in tags:
                m = self._rack_re.match(tag)
                if m:
                    return m.group(1) if m.groups() else tag
        return None

    def meta(self, host_id: str) -> Optional[Dict]:
        entry = self.servers.get(host_id)
        if entry is None:
            return None
        tags = [str(t) for t in entry.get("tags") or []]
        return {
            "id": host_id,
            "lab": self._lab(entry, tags),
            "rack": self._rack(entry, tags),
            "tags": tags,
            "description": entry.get("description"),
            "vendor_hint": (entry.get("vendor") or "").lower() or None,
            "source": "adhoc" if host_id in self.adhoc else "config",
        }

    def hosts(self) -> Dict[str, Dict]:
        return {host_id: self.meta(host_id) for host_id in sorted(self.servers)}

    def __contains__(self, host_id: str) -> bool:
        return host_id in self.servers

    def bmc_address(self, host_id: str) -> Optional[str]:
        return str((self.servers.get(host_id) or {}).get("bmc_ip") or "") or None

    def client(self, host_id: str, cls: Type[BMCClient] = BMCClient) -> BMCClient:
        """A GET-only client for one host; it keeps the detected vendor between collections."""
        client = self._clients.get(host_id) if cls is BMCClient else None
        if client is None:
            entry = self.servers.get(host_id)
            if entry is None:
                raise ValueError(f"Server '{host_id}' not found in configuration.")
            if not entry.get("bmc_ip"):
                raise ValueError(f"Server '{host_id}' has no bmc_ip in configuration.")
            creds = self._secrets.get(host_id) or {}
            client = cls(
                host_id,
                str(entry["bmc_ip"]),
                creds.get("username"),
                creds.get("password"),
                entry.get("vendor"),
                self._http,
            )
            if cls is BMCClient:
                self._clients[host_id] = client
        return client

    # -- ad-hoc hosts --------------------------------------------------------

    def check_target(self, bmc_ip: str) -> str:
        """Only IP literals inside allowed_bmc_cidrs may be added ad hoc (no hostnames, no DNS games)."""
        networks = self.settings.networks()
        if not networks:
            raise InventoryError("Adding servers by IP is disabled (viewer.allowed_bmc_cidrs is empty)", 403)
        try:
            addr = ipaddress.ip_address(str(bmc_ip).strip())
        except ValueError:
            raise InventoryError("bmc_ip must be an IPv4 or IPv6 address") from None
        if not any(addr in net for net in networks):
            raise InventoryError("bmc_ip is outside the allowed BMC networks", 403)
        return f"[{addr}]" if addr.version == 6 else str(addr)  # used verbatim in https://<bmc_ip>/

    def add(
        self,
        name: str,
        bmc_ip: str,
        username: str,
        password: str,
        vendor: Optional[str] = None,
        lab: Optional[str] = None,
        rack: Optional[str] = None,
        tags: Optional[List[str]] = None,
        remember: bool = False,
    ) -> Dict:
        if not HOST_ID_RE.match(name or ""):
            raise InventoryError("name must be 1-128 characters of letters, digits, '.', '_' or '-'")
        if name in self._configured:
            raise InventoryError(f"'{name}' is already defined in the server configuration", 409)
        if not username or not password:
            raise InventoryError("username and password are required")
        if vendor and vendor.lower() not in VENDORS:
            raise InventoryError(f"vendor must be one of: {', '.join(sorted(VENDORS))}")
        entry = {
            "bmc_ip": self.check_target(bmc_ip),
            "tags": [str(t) for t in tags or []],
            "adhoc": True,
        }
        if vendor:
            entry["vendor"] = vendor.lower()
        if lab:
            entry["lab"] = str(lab)
        if rack:
            entry["rack"] = str(rack)
        was_remembered = (self.adhoc.get(name) or {}).get("remember", False)
        self._register(name, entry, {"username": username, "password": password}, remember)
        if remember or was_remembered:  # also drops old remembered credentials when re-added without remember
            self._save_adhoc()
        return self.meta(name)

    def remove(self, host_id: str) -> None:
        if host_id not in self.adhoc:
            raise InventoryError(f"'{host_id}' is not an ad-hoc server", 404 if host_id not in self.servers else 409)
        remembered = self.adhoc.pop(host_id)["remember"]
        self.servers.pop(host_id, None)
        self._secrets.pop(host_id, None)
        self._clients.pop(host_id, None)
        if remembered:
            self._save_adhoc()

    def _register(self, name: str, entry: Dict, creds: Dict, remember: bool) -> None:
        self.servers[name] = entry
        self._secrets[name] = creds
        self._clients.pop(name, None)  # credentials may have changed
        self.adhoc[name] = {"remember": remember}

    def _load_adhoc(self) -> None:
        servers = _read_yaml(os.path.join(self._adhoc_dir, _ADHOC_SERVERS))
        secrets = _read_yaml(os.path.join(self._adhoc_dir, _ADHOC_SECRETS))
        for name, entry in servers.items():
            if name in self._configured or not isinstance(entry, dict) or name not in secrets:
                continue
            try:  # the allowlist may have been narrowed since the host was remembered
                self.check_target(str(entry.get("bmc_ip") or "").strip("[]"))
            except InventoryError as e:
                logger.warning("Skipping remembered ad-hoc server %s: %s", name, e)
                continue
            self._register(name, entry, secrets[name], remember=True)

    def _save_adhoc(self) -> None:
        names = [n for n, a in self.adhoc.items() if a["remember"]]
        _write_private_yaml(os.path.join(self._adhoc_dir, _ADHOC_SERVERS), {n: self.servers[n] for n in names})
        _write_private_yaml(os.path.join(self._adhoc_dir, _ADHOC_SECRETS), {n: self._secrets[n] for n in names})


def _read_yaml(path: str, what: str = "file") -> Dict:
    if not os.path.exists(path):
        if what != "file":
            logger.warning("%s file not found: %s; continuing without it", what.capitalize(), path)
        return {}
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        logger.warning("Invalid format in %s: expected a mapping", path)
        return {}
    return data


def _read_servers(path: str) -> Dict[str, Dict]:
    data = _read_yaml(path, "servers")
    section = data.get("servers", {k: v for k, v in data.items() if k != "switches"})
    if not isinstance(section, dict):
        logger.warning("Invalid format in %s: expected a mapping for servers", path)
        return {}
    return {str(k): dict(v) for k, v in section.items() if isinstance(v, dict)}


def _write_private_yaml(path: str, data: Dict) -> None:
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        yaml.safe_dump(data, f, sort_keys=True)
    os.replace(tmp, path)
