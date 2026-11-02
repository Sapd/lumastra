# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Memory-budget admission for the sidecar's heavy jobs (/embed, /analyze, /cluster,
/project-map). /embed-text is not gated: it has its own lane (server.py).

Why: a job's memory grows with its input (a 45-minute /analyze peaked at 13.2 GB on
preprod before it was chunked), and the server used to run any two jobs at once. On prod 2026-10-14 an
80-minute /embed next to an /analyze took the container to 96 % of its 10 GiB limit.
The gate admits a job only when its estimated cost fits what is left of the budget
(mem_budget.py), in FIFO order, so one big job waits for the others instead of
stacking on top of them.

  cost <= budget          admitted when reserved + cost <= budget (FIFO; nothing
                          overtakes a waiting job, so a big job cannot starve)
  budget < cost <= hard   "exclusive": runs alone once everything else has finished.
                          It may still fit (the reserve is a margin, not memory in use),
                          and refusing it would change which tracks get processed.
  cost > hard             infeasible: it would exceed the container limit even alone
                          (hard = limit - baseline). The caller reports a per-file error
                          (code exceeds_memory_budget) instead of OOM-killing the server.

A waiting request gives up after SONIC_ADMISSION_QUEUE_TIMEOUT_SEC only when the caller
asked for it (accept_busy: the app then gets HTTP 429 + Retry-After and retries without
blaming the track). Older apps, which would charge a 429 to the track, wait as long as
it takes, as they did before the gate existed.

Cost coefficients are fitted to preprod measurements (2026-10-15, 4 threads; see the
spec docs/superpowers/specs/2026-10-15-sonic-embedder-memory-design.md at the repo
root). Every job logs its estimate next to the RSS it reached so they can be corrected.

Dependency-free (asyncio only) so admission_test.py runs on a bare CI python3.
"""

from __future__ import annotations

import asyncio
import collections
import time
from dataclasses import dataclass, field

# --- cost model (MB) --------------------------------------------------------

# /embed with a bounded window decode: model forward on 7 s of audio plus the window.
EMBED_WINDOWED_MB = 250
# Unknown duration (probe failed): the decoder will most likely fail as well.
EMBED_UNKNOWN_MB = 500
# /analyze runs chunk by chunk (analyze_chunked.py): the decoded 44.1 kHz mono signal and
# per-frame arrays grow with the track, one chunk's working set does not. Measured through
# the server on preprod (4 threads, 2026-10-15), process RSS peak over the loaded model:
# +0.46 GB at 5 min (includes the librosa/numba import the first /analyze pays),
# +0.89 GB at 30 min (m4a, decoded through audioread), +1.11 GB at 45 min (48 kHz flac),
# +2.67 GB at 118 min. The whole-track code needed +8.0 GB at 30 min.
ANALYZE_BASE_MB = 450
ANALYZE_PER_MIN_MB = 22
# /cluster and /project-map: UMAP peaked at +1.15 GB with 31.7k rows (float32 rows).
MAP_BASE_MB = 300
MAP_BYTES_PER_ROW = 1024 * 4 * 9
MAP_UNKNOWN_MB = 1500


def embed_full_decode_cost_mb(duration_s: float, sample_rate: int, channels: int) -> int:
    """msclap's own path decodes the whole file: +2.9 GB for 45 min of 44.1 kHz stereo,
    +5.1 GB at 48 kHz (the resample keeps a second copy)."""
    minutes = max(0.0, duration_s) / 60.0
    factor = (max(1, channels) / 2.0) * (1.0 if sample_rate in (0, 44100) else 1.75)
    return int(300 + minutes * 65 * factor)


def analyze_cost_mb(duration_s: float | None, analysis_sr: int = 44100) -> int:
    """The decode streams (the native rate and channel count never sit in memory whole),
    so only the analysis rate (SONIC_ANALYZE_SR) scales the per-minute part."""
    if duration_s is None:
        return 1000
    minutes = max(0.0, duration_s) / 60.0
    rate_factor = max(1.0, max(1, analysis_sr) / 44100.0)
    return int(ANALYZE_BASE_MB + ANALYZE_PER_MIN_MB * rate_factor * minutes)


def map_cost_mb(rows: int | None) -> int:
    if rows is None:
        return MAP_UNKNOWN_MB
    return int(MAP_BASE_MB + rows * MAP_BYTES_PER_ROW / (1024 * 1024))


# --- the gate ---------------------------------------------------------------


class AdmissionBusy(Exception):
    """The request waited longer than the caller accepts; answer 429."""

    def __init__(self, retry_after_s: int, queue_depth: int):
        super().__init__(f"sidecar busy (queue depth {queue_depth})")
        self.retry_after_s = retry_after_s
        self.queue_depth = queue_depth


@dataclass
class Ticket:
    kind: str
    cost_mb: int
    exclusive: bool
    admitted_at: float = 0.0
    queued_at: float = field(default_factory=time.monotonic)
    duration_s: float = 0.0
    # Process RSS high-water mark while this job ran (server.py samples it).
    peak_rss_mb: int = 0


class MemoryGate:
    def __init__(self, budget_mb: int, hard_mb: int, max_jobs: int):
        self.budget_mb = max(0, budget_mb)
        self.hard_mb = max(self.budget_mb, hard_mb)
        self.max_jobs = max(1, max_jobs)
        self.reserved_mb = 0
        self._running: list[Ticket] = []
        self._waiters: collections.deque[tuple[Ticket, asyncio.Future]] = collections.deque()
        self._avg_secs: dict[str, float] = {}
        self.counters = {"admitted": 0, "busy_429": 0, "exceeds_budget": 0, "exclusive": 0}

    @property
    def running(self) -> list[Ticket]:
        return list(self._running)

    # Classification ---------------------------------------------------------

    def infeasible(self, cost_mb: int) -> bool:
        return cost_mb > self.hard_mb

    # Acquire / release ------------------------------------------------------

    async def acquire(self, kind: str, cost_mb: int, timeout_s: float | None) -> Ticket:
        """Wait for admission. Raises AdmissionBusy after timeout_s (None = no limit).
        Callers must check infeasible() first; an infeasible cost is run exclusively."""
        exclusive = cost_mb > self.budget_mb
        ticket = Ticket(kind=kind, cost_mb=cost_mb, exclusive=exclusive)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._waiters.append((ticket, fut))
        self._pump()
        try:
            if timeout_s is None:
                await fut
            else:
                await asyncio.wait_for(asyncio.shield(fut), timeout_s)
        except asyncio.TimeoutError:
            if fut.done() and not fut.cancelled():
                return ticket  # admitted in the same tick the timeout fired
            self._drop_waiter(ticket)
            self.counters["busy_429"] += 1
            raise AdmissionBusy(self._retry_after(kind), len(self._waiters) + 1) from None
        except asyncio.CancelledError:
            # The client went away while queued (or after being admitted).
            if fut.done() and not fut.cancelled():
                self.release(ticket)
            else:
                self._drop_waiter(ticket)
            raise
        return ticket

    def release(self, ticket: Ticket) -> None:
        if ticket in self._running:
            self._running.remove(ticket)
            self.reserved_mb -= ticket.cost_mb
            secs = time.monotonic() - ticket.admitted_at
            ticket.duration_s = secs
            prev = self._avg_secs.get(ticket.kind)
            self._avg_secs[ticket.kind] = secs if prev is None else 0.7 * prev + 0.3 * secs
        self._pump()

    def _drop_waiter(self, ticket: Ticket) -> None:
        for i, (t, f) in enumerate(self._waiters):
            if t is ticket:
                del self._waiters[i]
                if not f.done():
                    f.cancel()
                break
        self._pump()

    def _fits(self, ticket: Ticket) -> bool:
        if len(self._running) >= self.max_jobs:
            return False
        if ticket.exclusive or any(t.exclusive for t in self._running):
            return not self._running
        return self.reserved_mb + ticket.cost_mb <= self.budget_mb or not self._running

    def _pump(self) -> None:
        # Strict FIFO: the head waits until it fits; nothing overtakes it.
        while self._waiters:
            ticket, fut = self._waiters[0]
            if fut.done():  # cancelled while queued
                self._waiters.popleft()
                continue
            if not self._fits(ticket):
                return
            self._waiters.popleft()
            ticket.admitted_at = time.monotonic()
            self._running.append(ticket)
            self.reserved_mb += ticket.cost_mb
            self.counters["admitted"] += 1
            if ticket.exclusive:
                self.counters["exclusive"] += 1
            fut.set_result(None)

    def _retry_after(self, kind: str) -> int:
        per_job = self._avg_secs.get(kind, 30.0)
        est = per_job * max(1, len(self._waiters)) / self.max_jobs
        return int(min(300, max(5, est)))

    def snapshot(self) -> dict:
        now = time.monotonic()
        return {
            "budget_mb": self.budget_mb,
            "hard_mb": self.hard_mb,
            "reserved_mb": self.reserved_mb,
            "max_concurrent_jobs": self.max_jobs,
            "queue_depth": len(self._waiters),
            # A job far older than any should be is a hung decoder or a deadlock.
            "oldest_job_age_s": round(max((now - t.admitted_at for t in self._running), default=0.0), 1),
            "running": [
                {"kind": t.kind, "est_mb": t.cost_mb, "exclusive": t.exclusive,
                 "age_s": round(now - t.admitted_at, 1)}
                for t in self._running
            ],
            "counters": dict(self.counters),
        }
