#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for server.py's heap trim (_release_freed_heap).

glibc keeps the heap a finished job freed; prod's sidecar idled at 3.8 GB
against 1.7 GB right after model load until server.py started calling
malloc_trim(0) after each heavy job. Nothing fails when the trim silently stops
running, only memory regresses, so these pin that it runs, also when the job
raises, and that a libc without malloc_trim is a no-op.

fastapi, torch and the job modules are stubbed via sys.modules so this runs on
the plain CI Python, as embed_test.py does.

Run: python3 -m unittest server_trim_test -v
"""

import importlib
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


class _FakeApp:
    def __init__(self, *args, **kwargs):
        pass

    def _route(self, *args, **kwargs):
        return lambda fn: fn

    get = post = _route


def _stub_fastapi():
    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI = _FakeApp
    fastapi.HTTPException = type("HTTPException", (Exception,), {})
    fastapi.Request = object
    responses = types.ModuleType("fastapi.responses")
    responses.PlainTextResponse = object
    fastapi.responses = responses
    return {"fastapi": fastapi, "fastapi.responses": responses}


class _FakeTrim:
    """Stands in for the ctypes function: callable and takes argtypes/restype."""

    def __init__(self):
        self.calls = []

    def __call__(self, pad):
        self.calls.append(pad)
        return 1


class _FakeLibc:
    def __init__(self):
        self.malloc_trim = _FakeTrim()
        self.calls = self.malloc_trim.calls


class ReleaseFreedHeapTest(unittest.TestCase):
    def setUp(self):
        stubs = _stub_fastapi()
        stubs["torch"] = None  # None in sys.modules = ImportError; server.py tolerates it
        names = list(stubs) + ["server", "embed"]
        self._saved = {k: sys.modules.get(k) for k in names}
        sys.modules.update(stubs)
        sys.modules.pop("server", None)
        self.server = importlib.import_module("server")

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def test_calls_malloc_trim_zero(self):
        libc = _FakeLibc()
        with mock.patch("ctypes.CDLL", return_value=libc):
            self.server._release_freed_heap()
            self.server._release_freed_heap()
        self.assertEqual(libc.calls, [0, 0])

    def test_libc_without_malloc_trim_is_a_noop(self):
        with mock.patch("ctypes.CDLL", side_effect=OSError("no libc.so.6")):
            self.server._release_freed_heap()
        self.assertIs(self.server._libc_malloc_trim, False)
        self.server._release_freed_heap()  # cached: no second lookup, no raise

    def test_embed_job_trims_also_when_it_raises(self):
        embed = types.ModuleType("embed")

        def embed_paths(model, paths, infos=None):
            raise RuntimeError("decode failed")

        embed.embed_paths = embed_paths
        sys.modules["embed"] = embed
        libc = _FakeLibc()
        with mock.patch("ctypes.CDLL", return_value=libc):
            with self.assertRaisesRegex(RuntimeError, "decode failed"):
                self.server._run_embed(["/x.flac"])
        self.assertEqual(libc.calls, [0])


if __name__ == "__main__":
    unittest.main()
