#!/usr/bin/env python3
"""
Settings: a YAML file (``--config`` or ``LAB3D_CONFIG``, default ``config.yaml`` when present),
overridden by ``VIEWER_<KEY>`` env vars (``REDFISH_CONFIG`` / ``REDFISH_SECRETS`` also work), overridden by
command-line options.

Keys may sit at the top level of the file or under a ``viewer:`` section, so the ``global_config.yaml`` of
baremetal-mcp works unchanged. Relative paths in the file are relative to the file; from the environment or
the command line, to the working directory. The API token is read from the environment only
(``VIEWER_API_TOKEN``) so it never lands in a config file.
"""

import ipaddress
import os
import re
from dataclasses import dataclass, field, fields
from typing import Any, Dict, List, Optional

import yaml

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG = "config.yaml"

_DURATION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([smhdw]?)\s*$", re.IGNORECASE)
_DURATION_UNITS = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


def parse_duration(value: Any) -> float:
    """``7d`` / ``12h`` / ``30m`` / ``45`` (seconds) -> seconds."""
    if isinstance(value, (int, float)):
        return float(value)
    m = _DURATION_RE.match(str(value))
    if not m:
        raise ValueError(f"Invalid duration: {value!r} (use e.g. 300, 30m, 12h, 7d)")
    return float(m.group(1)) * _DURATION_UNITS[m.group(2).lower()]


@dataclass
class ViewerSettings:
    # Inventory: the same YAML formats as baremetal-mcp (redfish_servers.yaml / redfish_secrets.yaml).
    servers_file: str = "redfish_servers.yaml"
    secrets_file: str = "redfish_secrets.yaml"
    data_dir: str = os.path.join(REPO_ROOT, "data")
    static_dir: str = os.path.join(REPO_ROOT, "web", "dist")
    layouts_file: str = os.path.join(REPO_ROOT, "web", "src", "layouts", "models.json")
    bind: str = "127.0.0.1"
    port: int = 8080
    # BMC requests (GET only).
    bmc_timeout: float = 60
    bmc_retries: int = 3
    verify_tls: bool = False
    # Collection limits: iDRACs slow down noticeably with many parallel sessions.
    max_concurrent_bmcs: int = 8
    max_requests_per_bmc: int = 4
    host_timeout: float = 300
    # Freshness: hardware rarely changes, so collection only happens on request (UI, API, CLI).
    max_age: float = 7 * 86400
    retry_failed_after: float = 3600
    refresh_min_interval: float = 60
    # Security.
    api_token: Optional[str] = field(default=None, repr=False)
    open_reads: bool = True
    allowed_bmc_cidrs: List[str] = field(default_factory=list)
    # Extra Host header names accepted from loopback clients (e.g. a local reverse proxy's server name).
    allowed_hosts: List[str] = field(default_factory=list)
    # Fleet grouping: which tag names a host's lab (``lab:`` / ``rack:`` keys in the server entry win).
    lab_tags: List[str] = field(default_factory=list)
    lab_tag_pattern: Optional[str] = None
    rack_tag_pattern: str = r"^rack[-_]?(.+)$"
    # Optional switch wiring (CSV/YAML, globs allowed) that labels NIC ports with their switch port.
    wiring_files: List[str] = field(default_factory=list)

    def networks(self) -> List[ipaddress._BaseNetwork]:
        return [ipaddress.ip_network(c, strict=False) for c in self.allowed_bmc_cidrs]


_PATHS = {"servers_file", "secrets_file", "data_dir", "static_dir", "layouts_file"}
_PATH_LISTS = {"wiring_files"}
# baremetal-mcp's variable names still work for the inventory files.
_ENV_ALIASES = {"servers_file": "REDFISH_CONFIG", "secrets_file": "REDFISH_SECRETS"}
_DURATIONS = {"bmc_timeout", "host_timeout", "max_age", "retry_failed_after", "refresh_min_interval"}


def _coerce(name: str, value: Any, default: Any) -> Any:
    if name in _DURATIONS:
        return parse_duration(value)
    if isinstance(default, bool):
        return value if isinstance(value, bool) else str(value).strip().lower() in ("1", "true", "yes", "on")
    if isinstance(default, int):
        return int(value)
    if isinstance(default, list):
        return [v.strip() for v in value.split(",") if v.strip()] if isinstance(value, str) else list(value)
    return value


def read_config_file(path: Optional[str]) -> Dict[str, Any]:
    """Top-level keys, with a ``viewer:`` section (baremetal-mcp's global_config.yaml) taking precedence."""
    if not path or not os.path.exists(path):
        return {}
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping")
    section = data.get("viewer")
    return {**data, **section} if isinstance(section, dict) else data


def load_settings(overrides: Optional[Dict[str, Any]] = None, config_file: Optional[str] = None) -> ViewerSettings:
    """Build settings from the config file, then ``VIEWER_<NAME>`` env vars, then ``overrides``."""
    explicit = config_file or os.getenv("LAB3D_CONFIG")
    if explicit and not os.path.exists(explicit):
        raise FileNotFoundError(f"Config file not found: {explicit}")
    path = explicit or DEFAULT_CONFIG
    section = read_config_file(path)
    config_dir = os.path.dirname(os.path.abspath(path))
    defaults = ViewerSettings()
    values: Dict[str, Any] = {}
    for f in fields(ViewerSettings):
        if f.name == "api_token":
            continue
        default = getattr(defaults, f.name)
        raw, base = section.get(f.name), config_dir
        env = os.getenv(f"VIEWER_{f.name.upper()}")
        if env is None and f.name in _ENV_ALIASES:
            env = os.getenv(_ENV_ALIASES[f.name])
        if env is not None:
            raw, base = env, os.getcwd()
        if overrides and overrides.get(f.name) is not None:
            raw, base = overrides[f.name], os.getcwd()
        if raw is None:
            if f.name in ("servers_file", "secrets_file"):  # defaults live next to the config file
                values[f.name] = os.path.join(config_dir, default)
            continue
        values[f.name] = _coerce(f.name, raw, default)
        if f.name in _PATHS:
            values[f.name] = os.path.join(base, os.path.expanduser(values[f.name]))
        if f.name in _PATH_LISTS:
            values[f.name] = [os.path.join(base, os.path.expanduser(p)) for p in values[f.name]]
    values["api_token"] = os.getenv("VIEWER_API_TOKEN") or None
    settings = ViewerSettings(**values)
    settings.networks()  # validate CIDRs early
    return settings
