#!/usr/bin/env python3
"""
Collector: on-request refresh jobs over many BMCs with bounded concurrency and per-host dedup.

- At most ``max_concurrent_bmcs`` hosts are collected at once and at most ``max_requests_per_bmc``
  requests are in flight to any single BMC (via ``redfish.BMC_REQUEST_LIMIT``).
- A host that is already being collected is never collected twice; a new job simply waits for it.
- One failing host never fails a job: its error is classified and recorded in the store index.
"""

import asyncio
import itertools
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from lab3d.inventory import Inventory
from lab3d.redfish import BMC_REQUEST_LIMIT
from lab3d.settings import ViewerSettings
from lab3d.store import Store, missing_kinds, now_iso, parse_iso
from lab3d.topology import collect_topology

logger = logging.getLogger("viewer.collector")

_MAX_JOBS = 200
_IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-fA-F:]+\]")
_URL_RE = re.compile(r"https?://\S+")


class IncompleteCollection(RuntimeError):
    """The BMC answered, but whole kinds of parts seen before are missing now."""


def classify_error(exc: BaseException, bmc_address: Optional[str] = None) -> Dict[str, str]:
    """(kind, message) with URLs, IP addresses and the BMC address stripped, safe to show in the UI."""
    if isinstance(exc, asyncio.TimeoutError):
        return {"kind": "timeout", "message": "Collection timed out"}
    if isinstance(exc, IncompleteCollection):
        return {"kind": "incomplete", "message": str(exc)}
    text = str(exc) or exc.__class__.__name__
    cause = exc.__cause__ or exc.__context__
    if "auto-detect vendor" in text and cause is not None and not isinstance(cause, ValueError):
        # Vendor detection wraps network and auth failures; report those, not "unsupported".
        inner = classify_error(cause, bmc_address)
        if inner["kind"] in ("auth", "timeout", "unreachable"):
            return {"kind": inner["kind"], "message": f"Vendor detection failed: {inner['message']}"[:300]}
    if bmc_address:
        text = text.replace(bmc_address, "<bmc>")
    lower = text.lower()
    if re.search(r"\b401\b|\b403\b|unauthori[sz]ed|forbidden", lower):
        kind = "auth"
    elif "not found in configuration" in lower:
        kind = "unknown_host"
    elif "unsupported vendor" in lower or "unknown vendor" in lower or "auto-detect vendor" in lower:
        kind = "unsupported"
    elif re.search(r"timed? ?out|timeout", lower):
        kind = "timeout"
    elif re.search(r"connect|unreachable|no route|refused|name or service|name resolution", lower):
        kind = "unreachable"
    else:
        kind = "error"
    message = _IP_RE.sub("<bmc>", _URL_RE.sub("<url>", text))
    return {"kind": kind, "message": message[:300]}


class Job:
    _ids = itertools.count(1)

    def __init__(self, kind: str, hosts: List[str], requested_by: str):
        self.id = f"job-{int(time.time())}-{next(self._ids)}"
        self.kind = kind
        self.hosts = hosts
        self.requested_by = requested_by
        self.state = "queued"
        self.created_at = now_iso()
        self.started_at: Optional[str] = None
        self.finished_at: Optional[str] = None
        self.results: Dict[str, Dict] = {}
        self.task: Optional[asyncio.Task] = None

    def to_dict(self, details: bool = True) -> Dict[str, Any]:
        failed = sum(1 for r in self.results.values() if r["status"] != "success")
        out = {
            "id": self.id,
            "kind": self.kind,
            "state": self.state,
            "requested_by": self.requested_by,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "total": len(self.hosts),
            "done": len(self.results),
            "succeeded": len(self.results) - failed,
            "failed": failed,
        }
        if details:
            out["hosts"] = {h: self.results.get(h, {"status": "pending"}) for h in self.hosts}
        return out


class Collector:
    def __init__(self, store: Store, inventory: Inventory, settings: ViewerSettings):
        self.store = store
        self.inventory = inventory
        self.settings = settings
        self._host_slots = asyncio.Semaphore(max(1, settings.max_concurrent_bmcs))
        self._inflight: Dict[str, asyncio.Task] = {}
        self.jobs: Dict[str, Job] = {}

    # -- single host ---------------------------------------------------------

    def is_busy(self, host_id: str) -> bool:
        return host_id in self._inflight

    async def _collect(self, host_id: str, force: bool) -> Dict:
        async with self._host_slots:
            BMC_REQUEST_LIMIT.set(asyncio.Semaphore(max(1, self.settings.max_requests_per_bmc)))
            started = time.monotonic()
            try:
                client = self.inventory.client(host_id)
                topology = await asyncio.wait_for(collect_topology(client), self.settings.host_timeout)
                missing = [] if force else missing_kinds(self.store.index().get(host_id), topology)
                if missing:
                    raise IncompleteCollection(
                        f"No {', '.join(missing)} reported this time; kept the previous data "
                        "(refresh with force if the parts were really removed)"
                    )
            except Exception as e:  # noqa: BLE001 - every failure is recorded per host
                error = classify_error(e, self.inventory.bmc_address(host_id))
                logger.warning("collect %s failed: %s (%s)", host_id, error["kind"], error["message"])
                await self.store.record_error(host_id, error["kind"], error["message"])
                return {"status": "error", **error, "seconds": round(time.monotonic() - started, 1)}
            row = await self.store.save(topology)
            logger.info("collect %s ok in %.1fs (history: %s)", host_id, time.monotonic() - started, row["history"])
            return {
                "status": "success",
                "model": row["model"],
                "history": row["history"],
                "seconds": round(time.monotonic() - started, 1),
            }

    def collect(self, host_id: str, force: bool = False) -> asyncio.Task:
        """Start (or join) the collection of one host. ``force`` accepts a result with whole kinds missing."""
        task = self._inflight.get(host_id)
        if task is None:
            task = asyncio.create_task(self._collect(host_id, force), name=f"collect:{host_id}")
            self._inflight[host_id] = task
            task.add_done_callback(lambda _t, h=host_id: self._inflight.pop(h, None))
        return task

    # -- jobs ----------------------------------------------------------------

    def submit(
        self, host_ids: Iterable[str], kind: str = "refresh", requested_by: str = "api", force: bool = False
    ) -> Job:
        hosts = list(dict.fromkeys(host_ids))
        job = Job(kind, hosts, requested_by)
        self.jobs[job.id] = job
        for old in list(self.jobs)[:-_MAX_JOBS]:
            if self.jobs[old].state == "done":
                del self.jobs[old]
        # Start (or join) the host collections right away so a second job sees them as busy.
        tasks = {h: self.collect(h, force) for h in hosts}
        job.task = asyncio.create_task(self._run(job, tasks), name=job.id)
        return job

    async def _run(self, job: Job, tasks: Dict[str, asyncio.Task]) -> None:
        job.state = "running"
        job.started_at = now_iso()

        async def one(host_id: str, task: asyncio.Task) -> None:
            try:
                job.results[host_id] = await asyncio.shield(task)
            except Exception as e:  # noqa: BLE001
                job.results[host_id] = {"status": "error", **classify_error(e)}

        await asyncio.gather(*[one(h, t) for h, t in tasks.items()])
        job.state = "done"
        job.finished_at = now_iso()

    def active_jobs(self, kind: Optional[str] = None) -> List[Job]:
        return [j for j in self.jobs.values() if j.state != "done" and (kind is None or j.kind == kind)]

    async def wait(self, job: Job) -> Job:
        if job.task:
            await job.task
        return job

    # -- staleness -------------------------------------------------------------

    def _age(self, iso: Optional[str], now: datetime) -> Optional[float]:
        dt = parse_iso(iso)
        return (now - dt).total_seconds() if dt else None

    def stale_hosts(self, host_ids: Optional[Iterable[str]] = None, max_age: Optional[float] = None) -> List[str]:
        """Hosts never collected or older than ``max_age``, skipping hosts that failed recently."""
        max_age = self.settings.max_age if max_age is None else max_age
        now = datetime.now(timezone.utc)
        index = self.store.index()
        out = []
        for host_id in host_ids if host_ids is not None else self.inventory.hosts():
            row = index.get(host_id) or {}
            age = self._age(row.get("captured_at"), now)
            if age is not None and age < max_age:
                continue
            error_age = self._age((row.get("last_error") or {}).get("at"), now)
            if error_age is not None and error_age < self.settings.retry_failed_after:
                continue
            if self.is_busy(host_id):
                continue
            out.append(host_id)
        return out

    async def stop(self) -> None:
        tasks = list(self._inflight.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
