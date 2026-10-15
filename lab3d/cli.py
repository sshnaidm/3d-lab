#!/usr/bin/env python3
"""
Command line: ``3d-lab [serve]``, ``collect``, ``capture`` and ``export``.

    3d-lab --config config.yaml                    # web service (same as `serve`)
    3d-lab collect --all --max-age 7d              # fill the store without the service (cron)
    3d-lab collect --lab lab1 --concurrency 4
    3d-lab capture <host> -o tests/fixtures/x.json # redacted raw Redfish, for tests and layouts
    3d-lab export --replay tests/fixtures/x.json sample -o web/public/topology

Every BMC request is a GET.
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional, Set

import httpx

from lab3d.collector import Collector
from lab3d.inventory import Inventory
from lab3d.redfish import VENDORS, BMCClient
from lab3d.settings import load_settings, parse_duration
from lab3d.store import Store
from lab3d.topology import collect_topology, component_counts, fetch_raw

COMMANDS = ("serve", "collect", "capture", "export", "healthcheck")


# ---------------------------------------------------------------------------
# collect
# ---------------------------------------------------------------------------


def select_hosts(inventory: Inventory, args: argparse.Namespace) -> list:
    hosts = inventory.hosts()
    if args.host:
        missing = [h for h in args.host if h not in hosts]
        if missing:
            sys.exit(f"Unknown host(s): {', '.join(missing)}")
        return list(dict.fromkeys(args.host))
    selected = []
    for host_id, meta in hosts.items():
        if args.lab and meta["lab"] != args.lab:
            continue
        if args.rack and meta["rack"] != args.rack:
            continue
        if args.tag and not set(args.tag) <= set(meta["tags"]):
            continue
        selected.append(host_id)
    return selected


async def _collect(args: argparse.Namespace) -> int:
    overrides = {"data_dir": args.data_dir, "max_concurrent_bmcs": args.concurrency, "host_timeout": args.timeout}
    settings = load_settings(overrides, args.config)
    store = Store(settings.data_dir)
    inventory = Inventory(settings)
    collector = Collector(store, inventory, settings)

    if not (args.all or args.host or args.lab or args.rack or args.tag):
        sys.exit("Select hosts with --all, --host, --lab, --rack or --tag")
    hosts = select_hosts(inventory, args)
    if args.model:
        index = store.index()
        hosts = [h for h in hosts if args.model.lower() in ((index.get(h) or {}).get("model") or "").lower()]
    if not args.force:
        max_age = parse_duration(args.max_age) if args.max_age else settings.max_age
        hosts = collector.stale_hosts(hosts, max_age=max_age)
    print(f"{len(hosts)} host(s) to collect into {store.data_dir}", file=sys.stderr)
    if args.dry_run or not hosts:
        for h in hosts:
            print(h)
        return 0

    started = time.monotonic()
    job = collector.submit(hosts, kind="cli", requested_by="cli", force=args.accept_missing)
    reported = set()
    while not job.task.done():
        await asyncio.sleep(1)
        for host_id, result in list(job.results.items()):
            if host_id in reported:
                continue
            reported.add(host_id)
            if result["status"] == "success":
                note = f" history={result['history']}" if result.get("history") else ""
                print(
                    f"[{len(reported)}/{len(hosts)}] ok    {host_id} {result['model']} {result['seconds']}s{note}",
                    file=sys.stderr,
                )
            else:
                print(
                    f"[{len(reported)}/{len(hosts)}] FAIL  {host_id} {result['kind']}: {result['message']}",
                    file=sys.stderr,
                )
    await job.task
    summary = job.to_dict(details=False)
    print(
        f"Done in {time.monotonic() - started:.0f}s: {summary['succeeded']} ok, {summary['failed']} failed",
        file=sys.stderr,
    )
    return 1 if summary["failed"] and not summary["succeeded"] else 0


def collect_main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="3d-lab collect", description="Collect topologies into the store (no web service needed)"
    )
    parser.add_argument("--config", help="Settings file (default $LAB3D_CONFIG or ./config.yaml)")
    parser.add_argument("--all", action="store_true", help="All configured servers")
    parser.add_argument("--host", action="append", help="Server id (repeatable)")
    parser.add_argument("--lab", help="Only servers in this lab")
    parser.add_argument("--rack", help="Only servers in this rack")
    parser.add_argument("--tag", action="append", help="Only servers with this tag (repeatable, all must match)")
    parser.add_argument("--model", help="Only servers whose stored model contains this text")
    parser.add_argument("--max-age", help="Skip servers collected more recently than this (e.g. 12h, 7d)")
    parser.add_argument("--force", action="store_true", help="Collect even fresh or recently failed servers")
    parser.add_argument(
        "--accept-missing",
        action="store_true",
        help="Save even if whole part kinds (e.g. all drives) vanished since the last collection",
    )
    parser.add_argument("--concurrency", type=int, help="BMCs collected at once (default max_concurrent_bmcs)")
    parser.add_argument("--timeout", help="Per-server timeout (default host_timeout)")
    parser.add_argument("--data-dir", help="Store directory (default data_dir)")
    parser.add_argument("--dry-run", action="store_true", help="Only list the servers that would be collected")
    return asyncio.run(_collect(parser.parse_args(argv)))


# ---------------------------------------------------------------------------
# capture (redacted raw Redfish for fixtures and layout work)
# ---------------------------------------------------------------------------

REDACT_KEYS = {
    "SerialNumber",
    "SparePartNumber",
    "UUID",
    "ServiceTag",
    "AssetTag",
    "MACAddress",
    "PermanentMACAddress",
    "HostName",
    "FQDN",
    # Dell: SKU and ChassisServiceTag hold the service tag, ExpressServiceCode is its numeric form.
    "SKU",
    "ChassisServiceTag",
    "ExpressServiceCode",
    "ServiceIdentification",
    "NodeID",
    "PPID",
    # Drive WWN / NAA identifiers.
    "DurableName",
}
MAC_RE = re.compile(r"\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b")
IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
# Dell PPID (country-part-manufacturer-date-sequence-revision), often reported as a PartNumber: keep the part
# number and revision, blank out the per-unit fields.
PPID_RE = re.compile(r"\b[A-Z]{2}-([0-9A-Z]{6})-[0-9A-Z]{5}-[0-9A-Z]{3}-[0-9A-Z]{4}-([0-9A-Z]{3})\b")
VERSION_KEY_RE = re.compile(r"Version|Revision", re.IGNORECASE)


def _identifiers(obj: Any, found: Set[str]) -> Set[str]:
    """Values of REDACT_KEYS fields, so they can also be scrubbed where other fields repeat them."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in REDACT_KEYS and isinstance(v, str) and len(v.strip()) >= 5 and v != "REDACTED":
                found.add(v.strip())
            else:
                _identifiers(v, found)
    elif isinstance(obj, list):
        for v in obj:
            _identifiers(v, found)
    return found


def _redact(obj: Any, identifiers: Optional[List[str]] = None) -> Any:
    if identifiers is None:
        # Longest first, so an identifier that contains another one is replaced whole.
        identifiers = sorted(_identifiers(obj, set()), key=len, reverse=True)
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in REDACT_KEYS and isinstance(v, str) and v:
                out[k] = "REDACTED"
            elif k == "AssociatedNetworkAddresses" and isinstance(v, list):
                out[k] = ["00:00:00:00:00:00" for _ in v]
            elif VERSION_KEY_RE.search(k):
                out[k] = v  # 4-part firmware versions look like IPv4 addresses
            else:
                out[k] = _redact(v, identifiers)
        return out
    if isinstance(obj, list):
        return [_redact(v, identifiers) for v in obj]
    if isinstance(obj, str):
        for ident in identifiers:  # e.g. Dell's service tag also appears as ServiceIdentification and NodeID
            obj = obj.replace(ident, "REDACTED")
        obj = PPID_RE.sub(r"XX-\1-00000-000-0000-\2", obj)
        return IPV4_RE.sub("0.0.0.0", MAC_RE.sub("00:00:00:00:00:00", obj))
    return obj


class RecordingClient(BMCClient):
    """Remembers every successful response by path."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.responses: Dict[str, Any] = {}

    async def get(self, path: str) -> Dict[str, Any]:
        data = await super().get(path)
        self.responses[path.rstrip("/")] = data
        print(f"  got  {path}", file=sys.stderr)
        return data


async def capture(client: RecordingClient) -> Dict[str, Any]:
    """The service root, the system's Ethernet interfaces and everything the topology builder reads."""
    await client.get_optional("/redfish/v1")
    await fetch_raw(client)
    await client.get_members(f"{VENDORS[client.vendor or ''].system_path}/EthernetInterfaces")
    return client.responses


def capture_main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="3d-lab capture", description="Capture one server's Redfish hardware resources (GET only)"
    )
    parser.add_argument("host", help="Server id from the servers file")
    parser.add_argument("--config", help="Settings file (default $LAB3D_CONFIG or ./config.yaml)")
    parser.add_argument("-o", "--output", help="Output JSON file (default: stdout)")
    parser.add_argument("--no-redact", action="store_true", help="Keep serials, MACs and IPs")
    args = parser.parse_args(argv)

    inventory = Inventory(load_settings(config_file=args.config))
    responses = asyncio.run(capture(inventory.client(args.host, RecordingClient)))
    if not args.no_redact:
        responses = _redact(responses)
    text = json.dumps(responses, indent=2, sort_keys=True)
    if args.output:
        with open(args.output, "w") as f:
            f.write(text + "\n")
        print(f"Wrote {len(responses)} responses to {args.output}", file=sys.stderr)
    else:
        print(text)
    return 0


# ---------------------------------------------------------------------------
# export (static topology files for the viewer without the service)
# ---------------------------------------------------------------------------


class ReplayClient(BMCClient):
    """Answers GETs from a capture file instead of a BMC."""

    def __init__(self, host_id: str, responses: Dict[str, Any]):
        oem = (responses.get("/redfish/v1") or {}).get("Oem") or {}
        vendor = next(
            (v for k, v in (("Dell", "dell"), ("Hpe", "hpe"), ("Supermicro", "supermicro")) if k in oem), None
        )
        if vendor is None:  # older captures have no service root: guess from the system path
            vendor = "dell" if VENDORS["dell"].system_path in responses else "supermicro"
        super().__init__(host_id, "replay.invalid", vendor=vendor)
        self.responses = responses

    async def get(self, path: str) -> Dict[str, Any]:
        key = path.rstrip("/")
        if key not in self.responses:
            request = httpx.Request("GET", f"https://replay.invalid{key}")
            raise httpx.HTTPStatusError("not captured", request=request, response=httpx.Response(404, request=request))
        return self.responses[key]


def write_static(output_dir: str, topology: Dict) -> str:
    """``<id>.json`` plus ``index.json``: the layout the viewer reads in static mode (web/public/topology)."""
    os.makedirs(output_dir, exist_ok=True)
    path = os.path.join(output_dir, f"{topology['server_id']}.json")
    with open(path, "w") as f:
        json.dump(topology, f, indent=2)
    index_path = os.path.join(output_dir, "index.json")
    servers: List[Dict] = []
    if os.path.exists(index_path):
        with open(index_path) as f:
            servers = (json.load(f) or {}).get("servers", [])
    servers = [s for s in servers if s.get("id") != topology["server_id"]]
    servers.append({"id": topology["server_id"], "model": topology["system"]["model"]})
    with open(index_path, "w") as f:
        json.dump({"servers": sorted(servers, key=lambda s: s["id"])}, f, indent=2)
    return path


def export_main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="3d-lab export", description="Write static topology JSON for the viewer's static mode"
    )
    parser.add_argument("hosts", nargs="+", help="Server ids (with --replay: the id to label the output)")
    parser.add_argument("--config", help="Settings file (default $LAB3D_CONFIG or ./config.yaml)")
    parser.add_argument("-o", "--output-dir", default="web/public/topology", help="Default: web/public/topology")
    parser.add_argument("--replay", help="Capture JSON from `3d-lab capture` instead of a live BMC")
    args = parser.parse_args(argv)

    if args.replay:
        if len(args.hosts) != 1:
            parser.error("--replay takes exactly one server id")
        with open(args.replay) as f:
            clients: List[BMCClient] = [ReplayClient(args.hosts[0], json.load(f))]
    else:
        inventory = Inventory(load_settings(config_file=args.config))
        clients = [inventory.client(h) for h in args.hosts]

    async def one(client: BMCClient) -> Optional[str]:
        try:
            topology = await collect_topology(client)
        except Exception as e:  # noqa: BLE001 - report every host
            print(f"{client.host_id}: ERROR {e}", file=sys.stderr)
            return None
        path = write_static(args.output_dir, topology)
        counts = ", ".join(
            f"{k} {v['present']}/{v['present'] + v['empty']}" for k, v in component_counts(topology).items()
        )
        print(f"{client.host_id}: {topology['system']['model']} -> {path} ({counts})")
        return path

    async def run() -> List[Optional[str]]:
        return await asyncio.gather(*[one(c) for c in clients])

    return 1 if None in asyncio.run(run()) else 0


# ---------------------------------------------------------------------------
# healthcheck (container HEALTHCHECK)
# ---------------------------------------------------------------------------


def healthcheck_main(argv: List[str]) -> int:
    """Exit 0 when the local service answers /api/health."""
    settings = load_settings()
    host = "127.0.0.1" if settings.bind in ("0.0.0.0", "::", "") else settings.bind
    try:
        response = httpx.get(f"http://{host}:{settings.port}/api/health", timeout=4)
        return 0 if response.status_code == 200 else 1
    except httpx.HTTPError:
        return 1


def main(argv: Optional[List[str]] = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    command = argv[0] if argv and argv[0] in COMMANDS else "serve"
    rest = argv[1:] if argv and argv[0] in COMMANDS else argv
    if command == "serve":
        from lab3d.app import main as serve

        sys.argv = ["3d-lab", *rest]
        serve()
        return
    commands = {
        "collect": collect_main,
        "capture": capture_main,
        "export": export_main,
        "healthcheck": healthcheck_main,
    }
    sys.exit(commands[command](rest))


if __name__ == "__main__":
    main()
