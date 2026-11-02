#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only

"""Real binary/network/decoded-media gate; deliberately independent of fixture hosts.

Run with the pinned FFmpeg environment, e.g.:
  python3 tests/native-conformance/proxy/operational-smoke.py --binary build/lumastra-livetv-proxy --artifacts /tmp/proxy-evidence

This bounded synthetic check is not provider, GPU, physical-device, or soak qualification.
"""

import argparse
import concurrent.futures
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import platform
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def eventually(check, timeout=35, label="condition"):
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        latest = check()
        if latest:
            return latest
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {label}; latest={latest!r}")


def group_members(group):
    rows = subprocess.check_output(["ps", "-eo", "pid=,ppid=,pgid=,comm="], text=True)
    return [line.strip() for line in rows.splitlines() if len(line.split()) >= 4 and line.split()[2] == str(group)]


class Origin(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, ffmpeg):
        super().__init__(("127.0.0.1", 0), OriginHandler)
        self.ffmpeg = ffmpeg
        self.primary_failed = threading.Event()
        self.hevc_failed = threading.Event()
        self.stall_started = threading.Event()
        self.stopping = threading.Event()
        self.lock = threading.Lock()
        self.children = set()
        self.reads = {}
        self.hls_directory = None
        self.hls_guarded_reads = {}
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path):
        return f"http://127.0.0.1:{self.server_port}{path}"

    def command(self, hevc):
        video = ["-c:v", "libx265", "-x265-params", "pools=1:frame-threads=1:repeat-headers=1:keyint=25:min-keyint=25:scenecut=0:log-level=error"] if hevc else ["-c:v", "libx264", "-tune", "zerolatency", "-g", "25", "-keyint_min", "25", "-sc_threshold", "0"]
        return [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000", *video, "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-b:v", "900k", "-maxrate", "900k", "-bufsize", "1800k", "-c:a", "aac", "-b:a", "96k", "-mpegts_flags", "+resend_headers", "-f", "mpegts", "pipe:1"]

    def prepare_encrypted_hls(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        key = directory / "key.bin"
        key.write_bytes(secrets.token_bytes(16))
        key_info = directory / "key-info.txt"
        key_info.write_text(f"{self.url('/hls/key.bin')}\n{key}\n{secrets.token_hex(16)}\n")
        command = self.command(False)
        command.remove("-re")
        command = command[:command.index("-mpegts_flags")] + ["-t", "30", "-hls_time", "3", "-hls_list_size", "0", "-hls_playlist_type", "vod", "-hls_key_info_file", str(key_info), "-hls_segment_filename", str(directory / "segment-%03d.ts"), "-f", "hls", str(directory / "variant.m3u8")]
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=45)
        assert result.returncode == 0, result.stderr[-1000:].decode(errors="replace")
        (directory / "master.m3u8").write_text("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1100000,RESOLUTION=640x360\nvariant.m3u8\n")
        assert "METHOD=AES-128" in (directory / "variant.m3u8").read_text()
        self.hls_directory = directory
        return {"command": command, "files": {path.name: sha256(path) for path in sorted(directory.iterdir())}}

    def close(self):
        self.stopping.set()
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=3)
        with self.lock:
            children = list(self.children)
        for child in children:
            if child.poll() is None:
                child.kill()
        for child in children:
            child.wait(timeout=5)
        eventually(lambda: not self.children, timeout=8, label="origin child reaping")


class OriginHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_GET(self):
        origin = self.server
        path = urllib.parse.urlsplit(self.path).path
        with origin.lock:
            origin.reads[path] = origin.reads.get(path, 0) + 1
        if (path == "/primary.ts" and origin.primary_failed.is_set()) or (path == "/hevc-primary.ts" and origin.hevc_failed.is_set()):
            self.send_error(503)
            return
        if path.startswith("/hls/") or path == "/blocked.m3u8":
            if path.startswith("/hls/") and path != "/hls/master.m3u8":
                # The relay consumes Set-Cookie; an unrewritten direct key/child URL
                # cannot inherit this cookie from the FFmpeg-facing loopback response.
                if "relay-session=synthetic-owned" not in self.headers.get("Cookie", ""):
                    self.send_error(403)
                    return
                with origin.lock:
                    origin.hls_guarded_reads[path] = origin.hls_guarded_reads.get(path, 0) + 1
            if path == "/blocked.m3u8":
                data = f"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:3,\n{origin.url('/private.ts')}\n#EXT-X-ENDLIST\n".encode()
            elif origin.hls_directory is not None and path.rsplit("/", 1)[-1] in {file.name for file in origin.hls_directory.iterdir() if file.suffix in [".m3u8", ".ts", ".bin"]}:
                data = (origin.hls_directory / path.rsplit("/", 1)[-1]).read_bytes()
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl" if path.endswith(".m3u8") else "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            if path == "/hls/master.m3u8":
                self.send_header("Set-Cookie", "relay-session=synthetic-owned; Path=/hls")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        self.send_response(200)
        self.send_header("Content-Type", "video/MP2T")
        self.send_header("Connection", "close")
        self.end_headers()
        if path == "/stall.ts":
            origin.stall_started.set()
            origin.stopping.wait(25)
            return
        child = subprocess.Popen(origin.command(path.startswith("/hevc")), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        with origin.lock:
            origin.children.add(child)
        try:
            while not origin.stopping.is_set():
                if path == "/primary.ts" and origin.primary_failed.is_set():
                    break
                if path == "/hevc-primary.ts" and origin.hevc_failed.is_set():
                    break
                chunk = child.stdout.read(16 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            child.stdout.close()
            with origin.lock:
                origin.children.discard(child)


class Harness:
    def __init__(self, args):
        self.args = args
        self.artifacts = Path(args.artifacts).resolve()
        self.artifacts.mkdir(parents=True, exist_ok=True)
        self.secret = secrets.token_hex(24)
        self.origin = Origin(args.ffmpeg)
        self.proxy = None
        self.active = set()
        self.active_lock = threading.Lock()
        self.stop_heartbeats = threading.Event()
        self.heartbeat_thread = threading.Thread(target=self.heartbeats, daemon=True)
        self.report = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "platform": platform.platform(), "machine": platform.machine(), "binary": str(Path(args.binary).resolve()), "binarySha256": sha256(args.binary), "harnessSha256": sha256(__file__), "ffmpegVersion": subprocess.check_output([args.ffmpeg, "-version"], text=True).splitlines()[0], "source": {"video": "640x360@25 testsrc2", "audio": "997Hz AAC48kHz", "h264Command": self.origin.command(False), "hevcCommand": self.origin.command(True)}, "stages": []}

    def stage(self, name, evidence):
        self.report["stages"].append({"name": name, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **evidence})
        self.save()
        print(f"PASS {name}", flush=True)

    def save(self):
        (self.artifacts / "report.json").write_text(json.dumps(self.report, indent=2) + "\n")

    def request(self, method, path, body=None, authenticated=True, timeout=40):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        headers = {"X-Proxy-Secret": self.secret} if authenticated else {}
        if body is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def json(self, method, path, body=None, expected=200, authenticated=True):
        status, _, data = self.request(method, path, body, authenticated)
        value = json.loads(data)
        assert status == expected, (method, path, status, value)
        return value

    def status(self):
        return self.json("GET", "/status")

    def payload(self, viewer, paths=None, **extra):
        return {"viewerId": viewer, "streamUrls": paths or [self.origin.url("/primary.ts"), self.origin.url("/backup.ts")], "sourceId": "synthetic", "maxStreams": 4, "channelName": "Synthetic operational media", "allowPrivateUrls": True, **extra}

    def join(self, channel, viewer, **extra):
        body = self.payload(viewer, **extra)
        result = self.json("POST", f"/streams/{channel}/join", body)
        assert result["success"] is True, result
        with self.active_lock:
            self.active.add((channel, viewer))
        return result

    def heartbeats(self):
        while not self.stop_heartbeats.wait(0.75):
            with self.active_lock:
                viewers = list(self.active)
            for channel, viewer in viewers:
                try:
                    self.json("POST", f"/streams/{channel}/heartbeat?viewerId={viewer}")
                except (AssertionError, OSError, http.client.HTTPException):
                    pass  # Explicit stage assertions check ownership, not this keepalive helper.

    def playlist(self, path):
        status, _, data = self.request("GET", path, timeout=22)
        assert status == 200, (path, status, data[:200])
        text = data.decode()
        assert text.startswith("#EXTM3U"), (path, text[:200])
        indices = [int(n) for n in re.findall(r"segment-(\d+)\.(?:ts|m4s)", text)]
        assert indices, (path, text)
        return text, indices

    def decode(self, name, path, codec="h264", height=None):
        output = self.artifacts / f"{name}.framemd5"
        log = self.artifacts / f"{name}.decode.log"
        command = [self.args.ffmpeg, "-hide_banner", "-v", "error", "-rw_timeout", "10000000", "-headers", f"X-Proxy-Secret: {self.secret}\r\n", "-i", f"http://127.0.0.1:{self.port}{path}", "-t", "1", "-map", "0:v:0", "-threads", "1", "-f", "framemd5", "pipe:1"]
        environment = dict(os.environ)
        for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]:
            environment.pop(key, None)
        environment.update({"NO_PROXY": "*", "no_proxy": "*"})
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=50, env=environment)
        output.write_bytes(result.stdout)
        log.write_bytes(result.stderr.replace(self.secret.encode(), b"[redacted]"))
        assert result.returncode == 0, (name, result.returncode, result.stderr[-1000:].decode(errors="replace"))
        frames = [line for line in result.stdout.splitlines() if line and not line.startswith(b"#")]
        assert len(frames) >= 5, (name, len(frames))
        probe = subprocess.run([self.args.ffprobe, "-v", "error", "-rw_timeout", "10000000", "-headers", f"X-Proxy-Secret: {self.secret}\r\n", "-analyzeduration", "1000000", "-probesize", "1000000", "-show_entries", "stream=codec_name,codec_type,width,height", "-print_format", "json", f"http://127.0.0.1:{self.port}{path}"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, env=environment)
        assert probe.returncode == 0, (name, "served media probe failed", probe.stderr[-1000:].decode(errors="replace"))
        streams = json.loads(probe.stdout)["streams"]
        video = next(stream for stream in streams if stream["codec_type"] == "video")
        assert video["codec_name"] == codec, (name, video)
        if height is not None:
            assert video["height"] == height, (name, video)
        return {"decodedFrames": len(frames), "framemd5Sha256": hashlib.sha256(result.stdout).hexdigest(), "servedStreams": streams}

    def kill(self, channel):
        with self.active_lock:
            self.active = {(c, v) for c, v in self.active if c != channel}
        return self.json("DELETE", f"/streams/{channel}/kill")

    def leave(self, channel, viewer):
        with self.active_lock:
            self.active.discard((channel, viewer))
        return self.json("DELETE", f"/streams/{channel}/leave?viewerId={viewer}")

    def encoder(self, channel, rung=None, adaptive=False):
        row = next((row for row in self.status()["channels"] if row["channelId"] == channel), {})
        if adaptive:
            return next((encoder for encoder in row.get("encoders", []) if encoder["kind"] == "adaptive"), None)
        return next((encoder for encoder in row.get("encoders", []) if encoder.get("rungId") == rung), None)

    def encrypted_hls(self):
        fixture = self.origin.prepare_encrypted_hls(self.artifacts / "encrypted-origin")
        self.join("encrypted", "aes", paths=[self.origin.url("/hls/master.m3u8")])
        decoded = self.decode("upstream-aes-hls", "/streams/encrypted/playlist.m3u8", height=360)
        with self.origin.lock:
            reads = dict(self.origin.reads)
        # Both ffprobe and ingest must traverse the master, child and encryption key.
        for path in ["/hls/master.m3u8", "/hls/variant.m3u8", "/hls/key.bin"]:
            assert reads.get(path, 0) >= 2, reads
        for path in ["/hls/variant.m3u8", "/hls/key.bin"]:
            assert self.origin.hls_guarded_reads.get(path, 0) >= 2, self.origin.hls_guarded_reads
        assert any(path.startswith("/hls/segment-") and count >= 2 for path, count in reads.items()), reads
        self.kill("encrypted")
        self.join("blocked", "blocked", paths=["http://8.8.8.8/blocked.m3u8"], allowPrivateUrls=False)
        def rejected():
            rows = self.status()["channels"]
            row = next((row for row in rows if row["channelId"] == "blocked"), {})
            return self.origin.reads.get("/blocked.m3u8", 0) >= 2 and row.get("segmentCount") == 0 and row.get("ffmpegHealth") == "error"
        eventually(rejected, timeout=15, label="real ffprobe and ingest reject private HLS child")
        assert self.origin.reads.get("/private.ts", 0) == 0, self.origin.reads
        self.kill("blocked")
        return {"fixture": fixture, "decoded": decoded, "upstreamHlsReads": {path: count for path, count in reads.items() if path.startswith("/hls/")}, "cookieGuardedChildAndKeyReads": dict(self.origin.hls_guarded_reads), "negativeControlPublicPlaylistReads": self.origin.reads["/blocked.m3u8"], "negativeControlPrivateReads": self.origin.reads.get("/private.ts", 0)}

    def existing_variant_failover(self):
        before = {}
        for variant in ["fmp4", "h264"]:
            text, indices = self.playlist(f"/streams/hevc/v/{variant}/playlist.m3u8")
            before[variant] = {"maxIndex": indices[-1], "initUris": re.findall(r'#EXT-X-MAP:URI="([^"]+)"', text)}
        self.origin.hevc_failed.set()
        recovered = {}
        def carried_variants():
            if self.origin.reads.get("/hevc-backup.ts", 0) == 0:
                return False
            try:
                for variant in ["fmp4", "h264"]:
                    text, indices = self.playlist(f"/streams/hevc/v/{variant}/playlist.m3u8")
                    if indices[-1] <= before[variant]["maxIndex"]:
                        return False
                    recovered[variant] = {"maxIndex": indices[-1], "initUris": re.findall(r'#EXT-X-MAP:URI="([^"]+)"', text)}
                return recovered["fmp4"]["initUris"] and recovered["fmp4"]["initUris"][-1] != before["fmp4"]["initUris"][-1]
            except (AssertionError, OSError, http.client.HTTPException):
                return False
        eventually(carried_variants, timeout=45, label="existing HEVC compatibility URLs recover without rejoin")
        init = recovered["fmp4"]["initUris"][-1]
        status, _, data = self.request("GET", f"/streams/hevc/v/fmp4/{init}")
        assert status == 200 and data, (status, init)
        decoded = {"fmp4": self.decode("hevc-fmp4-after-failover", "/streams/hevc/v/fmp4/master.m3u8", codec="hevc", height=360), "h264": self.decode("hevc-h264-after-failover", "/streams/hevc/v/h264/master.m3u8", height=360)}
        return {"before": before, "after": recovered, "newInit": {"uri": init, "status": status, "sha256": hashlib.sha256(data).hexdigest()}, "decodedWithoutRejoin": decoded}

    def aligned_adaptive_packets(self):
        paths = [f"/streams/main/a/{rung}/playlist.m3u8" for rung in ["low", "high"]]
        indices = [self.playlist(path)[1] for path in paths]
        index = max(set(indices[0]) & set(indices[1]))
        evidence = {}
        starts = []
        for rung in ["low", "high"]:
            status, _, data = self.request("GET", f"/streams/main/a/{rung}/segment-{index}.ts")
            assert status == 200 and data
            file = self.artifacts / f"aligned-{rung}-{index}.ts"
            file.write_bytes(data)
            result = subprocess.run([self.args.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time,dts_time,flags", "-print_format", "json", str(file)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            assert result.returncode == 0, result.stderr.decode(errors="replace")
            packets = json.loads(result.stdout)["packets"]
            assert packets and "K" in packets[0]["flags"], (rung, packets[:1])
            starts.append(float(packets[0]["pts_time"]))
            evidence[rung] = {"index": index, "sha256": hashlib.sha256(data).hexdigest(), "firstVideoPts": starts[-1], "lastVideoPts": float(packets[-1]["pts_time"]), "videoPackets": len(packets)}
        assert abs(starts[0] - starts[1]) <= 0.040001, evidence
        return evidence

    def output_grace(self, cap, adaptive):
        self.join("main", "fixed-shared", cap=cap)
        fixed = self.encoder("main", "fixed")
        assert fixed and fixed["viewers"] == 2, fixed
        before = group_members(self.proxy.pid)
        self.leave("main", "fixed")
        assert self.encoder("main", "fixed")["viewers"] == 1
        assert group_members(self.proxy.pid) == before
        self.leave("main", "fixed-shared")
        left_at = time.monotonic()
        time.sleep(1)
        assert self.encoder("main", "fixed")["viewers"] == 0
        eventually(lambda: self.encoder("main", "fixed") is None and self.status()["egressCapacity"]["used"] == 2, timeout=15, label="last fixed viewer grace reaps encoder and releases reservation")
        fixed_elapsed = time.monotonic() - left_at
        assert fixed_elapsed >= 9, fixed_elapsed
        after = group_members(self.proxy.pid)
        assert len(after) == len(before) - 1, (before, after)
        adaptive_before = self.encoder("main", adaptive=True)
        adaptive_processes = group_members(self.proxy.pid)
        self.leave("main", "adaptive")
        assert self.encoder("main", adaptive=True)["viewers"] == 0
        time.sleep(1)
        self.join("main", "adaptive", adaptive=adaptive)
        resumed = self.encoder("main", adaptive=True)
        assert resumed["viewers"] == 1 and resumed["startedAt"] == adaptive_before["startedAt"], (adaptive_before, resumed)
        assert group_members(self.proxy.pid) == adaptive_processes
        self.decode("adaptive-rejoin-in-grace", "/streams/main/a/low/playlist.m3u8", height=180)
        self.leave("main", "adaptive")
        left_at = time.monotonic()
        eventually(lambda: self.encoder("main", adaptive=True) is None and self.status()["egressCapacity"]["used"] == 0, timeout=16, label="adaptive final leave grace reaps encoder and releases all outputs")
        adaptive_elapsed = time.monotonic() - left_at
        assert adaptive_elapsed >= 9, adaptive_elapsed
        assert len(group_members(self.proxy.pid)) == 2, group_members(self.proxy.pid)
        for viewer in ["original", *(f"parallel{n}" for n in range(4))]:
            self.leave("main", viewer)
        eventually(lambda: self.status()["activeChannels"] == 0 and not self.status()["perSourceLimits"] and len(group_members(self.proxy.pid)) == 1, timeout=8, label="last raw viewer source grace expires without kill")
        return {"fixedSharedViewers": fixed["viewers"], "fixedReapSeconds": fixed_elapsed, "adaptiveReapSeconds": adaptive_elapsed, "adaptiveStartedBeforeRejoin": adaptive_before["startedAt"], "adaptiveStartedAfterRejoin": resumed["startedAt"], "sourceGraceSeconds": 2, "remainingProcessGroup": group_members(self.proxy.pid)}

    def start(self):
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            self.port = reserved.getsockname()[1]
        environment = dict(os.environ)
        environment.update({"NODE_ENV": "production", "STREAM_PROXY_SECRET": self.secret, "STREAM_PROXY_BIND": "127.0.0.1", "PORT": str(self.port), "FFMPEG_PATH": self.args.ffmpeg, "FFPROBE_PATH": self.args.ffprobe, "HLS_TEMP_DIR": str(self.artifacts / "media"), "LIVETV_PROXY_GPU": "none", "LIVETV_PROXY_PRESET": "ultrafast", "LIVETV_PROXY_TRANSCODE_MODE": "auto", "LIVETV_ALLOW_HEVC_PASSTHROUGH": "true", "LIVETV_MAX_EGRESS_ENCODERS": "12", "LIVETV_PROBE_TIMEOUT_MS": "5000", "LIVETV_VIEWER_TIMEOUT_SECONDS": "6", "LIVETV_GRACE_PERIOD_SECONDS": "2", "LIVETV_DEGRADED_FAILOVER_SECONDS": str(getattr(self.args,"degraded_failover_seconds",8)), "LIVETV_HEALTH_CHECK_INTERVAL_SECONDS": "1", "LIVETV_ORPHAN_CHECK_INTERVAL_SECONDS": "1"})
        for key in ["LIVETV_UPSTREAM_PROXY_URL", "CACHE_URL", "TASK_CACHE_URL", "TASK_QUEUE_URL", "TASK_QUEUE_CACHE_URL", "REDIS_URL", "VALKEY_URL", "TASK_VALKEY_URL", "LIVETV_PROXY_REDIS_URL", "LIVETV_FAILURE_REDIS_URL"]:
            environment.pop(key, None)
        # Own forward proxy supplies fake-public negative controls without external traffic.
        environment["LIVETV_UPSTREAM_PROXY_URL"] = self.origin.url("/")
        self.proxy_log = open(self.artifacts / "proxy.log", "wb")
        self.proxy = subprocess.Popen([str(Path(self.args.binary).resolve()), "--serve"], env=environment, stdin=subprocess.DEVNULL, stdout=self.proxy_log, stderr=self.proxy_log, start_new_session=True)
        def listening():
            assert self.proxy.poll() is None, "proxy exited during startup; inspect proxy.log"
            try:
                return self.status()
            except (OSError, http.client.HTTPException):
                return False
        eventually(listening, timeout=15, label="operational listener")
        self.heartbeat_thread.start()

    def child_credentials(self):
        """Media children see neither the shared secret nor credential-bearing variables;
        a feed opens only with its own grant, the upstream relay only with its token."""
        children = [line.split()[0] for line in group_members(self.proxy.pid) if line.split()[0] != str(self.proxy.pid)]
        feeds, relays, inspected = [], [], 0
        for pid in children:
            try:
                argv = Path(f"/proc/{pid}/cmdline").read_bytes()
                environ = Path(f"/proc/{pid}/environ").read_bytes()
            except OSError:
                continue  # exited between listing and reading
            inspected += 1
            assert self.secret.encode() not in argv + environ, ("shared secret reached a child", pid)
            names = [entry.split(b"=", 1)[0].upper() for entry in environ.split(b"\0") if entry]
            assert not [n for n in names if n.endswith((b"_SECRET", b"_PASSWORD", b"_TOKEN", b"_KEY", b"_URL"))], (pid, names)
            for arg in argv.decode(errors="replace").split("\0"):
                if "/feed.ts?feed=" in arg:
                    feeds.append(arg)
                if re.match(r"http://127\.0\.0\.1:\d+/r/[0-9a-f]{32}/upstream\.", arg):
                    relays.append(arg)
        assert inspected and feeds and relays, (children, feeds, relays)
        assert self.request("GET", "/streams/main/feed.ts?feed=" + "0" * 32)[0] == 403, "shared secret opened a feed"
        granted = urllib.parse.urlsplit(feeds[0])
        assert self.request("GET", f"/streams/foreign/feed.ts?{granted.query}", authenticated=False)[0] == 403, "feed grant opened another channel"
        relay = urllib.parse.urlsplit(relays[0])
        connection = http.client.HTTPConnection(relay.hostname, relay.port, timeout=10)
        try:
            connection.request("GET", f"/{relay.path.split('/', 3)[3]}?{relay.query}")
            untokened = connection.getresponse().status
        finally:
            connection.close()
        assert untokened == 404, ("relay served a URL without its token", untokened)
        return {"inspectedChildren": inspected, "feedInputs": len(feeds), "relayInputs": len(relays), "untokenedRelayStatus": untokened}

    def cadence(self, paths):
        last = {path: self.playlist(path)[1][-1] for path in paths}
        arrivals = {path: [] for path in paths}
        end = time.monotonic() + self.args.cadence_seconds
        while time.monotonic() < end:
            for path in paths:
                _, indices = self.playlist(path)
                if indices[-1] != last[path]:
                    arrivals[path].append({"index": indices[-1], "monotonic": time.monotonic(), "jump": indices[-1] - last[path]})
                    last[path] = indices[-1]
            time.sleep(0.1)
        for path, events in arrivals.items():
            assert len(events) >= 3, ("insufficient cadence arrivals", path, events)
            gaps = [b["monotonic"] - a["monotonic"] for a, b in zip(events, events[1:])]
            assert max(gaps) < 8, ("bunched/stalled media delivery", path, gaps)
            assert max(e["jump"] for e in events) == 1, ("bunched media indices", path, events)
        return arrivals

    def run(self):
        self.start()
        public = self.json("GET", "/status", authenticated=False)
        assert "egressCapacity" not in public
        self.json("POST", "/streams/auth/join", self.payload("unauthorized"), expected=401, authenticated=False)
        self.stage("operational authentication", {"healthy": public["healthy"]})

        self.join("main", "original")
        _, before = self.playlist("/streams/main/playlist.m3u8")
        status, headers, data = self.request("GET", f"/streams/main/segment-{before[-1]}.ts")
        assert status == 200 and data and headers.get("cache-control") == "public, max-age=3600", headers
        original = self.decode("original", "/streams/main/playlist.m3u8", height=360)
        cap = {"rung": {"id": "fixed", "height": 180, "maxBitrate": 350000, "codec": "h264"}, "requestedMaxBitrate": 350000, "belowLadder": False, "pinned": True, "fallback": "refuse"}
        assert self.join("main", "fixed", cap=cap)["rungId"] == "fixed"
        fixed = self.decode("fixed", "/streams/main/r/fixed/playlist.m3u8", height=180)
        adaptive = {"rungs": [{"id": "low", "height": 180, "maxBitrate": 250000, "codec": "h264"}, {"id": "high", "height": 360, "maxBitrate": 700000, "codec": "h264"}], "includeOriginal": False, "fallback": "refuse"}
        result = self.join("main", "adaptive", adaptive=adaptive)
        assert len(result["adaptive"]["rungs"]) == 2 and not result["adaptive"]["includesOriginal"]
        decoded = {rung: self.decode(f"adaptive-{rung}", f"/streams/main/a/{rung}/playlist.m3u8", height=180 if rung == "low" else 360) for rung in ["low", "high"]}
        self.stage("decoded original fixed adaptive", {"original": original, "fixed": fixed, "adaptive": decoded})

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda n: self.join("main", f"parallel{n}"), range(4)))
        state = self.status()
        assert state["activeChannels"] == 1 and state["totalViewers"] == 7, state
        self.stage("concurrent joins and heartbeat ownership", {"activeChannels": state["activeChannels"], "viewers": state["totalViewers"]})
        self.stage("child credentials, feed grants and relay token", self.child_credentials())
        paths = ["/streams/main/playlist.m3u8", "/streams/main/r/fixed/playlist.m3u8", "/streams/main/a/low/playlist.m3u8", "/streams/main/a/high/playlist.m3u8"]
        self.stage("continuous feed cadence", {"seconds": self.args.cadence_seconds, "arrivals": self.cadence(paths)})
        self.stage("adaptive cross rung packet alignment", self.aligned_adaptive_packets())

        _, before = self.playlist(paths[0])
        self.origin.primary_failed.set()
        def failed_over():
            try:
                text, indices = self.playlist(paths[0])
                return (text, indices) if self.origin.reads.get("/backup.ts", 0) > 0 and indices[-1] > before[-1] else False
            except (AssertionError, OSError, http.client.HTTPException):
                return False
        text, after = eventually(failed_over, timeout=45, label="backup source with monotonic segment indices")
        assert "#EXT-X-DISCONTINUITY" in text, text
        recovered = self.decode("failover-original", paths[0])
        self.join("main", "fixed", cap=cap)
        self.join("main", "adaptive", adaptive=adaptive)
        recovered["fixed"] = self.decode("failover-fixed", paths[1])
        recovered["adaptive"] = self.decode("failover-adaptive", paths[2])
        self.stage("source failure and output rejoin", {"beforeMax": before[-1], "afterMax": after[-1], "decoded": recovered})
        self.stage("shared fixed adaptive and source grace", self.output_grace(cap, adaptive))
        self.stage("actual upstream AES HLS and private child containment", self.encrypted_hls())

        hevc_sources = [self.origin.url("/hevc-primary.ts"), self.origin.url("/hevc-backup.ts")]
        assert self.join("hevc", "native-hevc", paths=hevc_sources, client={"hevc": "fmp4"})["variant"] == "fmp4"
        remux = self.decode("hevc-fmp4", "/streams/hevc/v/fmp4/master.m3u8", codec="hevc", height=360)
        assert self.join("hevc", "compat-h264", paths=hevc_sources, client={"hevc": "none"})["variant"] == "h264"
        compat = self.decode("hevc-h264", "/streams/hevc/v/h264/master.m3u8")
        self.stage("decoded HEVC remux and H264 compatibility", {"fmp4": remux, "h264": compat})
        self.stage("HEVC existing compatibility URLs survive failover", self.existing_variant_failover())

        self.kill("main")
        self.kill("hevc")
        eventually(lambda: self.status()["activeChannels"] == 0 and self.status()["egressCapacity"]["used"] == 0 and not self.status()["perSourceLimits"], timeout=15, label="kill releases all channels and output reservations")
        eventually(lambda: len(group_members(self.proxy.pid)) == 1, timeout=10, label="kill reaps proxy media children")
        self.stage("kill and capacity release", {"proxyProcessGroup": group_members(self.proxy.pid)})

        payload = json.dumps(self.payload("abandoned", [self.origin.url("/stall.ts")])).encode()
        client = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        client.sendall(f"POST /streams/abandoned/join HTTP/1.1\r\nHost: localhost\r\nX-Proxy-Secret: {self.secret}\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n".encode() + payload)
        assert self.origin.stall_started.wait(5), "cold probe never reached the actual HTTP source"
        client.close()
        # Whether rolled back or allowed to finish then orphan-expire, ownership must end.
        eventually(lambda: self.status()["activeChannels"] == 0 and not self.status()["perSourceLimits"] and self.status()["totalViewers"] == 0 and len(group_members(self.proxy.pid)) == 1, timeout=35, label="disconnected cold join releases source and reaps children")
        self.stage("disconnect during cold probe cleanup", {"activeChannels": self.status()["activeChannels"]})

        self.join("shutdown", "last", paths=[self.origin.url("/backup.ts")])
        self.playlist("/streams/shutdown/playlist.m3u8")
        descendants = group_members(self.proxy.pid)
        assert len(descendants) >= 2, descendants
        self.proxy.send_signal(signal.SIGTERM)
        assert self.proxy.wait(timeout=15) == 0
        eventually(lambda: not group_members(self.proxy.pid), timeout=5, label="shutdown leaves no proxy child processes")
        self.stage("active shutdown and child reaping", {"ownedBeforeSignal": descendants, "ownedAfterExit": group_members(self.proxy.pid)})
        self.report["passed"] = True

    def close(self):
        self.stop_heartbeats.set()
        if self.heartbeat_thread.is_alive():
            self.heartbeat_thread.join(timeout=45)
        if self.proxy is not None and self.proxy.poll() is None:
            self.proxy.terminate()
            try:
                self.proxy.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(self.proxy.pid, signal.SIGKILL)
                self.proxy.wait(timeout=5)
        if self.proxy is not None:
            remaining = group_members(self.proxy.pid)
            self.report["remainingProxyProcesses"] = remaining
            if remaining:
                os.killpg(self.proxy.pid, signal.SIGKILL)
            self.proxy_log.close()
        self.origin.close()
        self.report["sourceRequests"] = self.origin.reads
        self.report["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_PATH", "ffmpeg"))
    parser.add_argument("--ffprobe", default=os.environ.get("FFPROBE_PATH", "ffprobe"))
    parser.add_argument("--artifacts", default=tempfile.mkdtemp(prefix="lumastra-native-proxy-smoke-"))
    parser.add_argument("--cadence-seconds", type=int, default=15)
    args = parser.parse_args()
    if args.cadence_seconds < 12:
        parser.error("cadence sampling must cover at least four nominal segments (12 seconds)")
    harness = Harness(args)
    try:
        harness.run()
    except BaseException as error:
        harness.report["passed"] = False
        harness.report["failure"] = f"{type(error).__name__}: {error}".replace(harness.secret, "[redacted]")
        if harness.proxy is not None and harness.proxy.poll() is None:
            try:
                harness.report["failureStatus"] = harness.status()
            except (OSError, AssertionError, http.client.HTTPException):
                pass
        raise
    finally:
        harness.close()
        print(f"Evidence: {harness.artifacts}", flush=True)


if __name__ == "__main__":
    main()
