#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only

"""Compare baseline/changed real ingest on owned live HLS; no provider credentials.

Requires pinned FFmpeg/ffprobe; a wrapper records actual ingest arguments.
Uses operational-smoke's real HTTP client, viewer heartbeats and media decoder.
This bounded synthetic qualification does not establish device/provider reliability.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import shutil
import threading
import time
import urllib.parse
import http.server
import select
import shlex
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location("operational", Path(__file__).with_name("operational-smoke.py"))
operational = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operational)


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, directory, marker):
        super().__init__(("127.0.0.1", 0), Handler)
        self.directory = directory
        self.marker = marker
        self.started = time.monotonic()
        self.initial = 10
        self.fault = None
        self.rolling = False
        self.probe_delay = 0
        self.probe_delayed = False
        self.stopping = threading.Event()
        self.reads = {}
        self.events = []
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path):
        return f"http://127.0.0.1:{self.server_port}{path}"

    def command(self, _hevc):
        return ["owned pre-generated H264/AAC source"]

    def close(self):
        self.stopping.set()
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=3)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_GET(self):
        provider = self.server
        path = urllib.parse.urlsplit(self.path).path
        with provider.lock:
            provider.reads[path] = provider.reads.get(path, 0) + 1
            event = {"path": path, "at": time.monotonic() - provider.started, "phase": "ingest" if provider.marker.exists() else "probe"}
            provider.events.append(event)
        if path == "/playlist" and event["phase"] == "probe" and provider.probe_delay and not provider.probe_delayed:
            provider.probe_delayed = True
            time.sleep(provider.probe_delay)
        if path == "/playlist" and provider.fault and provider.fault[0] <= event["at"] < provider.fault[1]:
            event["fault"] = provider.fault[2]
            if provider.fault[2] == "body":
                self.send_response(200)
                self.send_header("Content-Length", "1000000")
                self.end_headers()
                try:
                    self.wfile.write(b"#EXTM3U\n#EXT-X-TARGETDURATION:3\n")
                    self.wfile.flush()
                    while not provider.stopping.is_set():
                        if select.select([self.connection], [], [], 0.1)[0] and not self.connection.recv(1):
                            break
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                self.send_response(int(provider.fault[2]))
                self.send_header("Content-Length", "7")
                self.end_headers()
                self.wfile.write(b"offline")
            return
        if path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/master")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/master":
            data = b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180\nplaylist\n"
        elif path in ["/playlist", "/finite"]:
            count = provider.initial
            last = count + int((time.monotonic() - provider.started) // 3) if path != "/finite" else count
            first = max(0, last - count)
            lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:3", f"#EXT-X-MEDIA-SEQUENCE:{first}"]
            for index in range(first, last):
                lines += ["#EXTINF:3.0,", f"segment-{index:03d}.ts"]
            if path == "/finite":
                lines.append("#EXT-X-ENDLIST")
            data = ("\n".join(lines) + "\n").encode()
            event["manifest"] = {"first": first, "end": last, "finite": path == "/finite"}
            event["servedAt"] = time.monotonic() - provider.started
        elif re.fullmatch(r"/segment-\d{3}\.ts", path):
            file = provider.directory / path[1:]
            index = int(re.search(r"segment-(\d+)",path)[1])
            if provider.rolling and index < int((time.monotonic() - provider.started) // 3):
                event["expiredMedia"] = True
                self.send_error(404)
                return
            if not file.exists():
                self.send_error(404)
                return
            data = file.read_bytes()
        elif path == "/raw.ts":
            data = (provider.directory / "raw.ts").read_bytes()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        # Deliberately no suffix/MPEGURL hint on playlist or redirected master.
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def prepare(ffmpeg, directory):
    directory.mkdir(parents=True, exist_ok=True)
    command = [ffmpeg, "-y", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000", "-t", "180", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-g", "25", "-keyint_min", "25", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-hls_time", "3", "-hls_list_size", "0", "-hls_segment_filename", str(directory / "segment-%03d.ts"), "-f", "hls", str(directory / "source.m3u8")]
    subprocess.run(command, check=True, timeout=90)
    (directory / "raw.ts").write_bytes(b"".join(file.read_bytes() for file in sorted(directory.glob("segment-*.ts"))))
    return {"command": command, "firstSegmentSha256": operational.sha256(directory / "segment-000.ts"), "segments": len(list(directory.glob("segment-*.ts")))}


def run_case(args, binary, name, initial, entry, expected, sustained=False, fault=None, expect_failure=False, rolling=False, probe_delay=0):
    artifacts = Path(args.artifacts).resolve() / name
    if artifacts.exists():
        shutil.rmtree(artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    marker = artifacts / "ingest.json"
    wrapper = artifacts / "ffmpeg-wrapper"
    wrapper.write_text("#!/usr/bin/python3\nimport json,os,sys,time\nfrom pathlib import Path\nif '-readrate_initial_burst' in sys.argv:\n Path(" + repr(str(marker)) + ").write_text(json.dumps({'args':sys.argv[1:],'at':time.monotonic()}))\nos.execv(" + repr(args.ffmpeg) + ", [" + repr(args.ffmpeg) + "]+sys.argv[1:])\n")
    wrapper.chmod(0o755)
    case_args = argparse.Namespace(binary=binary, artifacts=str(artifacts), ffmpeg=str(wrapper), ffprobe=args.ffprobe, degraded_failover_seconds=1 if fault else 8)
    harness = operational.Harness(case_args)
    harness.origin.close()
    harness.origin = Provider(Path(args.artifacts).resolve() / "source", marker)
    harness.origin.initial = initial
    harness.origin.fault = fault
    harness.origin.rolling = rolling
    harness.origin.probe_delay = probe_delay
    harness.report["runtime"] = getattr(args,"runtime","native") if binary == getattr(args,"binary",binary) else "native-baseline"
    implementation = getattr(args,"implementation",binary) if binary == getattr(args,"binary",binary) else binary
    harness.report["implementationSha256"] = operational.sha256(implementation)
    harness.report["qualificationSha256"] = operational.sha256(__file__)
    # Decode uses the pinned executable directly, so only actual app ingest writes
    # the marker that distinguishes probe reads from initial ingest selection.
    try:
        harness.start()
        start = time.monotonic()
        harness.origin.started = start
        harness.join("history", "viewer", paths=[harness.origin.url(entry)])
        _, indices = harness.playlist("/streams/history/playlist.m3u8")
        first_latency = time.monotonic() - start
        ingest = json.loads(marker.read_text())
        argv = ingest["args"]
        assert argv[argv.index("-readrate") + 1] == "1", argv
        assert argv[argv.index("-readrate_initial_burst") + 1] == "12", argv
        hls_option = "-live_start_index" in argv
        assert hls_option == (name.startswith("changed") and entry != "/raw.ts"), argv
        if hls_option:
            assert argv[argv.index("-live_start_index") + 1] == "-6"
            assert argv.index("-live_start_index") < argv.index("-i")
        ingest_events = [event for event in harness.origin.events if event["phase"] == "ingest" and re.fullmatch(r"/segment-\d{3}\.ts", event["path"])]
        windows = [event["manifest"] for event in harness.origin.events if event["phase"] == "ingest" and event.get("manifest")]
        initial_window = windows[0] if windows else None
        if expected is not None:
            assert initial_window, "selection proof needs the playlist actually served to ingest"
            lookback = int(argv[argv.index("-live_start_index")+1]) if hls_option else -3
            expected = initial_window["first"] if initial_window["finite"] else max(initial_window["first"], initial_window["end"] + lookback)
            assert ingest_events and ingest_events[0]["path"] == f"/segment-{expected:03d}.ts", (initial_window,ingest_events[:8])
        harness.args.ffmpeg = args.ffmpeg
        first_index = indices[-1]
        status, _, data = harness.request("GET", f"/streams/history/segment-{first_index}.ts")
        assert status == 200 and data
        first_file = artifacts / "first.ts"
        first_file.write_bytes(data)
        first_decode = decode_file(args.ffmpeg, first_file)
        samples = [{"at": first_latency, "maxIndex": first_index}]
        retention_statuses = []
        guarded_old_media = None
        if rolling:
            parsed = urllib.parse.urlsplit(argv[argv.index("-i")+1])
            guarded_old_media = urllib.parse.urlunsplit((parsed.scheme,parsed.netloc,parsed.path,urllib.parse.urlencode({"url":harness.origin.url("/segment-000.ts")}),""))
            retention_statuses.append(guard_status(guarded_old_media))
            assert retention_statuses == [200]
        failed_at = None
        failure_status = None
        fault_decode = None
        fault_anchor = None
        if expect_failure:
            deadline = start + 50
            while time.monotonic() < deadline:
                status, _, body = harness.request("GET", "/streams/history/playlist.m3u8", timeout=3)
                if status != 200:
                    assert status == 410, (status, body)
                    failed_at = time.monotonic() - start
                    failure_status = status
                    break
                listed = [int(value) for value in re.findall(rb"segment-(\d+)\.ts",body)]
                assert listed, body
                samples.append({"at":time.monotonic()-start,"maxIndex":listed[-1]})
                time.sleep(0.2)
            assert failed_at is not None, "permanent manifest failure must not be hidden indefinitely"
            if fault[2] == "403":
                assert failed_at < fault[0] + 7, failed_at
            assert any(event.get("fault") for event in harness.origin.events)
            final_decode = None
        elif sustained:
            deadline = start + 39
            while time.monotonic() < deadline:
                time.sleep(0.3)
                _, indices = harness.playlist("/streams/history/playlist.m3u8")
                row = next(row for row in harness.status()["channels"] if row["channelId"] == "history")
                assert len(indices) <= 10, (indices,row)
                assert row["memoryBytes"] < 32 * 1024 * 1024, row
                samples.append({"at": time.monotonic() - start, "maxIndex": indices[-1], "ringEntries": len(indices), "reportedSegmentCount": row["segmentCount"], "ringBytes": row["memoryBytes"], "health":row["ffmpegHealth"]})
                if fault and fault[0] <= samples[-1]["at"] < fault[1]:
                    assert row["ffmpegHealth"] == "healthy", "a protected refresh must not degrade ingest health"
                if fault and fault[0] <= samples[-1]["at"] < fault[1]:
                    if fault_anchor is None:
                        fault_anchor = indices[-1]
                    elif indices[-1] > fault_anchor and fault_decode is None:
                        status, _, data = harness.request("GET", f"/streams/history/segment-{indices[-1]}.ts")
                        assert status == 200 and data
                        file = artifacts / "during-outage.ts"
                        file.write_bytes(data)
                        fault_decode = decode_file(args.ffmpeg, file)
            assert indices[-1] >= first_index + 8, samples
            # Once the startup burst is spent, completed output advances at real
            # time, with one segment allowance for encoder/publication scheduling.
            late = next(sample for sample in samples if sample["at"] >= 22)
            assert indices[-1] - late["maxIndex"] <= (samples[-1]["at"] - late["at"]) / 3 + 2, samples[-10:]
            status, _, data = harness.request("GET", f"/streams/history/segment-{indices[-1]}.ts")
            assert status == 200 and data
            final_file = artifacts / "final.ts"
            final_file.write_bytes(data)
            final_decode = decode_file(args.ffmpeg, final_file)
            assert final_decode["firstPts"] > first_decode["lastPts"], "decoded timestamps must advance"
            assert first_decode["pictureHashes"] != final_decode["pictureHashes"], "decoded picture must change"
            if fault:
                assert any(event.get("fault") for event in harness.origin.events), "fault must reach the actual guard"
                during = [sample for sample in samples if fault[0] <= sample["at"] < fault[1]]
                assert during[-1]["maxIndex"] > during[0]["maxIndex"], "completed output must advance during manifest outage"
                assert fault_decode and fault_decode["firstPts"] > first_decode["lastPts"], "outage output must decode with advancing timestamps"
                status, _, data = harness.request("GET", f"/streams/history/segment-{indices[-1]}.ts")
                assert status == 200 and data
        else:
            final_decode = None
        last_good = max((event.get("servedAt",event["at"]) for event in harness.origin.events if event.get("manifest")),default=None)
        age_at_failure = failed_at-last_good if failed_at is not None and last_good is not None else None
        if expect_failure and "uncached" not in name and fault[2] == "503":
            assert 29 <= age_at_failure <= 38, ("failure must follow original cache expiry",last_good,failed_at)
            fault_reads = [event for event in harness.origin.events if event.get("fault")]
            assert failed_at-fault_reads[0]["at"] >= 24, "permanent outage must exercise a meaningful protected interval"
            assert len(fault_reads) >= 3
            assert max(sample["maxIndex"] for sample in samples) >= first_index+3
        if rolling:
            retention_statuses.extend([guard_status(guarded_old_media),guard_status(guarded_old_media)])
            assert retention_statuses == [200,404,404], retention_statuses
        harness.stage("bounded provider startup", {"firstSelectedProviderSegment": ingest_events[0]["path"] if ingest_events else None, "firstPlaylistSeconds": first_latency, "firstOutputAvailableSecondsFromSpawn": first_latency - (ingest["at"] - start), "ingestArgs": argv, "providerRequests": list(harness.origin.events), "firstDecoded": first_decode, "finalDecoded": final_decode, "samples": samples, "fault": fault, "failureAtSeconds": failed_at, "failureStatus": failure_status, "decodedDuringOutage": fault_decode, "initialProviderWindow": initial_window, "expectedInitialSegment": expected, "lastSuccessfulManifestAtSeconds":last_good, "failureAgeSeconds":age_at_failure, "rollingRetentionStatuses":retention_statuses, "degradedFailoverSeconds":case_args.degraded_failover_seconds})
        harness.report["passed"] = True
        return {"firstPlaylistSeconds": first_latency, "firstSelected": ingest_events[0]["path"] if ingest_events else None}
    finally:
        harness.close()


def guard_status(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url,timeout=5) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as response:
        response.read()
        return response.code


def decode_file(ffmpeg, file):
    result = subprocess.run([ffmpeg, "-hide_banner", "-v", "error", "-copyts", "-i", str(file), "-map", "0:v:0", "-threads", "1", "-f", "framemd5", "pipe:1"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    frames = [line for line in result.stdout.splitlines() if line and not line.startswith(b"#")]
    assert len(frames) >= 25, len(frames)
    file.with_suffix(".framemd5").write_bytes(result.stdout)
    return {"frames": len(frames), "sha256": operational.hashlib.sha256(result.stdout).hexdigest(), "firstPts": int(frames[0].split(b",")[2]), "lastPts": int(frames[-1].split(b",")[2]), "pictureHashes": [line.split(b",")[-1].strip().decode() for line in frames[:10]]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", help="Optional comparison binary for startup-only/refresh-only regression runs")
    parser.add_argument("--binary", required=True)
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_PATH", "ffmpeg"))
    parser.add_argument("--ffprobe", default=os.environ.get("FFPROBE_PATH", "ffprobe"))
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--runtime",choices=["native"],default="native")
    parser.add_argument("--startup-only",action="store_true",help="Run startup and moving-window probe controls for one runtime")
    parser.add_argument("--refresh-only", action="store_true", help="Compare actual cache outage behavior against the six-entry pre-cache binary")
    args = parser.parse_args()
    if not args.baseline and not (args.startup_only or args.refresh_only):
        parser.error("--baseline is required for the baseline/changed comparison")
    args.ffmpeg = shutil.which(args.ffmpeg)
    args.ffprobe = shutil.which(args.ffprobe)
    assert args.ffmpeg and args.ffprobe, "FFmpeg and ffprobe executables are required"
    source = prepare(args.ffmpeg, Path(args.artifacts).resolve() / "source")
    args.implementation = str(Path(args.binary).resolve())
    results = {}
    if args.startup_only:
        for name, initial, entry, expected in [("ten",10,"/playlist",4),("five",5,"/playlist",0),("one",1,"/playlist",0),("redirect-master",10,"/redirect",4),("finite",10,"/finite",0),("raw",0,"/raw.ts",None)]:
            results[name]=run_case(args,args.binary,"changed-startup-"+name,initial,entry,expected)
        results["probe-window-advance"]=run_case(args,args.binary,"changed-probe-window-advance",10,"/playlist",4,probe_delay=3.2)
        assert results["probe-window-advance"]["firstSelected"] != "/segment-004.ts", "held probe must advance the provider window"
        (Path(args.artifacts)/"startup-controls.json").write_text(json.dumps({"passed":True,"runtime":args.runtime,"results":results},indent=2)+"\n")
        return
    if args.refresh_only:
        # Historical comparisons are optional; ordinary CI needs only current binaries.
        if args.baseline:
            results["uncached-503"] = run_case(args, args.baseline, "changed-uncached-503", 10, "/playlist", 4, fault=(8, 13, "503"), expect_failure=True)
        results["cached-503"] = run_case(args, args.binary, "changed-cached-503", 10, "/playlist", 4, sustained=True, fault=(8, 13, "503"))
        results["cached-body"] = run_case(args, args.binary, "changed-cached-body", 10, "/playlist", 4, sustained=True, fault=(8, 13, "body"))
        results["cached-permanent"] = run_case(args, args.binary, "changed-cached-permanent", 10, "/playlist", 4, fault=(8, 100, "503"), expect_failure=True)
        results["rolling-retention"] = run_case(args,args.binary,"changed-rolling-retention",10,"/playlist",4,sustained=True,rolling=True)
        results["cached-403"] = run_case(args, args.binary, "changed-cached-403", 10, "/playlist", 4, fault=(8, 100, "403"), expect_failure=True)
        (Path(args.artifacts) / "refresh-comparison.json").write_text(json.dumps({"passed": True, "runtime":args.runtime, "source": source, "results": results}, indent=2) + "\n")
        return
    for label, binary in [("baseline", args.baseline), ("changed", args.binary)]:
        for name, initial, entry, expected in [("ten", 10, "/playlist", 7 if label == "baseline" else 4), ("five", 5, "/playlist", 2 if label == "baseline" else 0), ("one", 1, "/playlist", 0), ("redirect-master", 10, "/redirect", 7 if label == "baseline" else 4), ("finite", 10, "/finite", 0), ("raw", 0, "/raw.ts", None)]:
            results[f"{label}-{name}"] = run_case(args, binary, f"{label}-{name}", initial, entry, expected, sustained=name == "ten")
    for name in ["ten", "five", "one", "redirect-master", "finite", "raw"]:
        before = results[f"baseline-{name}"]["firstPlaylistSeconds"]
        after = results[f"changed-{name}"]["firstPlaylistSeconds"]
        assert after <= before + 1.0, (name, "startup exceeded 1s scheduling allowance", before, after)
    report = {"passed": True, "source": source, "startupAllowanceSeconds": 1, "results": results}
    (Path(args.artifacts) / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
