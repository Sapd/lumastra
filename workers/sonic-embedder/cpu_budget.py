# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
CPU budget of THIS process — what server.py's default thread count is derived from.

os.cpu_count() inside a container is the HOST's core count, not the container's. A
48-core host with the sidecar capped at `cpus: 4` defaulted to 24 threads, and a
16-file /embed batch blew straight through the 6g memory limit (kernel OOM every
~30s). The real budget is the smallest of:
  - the CPUs this process may run on (sched_getaffinity: cpuset / --cpuset-cpus),
  - the cgroup v2 CPU quota (/sys/fs/cgroup/cpu.max "quota period", rounded up —
    what Compose `cpus:` / `docker run --cpus` sets),
  - os.cpu_count() as the fallback when neither is readable.

Dependency-free on purpose: server.py imports it before torch, and the unit test
(cpu_budget_test.py) runs on a bare CI python3.
"""

from __future__ import annotations

import math
import os

CGROUP_CPU_MAX = "/sys/fs/cgroup/cpu.max"


def cgroup_cpu_limit(path: str = CGROUP_CPU_MAX) -> int | None:
    """CPUs allowed by the cgroup v2 quota, rounded up; None when unlimited/unreadable."""
    try:
        with open(path, encoding="ascii") as f:
            quota, period = f.read().split()[:2]
    except (OSError, ValueError):
        return None
    if quota == "max":
        return None
    try:
        q, p = int(quota), int(period)
    except ValueError:
        return None
    if q <= 0 or p <= 0:
        return None
    return max(1, math.ceil(q / p))


def affinity_cpus() -> int | None:
    """CPUs this process may be scheduled on; None where the call is unsupported (macOS)."""
    try:
        return len(os.sched_getaffinity(0)) or None
    except (AttributeError, OSError):
        return None


def available_cpus(cpu_max_path: str = CGROUP_CPU_MAX) -> int:
    """Smallest known CPU budget for this process, at least 1."""
    known = [n for n in (affinity_cpus(), cgroup_cpu_limit(cpu_max_path)) if n]
    if known:
        return max(1, min(known))
    return max(1, os.cpu_count() or 2)
