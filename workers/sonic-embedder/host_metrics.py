# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Host and process figures for Admin → System health → Cluster.

The sidecar has no Valkey connection, so instead of a heartbeat the web reads
GET /health and renders the "node" block next to the web, worker and proxy
heartbeats. The shape matches src/shared/host-metrics.ts (camelCase JSON):

    {"implementation": "python", "startedAt": ISO, "version": str?,
     "host": {"id", "memTotalBytes", "memAvailableBytes", "cpuCount",
              "load1", "load5", "load15"},
     "process": {"rssBytes", "cpuPercent"?}}

host.id groups services by machine: a hash of the kernel boot id (not namespaced, so
every container on one kernel reads the same value), else K8S_NODE_NAME, else a hash
of /etc/machine-id, else a hash of the hostname. Same order and hash as the
TypeScript and Rust sides.

/health is unauthenticated, so the block carries no names (no hostname, no paths,
no secrets; the Kubernetes node name only in the rare case the boot id is
unreadable), just hashes and capacity figures. Fail-soft: a missing file drops the
field.
"""

from __future__ import annotations

import hashlib
import os
import socket
import threading
import time
from datetime import datetime, timezone
from typing import Any

_STARTED_AT = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
# CPU is sampled over a window of at least _CPU_WINDOW_S, whoever polls /health
# (the app's probe, Docker's healthcheck): shorter calls return the last value.
_CPU_WINDOW_S = 5.0
_cpu_lock = threading.Lock()
_cpu_prev: tuple[float, float] | None = None
_cpu_last: float | None = None


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return None


def _short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def host_id(proc: str = "/proc", machine_id: str = "/etc/machine-id") -> str:
    boot = _read(f"{proc}/sys/kernel/random/boot_id")
    if boot:
        return f"boot:{_short_hash(boot)}"
    node = os.environ.get("K8S_NODE_NAME", "").strip()
    if node:
        return f"k8s:{node}"
    mid = _read(machine_id)
    if mid:
        return f"machine:{_short_hash(mid)}"
    # Hashed here (unlike the TS side's name:<hostname>): /health is unauthenticated.
    return f"machine:{_short_hash(socket.gethostname())}"


def _meminfo_bytes(text: str | None, key: str) -> int | None:
    if not text:
        return None
    for line in text.splitlines():
        if line.startswith(f"{key}:"):
            try:
                return int(line.split()[1]) * 1024
            except (IndexError, ValueError):
                return None
    return None


def _cpu_percent() -> float | None:
    """CPU of this process over the last window of >= _CPU_WINDOW_S, percent of one core."""
    global _cpu_prev, _cpu_last
    t = os.times()
    used = t.user + t.system
    now = time.monotonic()
    with _cpu_lock:
        if _cpu_prev is None:
            _cpu_prev = (used, now)
        elif now - _cpu_prev[1] >= _CPU_WINDOW_S:
            _cpu_last = round((used - _cpu_prev[0]) / (now - _cpu_prev[1]) * 100, 1)
            _cpu_prev = (used, now)
        return _cpu_last


def node_info(proc: str = "/proc") -> dict[str, Any]:
    meminfo = _read(f"{proc}/meminfo")
    host: dict[str, Any] = {"id": host_id(proc)}
    total = _meminfo_bytes(meminfo, "MemTotal")
    available = _meminfo_bytes(meminfo, "MemAvailable")
    if total is not None:
        host["memTotalBytes"] = total
    if available is not None:
        host["memAvailableBytes"] = available
    try:
        # CPUs this process may run on (cpuset/affinity), like Node's availableParallelism.
        host["cpuCount"] = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        host["cpuCount"] = os.cpu_count() or 1
    try:
        host["load1"], host["load5"], host["load15"] = os.getloadavg()
    except OSError:
        pass

    process: dict[str, Any] = {}
    rss = _meminfo_bytes(_read(f"{proc}/self/status"), "VmRSS")
    if rss is not None:
        process["rssBytes"] = rss
        cpu = _cpu_percent()
        if cpu is not None:
            process["cpuPercent"] = cpu

    info: dict[str, Any] = {
        "implementation": "python",
        "startedAt": _STARTED_AT,
        "host": host,
    }
    version = os.environ.get("APP_VERSION", "").strip()
    if version:
        info["version"] = version
    if process:
        info["process"] = process
    return info
