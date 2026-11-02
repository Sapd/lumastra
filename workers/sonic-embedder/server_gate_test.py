#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for the wire contract between the sidecar's memory gate and the app, and for the
pieces of the bounded /embed path that need no audio stack.

The app (sonic-embedding.service.ts, music-analysis-sidecar.service.ts) relies on:
  - HTTP 429 with a Retry-After header when a request that sent accept_busy waited too
    long (it then waits and resends without blaming the track); a request without
    accept_busy (an older app, which would charge a 429 to the track) never gets one,
  - a per-file line with code "exceeds_memory_budget" for a file that cannot fit, in
    input order next to the other files' results,
  - embed_paths using the bounded decode when the file was probed, and msclap's own
    path otherwise.
fastapi, torch and the audio code are stubbed via sys.modules, so this runs on the plain
CI python3 like server_trim_test.py.

Run: python3 -m unittest server_gate_test -v
"""

import asyncio
import importlib
import json
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from admission import MemoryGate  # noqa: E402


class _HTTPException(Exception):
    def __init__(self, status_code, detail=None, headers=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.headers = headers


class _PlainTextResponse:
    def __init__(self, content="", media_type=None):
        self.content = content
        self.media_type = media_type


class _FakeApp:
    def __init__(self, *args, **kwargs):
        pass

    def _route(self, *args, **kwargs):
        return lambda fn: fn

    get = post = _route


class _Request:
    def __init__(self, body: dict, disconnected: bool = False):
        self._body = json.dumps(body).encode()
        self._disconnected = disconnected

    async def body(self):
        return self._body

    async def is_disconnected(self):
        return self._disconnected


def _stubs():
    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI = _FakeApp
    fastapi.HTTPException = _HTTPException
    fastapi.Request = object
    responses = types.ModuleType("fastapi.responses")
    responses.PlainTextResponse = _PlainTextResponse
    fastapi.responses = responses
    return {"fastapi": fastapi, "fastapi.responses": responses, "torch": None}


class _ServerCase(unittest.TestCase):
    def setUp(self):
        stubs = _stubs()
        self._saved = {k: sys.modules.get(k) for k in list(stubs) + ["server"]}
        sys.modules.update(stubs)
        sys.modules.pop("server", None)
        self.server = importlib.import_module("server")

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


class AdmitContractTest(_ServerCase):
    def test_busy_429_carries_retry_after_only_for_accept_busy(self):
        async def scenario():
            self.server._gate = MemoryGate(budget_mb=1000, hard_mb=1000, max_jobs=1)
            held = await self.server._gate.acquire("analyze", 100, None)
            with mock.patch.object(self.server, "_queue_timeout_s", return_value=0.05):
                with self.assertRaises(_HTTPException) as ctx:
                    await self.server._admit("embed", 100, accept_busy=True)
                self.assertEqual(ctx.exception.status_code, 429)
                self.assertTrue(ctx.exception.headers["Retry-After"].isdigit())
                self.assertEqual(ctx.exception.detail["code"], "busy")
                # Without accept_busy the request waits instead (an older app).
                waiter = asyncio.ensure_future(self.server._admit("embed", 100, accept_busy=False))
                await asyncio.sleep(0.1)
                self.assertFalse(waiter.done())
                self.server._gate.release(held)
                await asyncio.wait_for(waiter, 1)

        asyncio.run(scenario())

    def test_analyze_reports_over_budget_files_in_input_order(self):
        async def scenario():
            server = self.server
            server._gate = MemoryGate(budget_mb=1000, hard_mb=1500, max_jobs=2)
            paths = ["/m/a.flac", "/m/huge.flac", "/m/b.flac"]
            costs = {"/m/a.flac": 500, "/m/huge.flac": 9000, "/m/b.flac": 400}

            def fake_run_analyze(runnable, threads):
                self.assertEqual(runnable, ["/m/a.flac", "/m/b.flac"])  # never the huge one
                return [json.dumps({"path": p, "analysis": {"bpm": 1}}) + "\n" for p in runnable]

            with mock.patch.object(server, "_analyze_costs", return_value=costs), mock.patch.object(
                server, "_run_analyze", side_effect=fake_run_analyze
            ):
                resp = await server.analyze(_Request({"paths": paths, "accept_busy": True}))
            lines = [json.loads(line) for line in resp.content.splitlines()]
            self.assertEqual([line["path"] for line in lines], paths)
            self.assertEqual(lines[1]["code"], "exceeds_memory_budget")
            self.assertIn("analysis", lines[0])
            self.assertEqual(server._gate.reserved_mb, 0)  # released

        asyncio.run(scenario())

    def test_analyze_costs_follow_the_probe_and_the_duration_cap(self):
        import admission
        import windowed_embed
        from windowed_embed import AudioInfo

        server = self.server
        server._gate = MemoryGate(budget_mb=4000, hard_mb=5000, max_jobs=1)
        infos = {
            "/m/song.mp3": AudioInfo(240.0, 48000, 6),  # rate and channels no longer cost
            "/m/two_hours.flac": AudioInfo(7200.0, 44100, 2),  # at the default cap: analysed
            "/m/too_long.flac": AudioInfo(7201.0, 44100, 2),  # refused before decoding
            "/m/unreadable.mp3": None,
        }
        # analyze.py imports numpy at module level; the CI python3 has none.
        np_stub = {} if importlib.util.find_spec("numpy") else {"numpy": mock.MagicMock()}
        with mock.patch.dict(sys.modules, np_stub), mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SONIC_ANALYZE_MAX_DURATION_SEC", None)
            os.environ.pop("SONIC_ANALYZE_SR", None)
            sys.modules.pop("analyze", None)
            with mock.patch.object(windowed_embed, "probe", side_effect=lambda p: infos[p]):
                costs = server._analyze_costs(list(infos))
            sys.modules.pop("analyze", None)
        self.assertEqual(costs["/m/song.mp3"], admission.analyze_cost_mb(240.0))
        self.assertEqual(costs["/m/two_hours.flac"], admission.analyze_cost_mb(7200.0))
        self.assertEqual(costs["/m/too_long.flac"], 100)
        self.assertEqual(costs["/m/unreadable.mp3"], admission.analyze_cost_mb(None))

    def test_a_client_gone_before_start_runs_nothing(self):
        async def scenario():
            server = self.server
            server._gate = MemoryGate(budget_mb=1000, hard_mb=1500, max_jobs=2)
            with mock.patch.object(server, "_analyze_costs", return_value={"/m/a.flac": 100}), \
                    mock.patch.object(server, "_run_analyze") as run:
                await server.analyze(_Request({"paths": ["/m/a.flac"]}, disconnected=True))
            run.assert_not_called()
            self.assertEqual(server._gate.reserved_mb, 0)

        asyncio.run(scenario())

    def test_cancelled_handler_keeps_the_reservation_until_the_job_ends(self):
        async def scenario():
            server = self.server
            server._gate = MemoryGate(budget_mb=1000, hard_mb=1000, max_jobs=2)
            ticket = await server._gate.acquire("embed", 300, None)
            release = asyncio.Event()

            async def job():
                await release.wait()

            handler = asyncio.ensure_future(server._run_admitted(None, ticket, job))
            await asyncio.sleep(0)
            handler.cancel()
            await asyncio.sleep(0)
            self.assertEqual(server._gate.reserved_mb, 300)  # the work still runs
            release.set()
            await asyncio.sleep(0.01)
            self.assertEqual(server._gate.reserved_mb, 0)

        asyncio.run(scenario())


class EmbedDispatchTest(unittest.TestCase):
    """embed_paths: bounded decode for a probed file, msclap's path otherwise."""

    def setUp(self):
        self._saved = {k: sys.modules.get(k) for k in ("torch", "embed")}
        torch_stub = types.ModuleType("torch")
        torch_stub.cuda = types.SimpleNamespace(is_available=lambda: False)
        sys.modules["torch"] = torch_stub
        sys.modules.pop("embed", None)
        self.embed = importlib.import_module("embed")

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    @staticmethod
    def _tensor():
        """Stands in for the (1, 1024) tensor: .detach().cpu().numpy()[0].tolist()."""
        row = types.SimpleNamespace(tolist=lambda: [0.0] * 1024)
        tensor = mock.MagicMock()
        tensor.detach.return_value.cpu.return_value.numpy.return_value = [row]
        return tensor

    def test_probed_file_uses_the_bounded_decode(self):
        import windowed_embed

        model = mock.MagicMock()
        info = windowed_embed.AudioInfo(duration_s=300.0, sample_rate=44100, channels=2)
        with mock.patch.object(windowed_embed, "embed_windowed", return_value=self._tensor()) as win, \
                mock.patch.object(windowed_embed, "probe") as probe:
            out = self.embed.embed_paths(model, ["/m/a.flac"], {"/m/a.flac": info})
        win.assert_called_once()
        probe.assert_not_called()
        model.get_audio_embeddings.assert_not_called()
        self.assertIn("embedding", out[0])

    def test_failed_probe_uses_msclap_and_is_not_probed_again(self):
        import windowed_embed

        model = mock.MagicMock()
        model.get_audio_embeddings.return_value = self._tensor()
        with mock.patch.object(windowed_embed, "embed_windowed") as win, \
                mock.patch.object(windowed_embed, "probe") as probe:
            out = self.embed.embed_paths(model, ["/m/odd.wma"], {"/m/odd.wma": None})
        win.assert_not_called()
        probe.assert_not_called()
        model.get_audio_embeddings.assert_called_once_with(["/m/odd.wma"])
        self.assertIn("embedding", out[0])

    def test_short_file_falls_back_to_msclap(self):
        import windowed_embed

        model = mock.MagicMock()
        model.get_audio_embeddings.return_value = self._tensor()
        info = windowed_embed.AudioInfo(duration_s=12.0, sample_rate=44100, channels=2)
        with mock.patch.object(windowed_embed, "embed_windowed", return_value=None):
            self.embed.embed_paths(model, ["/m/jingle.mp3"], {"/m/jingle.mp3": info})
        model.get_audio_embeddings.assert_called_once()


class TextEncoderModeTest(unittest.TestCase):
    def test_auto_follows_the_memory_limit(self):
        from text_encoder import resolve_mode

        self.assertEqual(resolve_mode(None, 6144), "lazy")
        self.assertEqual(resolve_mode("auto", 8192), "warm")
        self.assertEqual(resolve_mode(None, 10240), "warm")
        self.assertEqual(resolve_mode("bogus", 4096), "lazy")
        self.assertEqual(resolve_mode(" WARM ", 1024), "warm")
        self.assertEqual(resolve_mode("lazy", 65536), "lazy")

    def test_idle_seconds(self):
        from text_encoder import idle_seconds

        with mock.patch.dict(os.environ, {"SONIC_TEXT_ENCODER_IDLE_SEC": ""}):
            self.assertEqual(idle_seconds(), 900)
        with mock.patch.dict(os.environ, {"SONIC_TEXT_ENCODER_IDLE_SEC": "5"}):
            self.assertEqual(idle_seconds(), 60)
        with mock.patch.dict(os.environ, {"SONIC_TEXT_ENCODER_IDLE_SEC": "x"}):
            self.assertEqual(idle_seconds(), 900)


if __name__ == "__main__":
    unittest.main()
