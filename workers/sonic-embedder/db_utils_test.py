#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for db_utils.get_embeddings_from_db().

The function streams rows through a server-side cursor and keeps each vector as
a float32 array instead of a list of Python floats (memory: ~1.9 GB less per
/cluster or /project-map call on a 31.7k-track library). The values UMAP and
KMeans see must not change, so the matrix built from the new rows is compared
bit for bit against the old list[float] path.

psycopg2 is stubbed via sys.modules. The cursor tests also stub numpy, so they
run on the plain CI Python like embed_test.py; the bit-for-bit and consumer
tests need the real numpy and are skipped without it (run them in the sidecar
image: docker exec <sonic container> python3 -m unittest db_utils_test).

Run: python3 -m unittest db_utils_test -v
"""

import importlib
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
except ImportError:  # the CI runner has no numpy
    np = None


def _old_parse(vec_str):
    return [float(x) for x in vec_str.strip("[]").split(",")]


class _FakeCursor:
    def __init__(self, rows, record, fail_after=None):
        self._rows = rows
        self._record = record
        self._fail_after = fail_after
        self.itersize = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._record["cursor_closed"] = True
        return False

    def execute(self, sql, params):
        self._record["sql"] = sql
        self._record["params"] = params

    def __iter__(self):
        self._record["itersize"] = self.itersize
        for i, row in enumerate(self._rows):
            if self._fail_after is not None and i == self._fail_after:
                raise RuntimeError("connection lost mid-fetch")
            yield row

    def fetchall(self):  # the old path; must not be used any more
        raise AssertionError("fetchall() loads every row at once")


class _FakeConn:
    def __init__(self, rows, record, fail_after=None):
        self._rows = rows
        self._record = record
        self._fail_after = fail_after

    def cursor(self, name=None, **kwargs):
        self._record["cursor_name"] = name
        return _FakeCursor(self._rows, self._record, self._fail_after)

    def close(self):
        self._record["closed"] = True


def _stub_numpy():
    """Just enough numpy for _parse_vector: np.array(list, dtype=...) -> list."""
    stub = types.ModuleType("numpy")
    stub.float32 = "float32"
    stub.array = lambda values, dtype=None: list(values)
    return stub


class _DbUtilsCase(unittest.TestCase):
    use_real_numpy = False

    def setUp(self):
        self._saved = {k: sys.modules.get(k) for k in ("psycopg2", "numpy", "db_utils")}
        if not self.use_real_numpy:
            sys.modules["numpy"] = _stub_numpy()
        sys.modules.pop("db_utils", None)
        self.db_utils = importlib.import_module("db_utils")

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def _run(self, rows, fail_after=None):
        record = {}
        stub = types.ModuleType("psycopg2")
        stub.connect = lambda url: _FakeConn(rows, record, fail_after)
        sys.modules["psycopg2"] = stub
        return self.db_utils.get_embeddings_from_db("postgresql://x", "msclap-2023"), record


class CursorTest(_DbUtilsCase):
    def test_streams_through_a_named_cursor_and_closes(self):
        got, record = self._run([("a", "[1,2]"), ("b", "[3,4]")])
        self.assertTrue(record["cursor_name"])  # named = server-side
        self.assertGreater(record["itersize"], 0)
        self.assertEqual(record["params"], ("msclap-2023",))
        self.assertIn("ORDER BY media_id", record["sql"])
        self.assertTrue(record["cursor_closed"])
        self.assertTrue(record["closed"])
        self.assertEqual(got, [("a", [1.0, 2.0]), ("b", [3.0, 4.0])])

    def test_error_mid_fetch_propagates_and_still_closes(self):
        rows = [(f"id-{i}", "[1,2]") for i in range(5)]
        record = {}
        stub = types.ModuleType("psycopg2")
        stub.connect = lambda url: _FakeConn(rows, record, fail_after=3)
        sys.modules["psycopg2"] = stub
        with self.assertRaisesRegex(RuntimeError, "mid-fetch"):
            self.db_utils.get_embeddings_from_db("postgresql://x", "msclap-2023")
        self.assertTrue(record["cursor_closed"])
        self.assertTrue(record["closed"])

    def test_empty_table(self):
        got, record = self._run([])
        self.assertEqual(got, [])
        self.assertTrue(record["closed"])


@unittest.skipIf(np is None, "needs numpy (run in the sidecar image)")
class ValuesTest(_DbUtilsCase):
    use_real_numpy = True

    def test_values_match_the_old_list_path_bit_for_bit(self):
        rng = np.random.default_rng(7)
        # pgvector prints float4 with up to 9 significant digits; mix in a few
        # values that double-round differently if parsed straight to float32.
        rows = []
        for i in range(50):
            vec = rng.standard_normal(1024)
            vec[:3] = [0.1, -1e-30, 3.4028235e38]
            rows.append((f"id-{i:03d}", "[" + ",".join(repr(float(v)) for v in vec) + "]"))

        got, _ = self._run(rows)

        old = np.array([_old_parse(t) for _, t in rows], dtype=np.float32)
        new = np.array([vec for _, vec in got], dtype=np.float32)
        self.assertEqual([m for m, _ in got], [m for m, _ in rows])
        self.assertEqual(new.shape, (50, 1024))
        self.assertTrue(np.array_equal(old.view(np.uint32), new.view(np.uint32)))
        self.assertEqual(got[0][1].dtype, np.float32)

    def test_rows_feed_run_projection(self):
        # The consumer side: run_projection takes the rows as returned. Three
        # rows take its no-UMAP scatter path, so umap is not needed here.
        got, _ = self._run([(f"id-{i}", "[0.5,0.25]") for i in range(3)])
        project_map = importlib.import_module("project_map")
        lines = project_map.run_projection(got, 15, 0.1, "cosine", 42, None)
        self.assertEqual(len(lines), 3)
        self.assertIn('"media_id": "id-0"', lines[0])


if __name__ == "__main__":
    unittest.main()
