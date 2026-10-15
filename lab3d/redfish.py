#!/usr/bin/env python3
"""
Minimal read-only Redfish client: vendor detection, per-vendor resource paths and credentials, retries.

The client can only send GET requests: 3D Lab holds BMC credentials for a whole fleet and must never
change a server's state. Certificates are not verified by default (BMCs almost always use self-signed ones).
"""

import asyncio
import contextlib
import contextvars
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

import httpx

logger = logging.getLogger("lab3d.redfish")


@dataclass(frozen=True)
class Vendor:
    system_path: str
    manager_path: str
    default_username: str
    default_password: str


VENDORS: Dict[str, Vendor] = {
    "dell": Vendor("/redfish/v1/Systems/System.Embedded.1", "/redfish/v1/Managers/iDRAC.Embedded.1", "root", "calvin"),
    "hpe": Vendor("/redfish/v1/Systems/1", "/redfish/v1/Managers/1", "Administrator", "password"),
    "supermicro": Vendor("/redfish/v1/Systems/1", "/redfish/v1/Managers/1", "ADMIN", "ADMIN"),
}

# Optional cap on in-flight requests to one BMC. The collector sets a semaphore for the duration of a
# per-server task; nested asyncio.gather() calls inherit it through the context.
BMC_REQUEST_LIMIT: contextvars.ContextVar[Optional[asyncio.Semaphore]] = contextvars.ContextVar(
    "BMC_REQUEST_LIMIT", default=None
)


@dataclass
class HttpOptions:
    timeout: float = 60
    retries: int = 3
    backoff: float = 0.5
    verify_tls: bool = False


_http: Optional[httpx.AsyncClient] = None
_http_verify: Optional[bool] = None


def http_client(verify_tls: bool = False) -> httpx.AsyncClient:
    """One shared connection pool per process (tests replace this function)."""
    global _http, _http_verify
    if _http is None or _http_verify != verify_tls:
        _http = httpx.AsyncClient(verify=verify_tls)
        _http_verify = verify_tls
    return _http


async def detect_vendor(address: str, options: Optional[HttpOptions] = None) -> str:
    """Vendor from the unauthenticated service root's ``Oem`` section."""
    options = options or HttpOptions()
    try:
        response = await http_client(options.verify_tls).get(
            f"https://{address}/redfish/v1", timeout=options.timeout, headers={"Accept": "application/json"}
        )
        response.raise_for_status()
        oem = response.json().get("Oem") or {}
        for key, vendor in (("Dell", "dell"), ("Hpe", "hpe"), ("Supermicro", "supermicro")):
            if key in oem:
                return vendor
        raise ValueError("Unknown vendor in OEM data")
    except (httpx.HTTPError, ValueError) as e:
        raise ConnectionError(f"Could not auto-detect vendor for {address}") from e


class BMCClient:
    """GET-only access to one BMC. ``vendor`` is detected on first use when not given."""

    def __init__(
        self,
        host_id: str,
        address: str,
        username: Optional[str] = None,
        password: Optional[str] = None,
        vendor: Optional[str] = None,
        options: Optional[HttpOptions] = None,
    ):
        if vendor and vendor.lower() not in VENDORS:
            raise ValueError(f"Unsupported vendor: {vendor}")
        self.host_id = host_id
        self.address = address
        self.vendor = vendor.lower() if vendor else None
        self.options = options or HttpOptions()
        self._username = username
        self._password = password

    def __repr__(self) -> str:  # never show credentials
        return f"BMCClient({self.host_id!r}, vendor={self.vendor!r})"

    async def resolve_vendor(self) -> Vendor:
        if not self.vendor:
            self.vendor = await detect_vendor(self.address, self.options)
        return VENDORS[self.vendor]

    async def get(self, path: str) -> Dict[str, Any]:
        """GET ``path`` and return the JSON body. Raises ``httpx.HTTPError`` after retries are exhausted."""
        vendor = await self.resolve_vendor()
        url = urljoin(f"https://{self.address}", path)
        auth = (self._username or vendor.default_username, self._password or vendor.default_password)
        client = http_client(self.options.verify_tls)
        attempts = max(1, self.options.retries)
        start = time.monotonic()
        for attempt in range(1, attempts + 1):
            try:
                limit = BMC_REQUEST_LIMIT.get()
                async with limit if limit is not None else contextlib.nullcontext():
                    response = await client.get(
                        url, auth=auth, timeout=self.options.timeout, headers={"Accept": "application/json"}
                    )
                response.raise_for_status()
                logger.debug(
                    "[%s] GET %s -> %d in %.2fs", self.host_id, path, response.status_code, time.monotonic() - start
                )
                data = response.json() if response.content else {}
                return data if isinstance(data, dict) else {}
            except httpx.HTTPStatusError as e:
                if e.response.status_code >= 500 and attempt < attempts:
                    await asyncio.sleep(self.options.backoff * attempt)
                    continue
                raise
            except httpx.RequestError:
                if attempt < attempts:
                    await asyncio.sleep(self.options.backoff * attempt)
                    continue
                raise
        raise AssertionError("unreachable")  # pragma: no cover

    async def get_optional(self, path: Optional[str]) -> Dict[str, Any]:
        """GET a resource that may be missing on some BMCs: ``{}`` on any failure."""
        if not path:
            return {}
        try:
            return await self.get(path)
        except (httpx.HTTPError, ValueError) as e:
            logger.debug("[%s] GET %s failed: %s", self.host_id, path, e)
            return {}

    async def get_members(self, collection_path: Optional[str]) -> List[Dict[str, Any]]:
        """All members of a collection, fetched in parallel; missing collections and members are skipped."""
        collection = await self.get_optional(collection_path)
        paths = [m.get("@odata.id") for m in collection.get("Members") or [] if isinstance(m, dict)]
        members = await asyncio.gather(*[self.get_optional(p) for p in paths if p])
        return [m for m in members if m]
