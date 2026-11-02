#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for analyze.py's per-request thread budget.

Regression: _apply_thread_budget() wrote the request's `threads` into
NUMBA_NUM_THREADS. That variable is the size of numba's thread pool and is
fixed once the pool launches; numba re-reads it and raises "Cannot set
NUMBA_NUM_THREADS to a different value once the threads have been launched",
so one request with a different `threads` broke every later request until the
process restarted (measured on prod 2026-09-27: /cluster threads=2, then
/analyze with the default).

analyze.py imports numpy at module level; numpy and numba are stubbed via
sys.modules so this runs on a plain CI Python, as embed_test.py does.

Run: python3 -m unittest analyze_threads_test -v
"""

import importlib
import os
import sys
import types
import unittest
from unittest import mock


class _FakeNumba(types.ModuleType):
    def __init__(self, pool_size):
        super().__init__("numba")
        self.config = types.SimpleNamespace(NUMBA_NUM_THREADS=pool_size)
        self.calls = []

    def set_num_threads(self, n):
        if not 1 <= n <= self.config.NUMBA_NUM_THREADS:
            raise ValueError("The number of threads must be between 1 and %d" % self.config.NUMBA_NUM_THREADS)
        self.calls.append(n)


class ApplyThreadBudgetTest(unittest.TestCase):
    def setUp(self):
        self._saved_env = dict(os.environ)
        self._saved_modules = {k: sys.modules.get(k) for k in ("numpy", "numba", "analyze")}
        sys.modules["numpy"] = mock.MagicMock(name="numpy")  # module-level np.array() calls need any attribute
        self.numba = _FakeNumba(pool_size=10)
        sys.modules["numba"] = self.numba
        sys.modules.pop("analyze", None)
        os.environ["NUMBA_NUM_THREADS"] = "10"  # what server.py set at startup
        self.analyze = importlib.import_module("analyze")

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)
        for k, v in self._saved_modules.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def test_never_rewrites_the_numba_pool_size(self):
        self.analyze._apply_thread_budget(2)
        self.analyze._apply_thread_budget(6)
        self.assertEqual(os.environ["NUMBA_NUM_THREADS"], "10")

    def test_narrows_the_active_count_within_the_pool(self):
        self.analyze._apply_thread_budget(2)
        self.analyze._apply_thread_budget(6)
        self.assertEqual(self.numba.calls, [2, 6])

    def test_clamps_a_request_larger_than_the_pool(self):
        self.analyze._apply_thread_budget(32)
        self.assertEqual(self.numba.calls, [10])

    def test_still_caps_the_blas_env_vars(self):
        self.analyze._apply_thread_budget(3)
        for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
            self.assertEqual(os.environ[var], "3", var)

    def test_absent_or_zero_threads_is_a_no_op(self):
        self.analyze._apply_thread_budget(None)
        self.analyze._apply_thread_budget(0)
        self.assertEqual(self.numba.calls, [])
        self.assertEqual(os.environ["NUMBA_NUM_THREADS"], "10")


if __name__ == "__main__":
    unittest.main()
