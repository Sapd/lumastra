# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Memory budget of THIS container: what the admission gate (admission.py) may hand out.

The sidecar must not assume the host's RAM is free. The limit is, in order:
  1. SONIC_MEMORY_LIMIT_MB (explicit override),
  2. cgroup v2 /sys/fs/cgroup/memory.max (Compose `memory:`, Kubernetes limits.memory),
  3. cgroup v1 /sys/fs/cgroup/memory/memory.limit_in_bytes,
  4. half of /proc/meminfo MemTotal when the container has no limit (the app, the
     database and the rest of the host share that RAM).

budget = limit - baseline - reserve, where baseline is the process's own RSS after the
model has loaded and reserve (SONIC_MEMORY_RESERVE_MB, default max(512 MB, 10 % of the
limit)) covers interpreter growth, ffmpeg children and estimation error.

Dependency-free on purpose, like cpu_budget.py: server.py imports it before torch, and
its tests (admission_test.py) run on a bare CI python3.
"""

from __future__ import annotations

import os

CGROUP2_MEMORY_MAX = "/sys/fs/cgroup/memory.max"
CGROUP1_MEMORY_LIMIT = "/sys/fs/cgroup/memory/memory.limit_in_bytes"
PROC_MEMINFO = "/proc/meminfo"
PROC_SELF_STATUS = "/proc/self/status"

MB = 1024 * 1024
# cgroup v1 reports "no limit" as a page-aligned huge number (~2^63).
_CGROUP1_UNLIMITED = 1 << 60


def _env_mb(name: str) -> int | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        val = int(raw)
    except ValueError:
        return None
    return val if val > 0 else None


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="ascii") as f:
            return f.read().strip()
    except OSError:
        return None


def cgroup2_limit_mb(path: str = CGROUP2_MEMORY_MAX) -> int | None:
    raw = _read(path)
    if raw is None or raw == "max":
        return None
    try:
        val = int(raw)
    except ValueError:
        return None
    return val // MB if val > 0 else None


def cgroup1_limit_mb(path: str = CGROUP1_MEMORY_LIMIT) -> int | None:
    raw = _read(path)
    if raw is None:
        return None
    try:
        val = int(raw)
    except ValueError:
        return None
    if val <= 0 or val >= _CGROUP1_UNLIMITED:
        return None
    return val // MB


def host_total_mb(path: str = PROC_MEMINFO) -> int | None:
    raw = _read(path)
    if raw is None:
        return None
    for line in raw.splitlines():
        if line.startswith("MemTotal:"):
            try:
                return int(line.split()[1]) // 1024  # kB
            except (IndexError, ValueError):
                return None
    return None


def memory_limit(
    cgroup2_path: str = CGROUP2_MEMORY_MAX,
    cgroup1_path: str = CGROUP1_MEMORY_LIMIT,
    meminfo_path: str = PROC_MEMINFO,
) -> tuple[int, str]:
    """(limit in MB, source), source one of env, cgroup2, cgroup1, host-half, default."""
    env = _env_mb("SONIC_MEMORY_LIMIT_MB")
    if env is not None:
        return env, "env"
    v2 = cgroup2_limit_mb(cgroup2_path)
    if v2 is not None:
        return v2, "cgroup2"
    v1 = cgroup1_limit_mb(cgroup1_path)
    if v1 is not None:
        return v1, "cgroup1"
    host = host_total_mb(meminfo_path)
    if host is not None:
        return max(1, host // 2), "host-half"
    return 4096, "default"  # nothing readable (macOS dev box)


def memory_reserve_mb(limit_mb: int) -> int:
    env = _env_mb("SONIC_MEMORY_RESERVE_MB")
    if env is not None:
        return env
    return max(512, limit_mb // 10)


def own_rss_mb(path: str = PROC_SELF_STATUS) -> int | None:
    """This process's resident set (VmRSS) in MB; None where /proc is absent."""
    raw = _read(path)
    if raw is None:
        return None
    for line in raw.splitlines():
        if line.startswith("VmRSS:"):
            try:
                return int(line.split()[1]) // 1024  # kB
            except (IndexError, ValueError):
                return None
    return None
