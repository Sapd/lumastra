#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for cpu_budget.py — the default thread count must follow the CONTAINER's CPU
budget, not the host's core count (os.cpu_count() inside a container).

Run: python3 -m unittest cpu_budget_test -v
"""

import os
import tempfile
import unittest
from unittest import mock

import cpu_budget


def _cpu_max(content: str) -> str:
    f = tempfile.NamedTemporaryFile("w", suffix="cpu.max", delete=False)
    f.write(content)
    f.close()
    return f.name


class CgroupCpuLimitTest(unittest.TestCase):
    def test_quota_is_rounded_up(self):
        self.assertEqual(cpu_budget.cgroup_cpu_limit(_cpu_max("400000 100000\n")), 4)
        self.assertEqual(cpu_budget.cgroup_cpu_limit(_cpu_max("150000 100000\n")), 2)
        self.assertEqual(cpu_budget.cgroup_cpu_limit(_cpu_max("50000 100000\n")), 1)

    def test_unlimited_missing_or_garbage_is_none(self):
        self.assertIsNone(cpu_budget.cgroup_cpu_limit(_cpu_max("max 100000\n")))
        self.assertIsNone(cpu_budget.cgroup_cpu_limit("/nonexistent/cpu.max"))
        self.assertIsNone(cpu_budget.cgroup_cpu_limit(_cpu_max("junk\n")))
        self.assertIsNone(cpu_budget.cgroup_cpu_limit(_cpu_max("0 100000\n")))


class AvailableCpusTest(unittest.TestCase):
    def test_a_48_core_host_with_cpus_4_gives_4(self):
        # The 2026-09 preprod OOM: host cores leaked into the default.
        with mock.patch.object(cpu_budget, "affinity_cpus", return_value=48), \
             mock.patch.object(os, "cpu_count", return_value=48):
            self.assertEqual(cpu_budget.available_cpus(_cpu_max("400000 100000\n")), 4)

    def test_cpuset_smaller_than_quota_wins(self):
        with mock.patch.object(cpu_budget, "affinity_cpus", return_value=2):
            self.assertEqual(cpu_budget.available_cpus(_cpu_max("800000 100000\n")), 2)

    def test_no_quota_uses_affinity(self):
        with mock.patch.object(cpu_budget, "affinity_cpus", return_value=20):
            self.assertEqual(cpu_budget.available_cpus(_cpu_max("max 100000\n")), 20)

    def test_nothing_readable_falls_back_to_cpu_count(self):
        with mock.patch.object(cpu_budget, "affinity_cpus", return_value=None), \
             mock.patch.object(os, "cpu_count", return_value=6):
            self.assertEqual(cpu_budget.available_cpus("/nonexistent/cpu.max"), 6)


if __name__ == "__main__":
    unittest.main()
