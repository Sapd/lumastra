#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for host_metrics.py — the "node" block of GET /health must group the sidecar
with the web/worker heartbeats of the same machine (same host.id rule as
src/shared/host-metrics.ts) and never leak the raw boot id.

Run: python3 -m unittest host_metrics_test -v
"""

import hashlib
import os
import tempfile
import unittest
from unittest import mock

import host_metrics


class HostMetricsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.proc = self.tmp.name
        os.makedirs(os.path.join(self.proc, "sys/kernel/random"))
        os.makedirs(os.path.join(self.proc, "self"))
        with open(os.path.join(self.proc, "sys/kernel/random/boot_id"), "w") as fh:
            fh.write("boot-1\n")
        with open(os.path.join(self.proc, "meminfo"), "w") as fh:
            fh.write("MemTotal: 2048 kB\nMemAvailable: 512 kB\n")
        with open(os.path.join(self.proc, "self/status"), "w") as fh:
            fh.write("Name: python\nVmRSS:   100 kB\n")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_host_id_matches_the_typescript_hash(self) -> None:
        with mock.patch.dict(os.environ, {"K8S_NODE_NAME": ""}):
            expected = "boot:" + hashlib.sha256(b"boot-1").hexdigest()[:16]
            self.assertEqual(host_metrics.host_id(self.proc), expected)

    def test_boot_id_wins_over_kubernetes_node(self) -> None:
        with mock.patch.dict(os.environ, {"K8S_NODE_NAME": "srv-1"}):
            self.assertTrue(host_metrics.host_id(self.proc).startswith("boot:"))
        os.remove(os.path.join(self.proc, "sys/kernel/random/boot_id"))
        with mock.patch.dict(os.environ, {"K8S_NODE_NAME": "srv-1"}):
            self.assertEqual(host_metrics.host_id(self.proc), "k8s:srv-1")

    def test_same_hash_as_typescript_and_rust(self) -> None:
        with open(os.path.join(self.proc, "sys/kernel/random/boot_id"), "w") as fh:
            fh.write("abc\n")
        self.assertEqual(host_metrics.host_id(self.proc), "boot:ba7816bf8f01cfea")

    def test_node_info_shape(self) -> None:
        with mock.patch.dict(os.environ, {"K8S_NODE_NAME": "srv-1", "LUMASTRA_HOST_NAME": "nas"}):
            info = host_metrics.node_info(self.proc)
        self.assertEqual(info["implementation"], "python")
        # Unauthenticated endpoint: no names of any kind.
        self.assertNotIn("name", info["host"])
        self.assertNotIn("hostname", info)
        self.assertNotIn("srv-1", repr(info))
        self.assertNotIn("nas", repr(info))
        self.assertEqual(
            set(info), {"implementation", "startedAt", "host", "process"}
        )
        self.assertEqual(info["host"]["memTotalBytes"], 2048 * 1024)
        self.assertEqual(info["host"]["memAvailableBytes"], 512 * 1024)
        self.assertEqual(info["process"]["rssBytes"], 100 * 1024)
        self.assertNotIn("boot-1", repr(info))


if __name__ == "__main__":
    unittest.main()
