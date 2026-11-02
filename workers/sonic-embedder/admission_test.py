#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for the memory budget (mem_budget.py) and the admission gate (admission.py).

The gate is what keeps two big jobs from stacking up past the container limit (prod
2026-10-14: 96 % of 10 GiB with an 80-minute /embed next to an /analyze). These pin
its rules: FIFO, the budget, the job-count cap, exclusive admission for a job over
the budget, a 429 only for callers that accept one, and limit detection from cgroup
files. Dependency-free; runs on the plain CI python3.

Run: python3 -m unittest admission_test -v
"""

import asyncio
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import admission  # noqa: E402
import mem_budget  # noqa: E402
from admission import AdmissionBusy, MemoryGate  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class GateTest(unittest.TestCase):
    def test_admits_while_the_budget_holds_then_queues(self):
        async def scenario():
            gate = MemoryGate(budget_mb=1000, hard_mb=1500, max_jobs=4)
            a = await gate.acquire("embed", 600, None)
            waiter = asyncio.ensure_future(gate.acquire("analyze", 600, None))
            await asyncio.sleep(0)
            self.assertFalse(waiter.done())  # 600 + 600 > 1000
            gate.release(a)
            b = await asyncio.wait_for(waiter, 1)
            self.assertEqual(gate.reserved_mb, 600)
            gate.release(b)
            self.assertEqual(gate.reserved_mb, 0)

        run(scenario())

    def test_job_count_cap(self):
        async def scenario():
            gate = MemoryGate(budget_mb=10_000, hard_mb=10_000, max_jobs=2)
            t1 = await gate.acquire("embed", 10, None)
            await gate.acquire("embed", 10, None)
            third = asyncio.ensure_future(gate.acquire("embed", 10, None))
            await asyncio.sleep(0)
            self.assertFalse(third.done())
            gate.release(t1)
            await asyncio.wait_for(third, 1)

        run(scenario())

    def test_fifo_small_job_does_not_overtake_a_waiting_big_one(self):
        async def scenario():
            gate = MemoryGate(budget_mb=1000, hard_mb=1000, max_jobs=4)
            first = await gate.acquire("analyze", 500, None)
            big = asyncio.ensure_future(gate.acquire("analyze", 900, None))
            await asyncio.sleep(0)
            small = asyncio.ensure_future(gate.acquire("embed", 100, None))
            await asyncio.sleep(0)
            # 100 would fit next to the 500, but the 900 is ahead of it.
            self.assertFalse(small.done())
            gate.release(first)
            t_big = await asyncio.wait_for(big, 1)
            await asyncio.sleep(0)
            self.assertTrue(small.done())  # 900 + 100 fits
            gate.release(t_big)

        run(scenario())

    def test_over_budget_job_runs_alone(self):
        async def scenario():
            gate = MemoryGate(budget_mb=1000, hard_mb=2000, max_jobs=4)
            small = await gate.acquire("embed", 100, None)
            big = asyncio.ensure_future(gate.acquire("analyze", 1500, None))
            await asyncio.sleep(0)
            self.assertFalse(big.done())  # waits for the running job to finish
            gate.release(small)
            t_big = await asyncio.wait_for(big, 1)
            self.assertTrue(t_big.exclusive)
            after = asyncio.ensure_future(gate.acquire("embed", 10, None))
            await asyncio.sleep(0)
            self.assertFalse(after.done())  # nothing runs next to an exclusive job
            gate.release(t_big)
            await asyncio.wait_for(after, 1)
            self.assertEqual(gate.counters["exclusive"], 1)

        run(scenario())

    def test_infeasible_is_over_the_hard_limit_only(self):
        gate = MemoryGate(budget_mb=1000, hard_mb=1500, max_jobs=2)
        self.assertFalse(gate.infeasible(1500))
        self.assertTrue(gate.infeasible(1501))

    def test_timeout_raises_busy_and_leaves_the_queue(self):
        async def scenario():
            gate = MemoryGate(budget_mb=1000, hard_mb=1000, max_jobs=1)
            held = await gate.acquire("analyze", 100, None)
            with self.assertRaises(AdmissionBusy) as ctx:
                await gate.acquire("analyze", 100, 0.05)
            self.assertGreaterEqual(ctx.exception.retry_after_s, 5)
            self.assertLessEqual(ctx.exception.retry_after_s, 300)
            self.assertEqual(gate.snapshot()["queue_depth"], 0)
            self.assertEqual(gate.counters["busy_429"], 1)
            gate.release(held)
            # The gate still works after a timed-out waiter.
            again = await asyncio.wait_for(gate.acquire("analyze", 100, None), 1)
            gate.release(again)

        run(scenario())

    def test_no_timeout_waits_as_long_as_it_takes(self):
        async def scenario():
            gate = MemoryGate(budget_mb=1000, hard_mb=1000, max_jobs=1)
            held = await gate.acquire("analyze", 100, None)
            waiter = asyncio.ensure_future(gate.acquire("analyze", 100, None))
            await asyncio.sleep(0.1)
            self.assertFalse(waiter.done())
            gate.release(held)
            await asyncio.wait_for(waiter, 1)

        run(scenario())


class CostModelTest(unittest.TestCase):
    def test_analyze_cost_covers_the_measurements(self):
        # Chunked /analyze, measured RSS peak over the loaded model (GB) through the server
        # on preprod 2026-10-15. The estimate must not fall below any, nor be far above.
        for minutes, measured in ((5, 0.46), (30, 0.89), (45, 1.11), (118, 2.67)):
            est = admission.analyze_cost_mb(minutes * 60) / 1000
            self.assertGreaterEqual(est, measured, minutes)
            self.assertLess(est, measured * 1.6, minutes)

    def test_analyze_cost_scales_with_the_analysis_rate_only(self):
        base = admission.analyze_cost_mb(600)
        self.assertEqual(admission.analyze_cost_mb(600, 44100), base)
        self.assertEqual(admission.analyze_cost_mb(600, 22050), base)  # never below
        self.assertGreater(admission.analyze_cost_mb(600, 88200), base)

    def test_map_cost_grows_with_rows(self):
        self.assertEqual(admission.map_cost_mb(None), admission.MAP_UNKNOWN_MB)
        self.assertGreater(admission.map_cost_mb(31_664), admission.map_cost_mb(1000))


class MemoryLimitTest(unittest.TestCase):
    def _files(self, v2=None, v1=None, meminfo=None):
        d = tempfile.mkdtemp()
        paths = {}
        for name, content in (("v2", v2), ("v1", v1), ("meminfo", meminfo)):
            p = os.path.join(d, name)
            if content is not None:
                with open(p, "w") as f:
                    f.write(content)
            paths[name] = p
        return paths

    def _limit(self, **kw):
        p = self._files(**kw)
        return mem_budget.memory_limit(p["v2"], p["v1"], p["meminfo"])

    def test_cgroup2_limit(self):
        with mock.patch.dict(os.environ, {"SONIC_MEMORY_LIMIT_MB": ""}):
            self.assertEqual(self._limit(v2=str(10 * 1024**3)), (10240, "cgroup2"))

    def test_cgroup2_max_falls_back_to_v1_then_half_the_host(self):
        with mock.patch.dict(os.environ, {"SONIC_MEMORY_LIMIT_MB": ""}):
            self.assertEqual(self._limit(v2="max", v1=str(6 * 1024**3)), (6144, "cgroup1"))
            self.assertEqual(
                self._limit(v2="max", v1=str(1 << 62), meminfo="MemTotal:       16384000 kB\n"),
                (8000, "host-half"),
            )

    def test_env_override_wins(self):
        with mock.patch.dict(os.environ, {"SONIC_MEMORY_LIMIT_MB": "3000"}):
            self.assertEqual(self._limit(v2=str(10 * 1024**3)), (3000, "env"))

    def test_reserve(self):
        with mock.patch.dict(os.environ, {"SONIC_MEMORY_RESERVE_MB": ""}):
            self.assertEqual(mem_budget.memory_reserve_mb(3072), 512)
            self.assertEqual(mem_budget.memory_reserve_mb(10240), 1024)
        with mock.patch.dict(os.environ, {"SONIC_MEMORY_RESERVE_MB": "200"}):
            self.assertEqual(mem_budget.memory_reserve_mb(10240), 200)


if __name__ == "__main__":
    unittest.main()
