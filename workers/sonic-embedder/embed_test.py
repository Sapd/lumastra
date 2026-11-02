#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for embed.py's load_model() (P1).

P1: the DEFAULT path (SONIC_MODEL_FP unset — the only active configuration in
docker-compose.example.yml) downloaded CLAP_weights_2023.pth from HuggingFace
with no revision pin and no digest check, then torch.load()'d it directly.
_verify_model_sha256 (469fd08b0's fix) only ran inside `if model_fp:` — the
opt-in offline path — leaving the default, zero-config path completely
unverified. A tampered .pth is a torch pickle: loading one runs arbitrary
code as this process (see 469fd08b0's own commit message).

This repo does not vendor torch or msclap (they're multi-GB, GPU-oriented
packages installed only in the sidecar's own container — see
requirements.in's header on why development happens off-target). Rather than
requiring those installed to test a few lines of control flow, this stubs
`torch`, `msclap`, and `huggingface_hub` via sys.modules — the load-bearing
behavior under test is entirely "what does load_model() pass to
hf_hub_download/CLAP", not anything torch or msclap do internally.

Run: python3 -m unittest workers/sonic-embedder/embed_test.py
"""

import hashlib
import importlib
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _install_stub_modules(record):
    """Install minimal stand-ins for torch/msclap/huggingface_hub into
    sys.modules, recording every call embed.py makes into `record` so the
    tests can assert on exactly what was passed."""

    torch_stub = types.ModuleType("torch")
    torch_stub.cuda = types.SimpleNamespace(is_available=lambda: False)
    sys.modules["torch"] = torch_stub

    class FakeCLAP:
        def __init__(self, **kwargs):
            record["clap_kwargs"] = kwargs

    msclap_stub = types.ModuleType("msclap")
    msclap_stub.CLAP = FakeCLAP
    sys.modules["msclap"] = msclap_stub

    def fake_hf_hub_download(**kwargs):
        record["hf_hub_download_kwargs"] = kwargs
        return record.get("downloaded_fp", "/fake/cache/CLAP_weights_2023.pth")

    hf_stub = types.ModuleType("huggingface_hub")
    hf_stub.hf_hub_download = fake_hf_hub_download
    sys.modules["huggingface_hub"] = hf_stub


class LoadModelDefaultDownloadTest(unittest.TestCase):
    """The default path (SONIC_MODEL_FP unset) must pin a revision and
    verify a digest before ever handing the file to CLAP()."""

    def setUp(self):
        self.record = {}
        _install_stub_modules(self.record)
        os.environ.pop("SONIC_MODEL_FP", None)
        os.environ.pop("SONIC_MODEL_SHA256", None)
        sys.modules.pop("embed", None)
        self.embed = importlib.import_module("embed")

    def tearDown(self):
        sys.modules.pop("embed", None)
        for mod in ("torch", "msclap", "huggingface_hub"):
            sys.modules.pop(mod, None)

    def test_pins_a_full_commit_sha_revision_on_hf_hub_download(self):
        with mock.patch.object(self.embed, "_verify_model_sha256"):
            self.embed.load_model()

        self.assertIn("hf_hub_download_kwargs", self.record)
        kwargs = self.record["hf_hub_download_kwargs"]
        self.assertEqual(kwargs.get("repo_id"), "microsoft/msclap")
        self.assertEqual(kwargs.get("filename"), "CLAP_weights_2023.pth")
        revision = kwargs.get("revision")
        self.assertIsInstance(revision, str)
        # A 40-hex commit SHA, not a mutable ref like "main"/"master"/unset.
        self.assertRegex(revision, r"^[0-9a-f]{40}$")

    def test_verifies_the_downloaded_file_against_a_constant_digest(self):
        with mock.patch.object(self.embed, "_verify_model_sha256") as verify_mock:
            self.embed.load_model()

        verify_mock.assert_called_once()
        called_fp, called_digest = verify_mock.call_args[0]
        self.assertEqual(called_fp, "/fake/cache/CLAP_weights_2023.pth")
        self.assertIsInstance(called_digest, str)
        self.assertRegex(called_digest, r"^[0-9a-f]{64}$")

    def test_threads_the_downloaded_verified_path_into_clap_model_fp(self):
        with mock.patch.object(self.embed, "_verify_model_sha256"):
            self.embed.load_model()

        self.assertEqual(
            self.record["clap_kwargs"].get("model_fp"),
            "/fake/cache/CLAP_weights_2023.pth",
        )

    def test_a_tampered_download_fails_verification_and_never_reaches_clap(self):
        # Use the REAL _verify_model_sha256 (not mocked) against a real temp
        # file whose bytes do not match the pinned digest constant, to prove
        # the wiring is genuine, not just "some function got called".
        import tempfile

        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp.write(b"not the real weights")
            tampered_path = tmp.name
        self.addCleanup(os.remove, tampered_path)
        self.record["downloaded_fp"] = tampered_path

        with self.assertRaises(ValueError) as ctx:
            self.embed.load_model()
        # And CLAP() must never have been constructed with this file.
        self.assertNotIn("clap_kwargs", self.record)
        # fix-round-1 minor: the default (HuggingFace) path's mismatch must
        # NOT blame SONIC_MODEL_SHA256 -- that env var is unset on this path
        # entirely, so naming it points the operator at the wrong knob. It
        # must instead name the actual source of the expected digest.
        message = str(ctx.exception)
        self.assertNotIn("SONIC_MODEL_SHA256", message)
        self.assertIn("CLAP_WEIGHTS_SHA256", message)


class VerifyModelSha256Test(unittest.TestCase):
    """Sanity: the existing digest-check helper still behaves as
    load_model() now depends on it for BOTH the offline and default paths."""

    def setUp(self):
        _install_stub_modules({})
        sys.modules.pop("embed", None)
        self.embed = importlib.import_module("embed")

    def tearDown(self):
        sys.modules.pop("embed", None)
        for mod in ("torch", "msclap", "huggingface_hub"):
            sys.modules.pop(mod, None)

    def test_passes_for_a_matching_digest(self):
        import tempfile

        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp.write(b"hello world")
            path = tmp.name
        self.addCleanup(os.remove, path)
        digest = hashlib.sha256(b"hello world").hexdigest()
        self.embed._verify_model_sha256(path, digest)  # must not raise

    def test_raises_for_a_mismatched_digest(self):
        import tempfile

        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp.write(b"hello world")
            path = tmp.name
        self.addCleanup(os.remove, path)
        with self.assertRaises(ValueError):
            self.embed._verify_model_sha256(path, "0" * 64)


class MainModelLoadFailureTest(unittest.TestCase):
    """A model-load failure is about the embedder, not the files: every line
    carries "fatal": "engine" so the app never charges it to a track
    (sonic-embedding.service.ts, SonicEngineError), and the process exits 1."""

    def setUp(self):
        _install_stub_modules({})
        sys.modules.pop("embed", None)
        self.embed = importlib.import_module("embed")

    def tearDown(self):
        sys.modules.pop("embed", None)
        for mod in ("torch", "msclap", "huggingface_hub"):
            sys.modules.pop(mod, None)

    def test_every_path_is_marked_fatal_engine_and_the_exit_code_is_1(self):
        import io
        import json

        paths = ["/music/a.flac", "/music/b.flac"]
        stdout = io.StringIO()
        with mock.patch.object(
            self.embed, "load_model", side_effect=RuntimeError("No module named 'msclap'")
        ), mock.patch.object(sys, "stdin", io.StringIO(json.dumps({"paths": paths}))), mock.patch.object(
            sys, "stdout", stdout
        ), mock.patch.object(sys, "stderr", io.StringIO()):
            with self.assertRaises(SystemExit) as exited:
                self.embed.main()

        self.assertEqual(exited.exception.code, 1)
        lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual([line["path"] for line in lines], paths)
        for line in lines:
            self.assertEqual(line["fatal"], "engine")
            self.assertTrue(line["error"].startswith("model load failed"))


if __name__ == "__main__":
    unittest.main()
