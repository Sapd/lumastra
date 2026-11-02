# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Golden test: chunked /analyze (analyze.py + analyze_chunked.py) must give exactly the
output of the whole-track code it replaced (analyze_reference.py). A difference would
mean every analysed track in a library is stale, so the bar is equality of the JSON, not
a tolerance.

Needs the sidecar's audio stack (librosa, soundfile, pyloudnorm, soxr); a bare python3
only reports it as skipped. In CI it runs inside the sidecar image built from the change,
on the synthetic fixtures, with SONIC_GOLDEN_REQUIRED=1 so a missing audio stack fails
instead of skipping. Run it by hand with a corpus before bumping librosa, pyloudnorm,
soxr or numpy. The image does not ship the tests; mount the source tree into it, with
the server's BLAS thread count (numpy's MKL rounds a matrix product differently per
thread count, in the old code as much as the new):

    docker run --rm -v "$PWD":/src -w /src -v /music:/music:ro \
      -e MKL_NUM_THREADS=4 -e OMP_NUM_THREADS=4 -e NUMBA_NUM_THREADS=4 \
      -e SONIC_GOLDEN_CORPUS=/music --entrypoint python <sidecar image> \
      -m unittest analyze_golden_test -v

Synthetic files cover the edge cases: stereo/mono/6- and 8-channel, 8/22.05/44.1/48/96
kHz, mp3 and (with ffmpeg) m4a, digital silence with isolated clicks, pure digital
silence, a track shorter than one chunk and tracks around the 400 ms loudness block.
They run at two chunk sizes (SONIC_GOLDEN_CHUNK_SEC, default "7,30": small chunks cross
many boundaries, 30 s is the production default). SONIC_GOLDEN_CORPUS (a directory,
searched recursively, or files separated by os.pathsep) adds real tracks at the first
chunk size; SONIC_GOLDEN_LIMIT caps how many (default 40).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest

try:
    import librosa  # noqa: F401
    import numpy as np
    import pyloudnorm  # noqa: F401
    import soundfile as sf
    import soxr  # noqa: F401

    HAVE_AUDIO = True
    _IMPORT_ERROR = ""
except ImportError as exc:  # bare CI python3
    HAVE_AUDIO = False
    _IMPORT_ERROR = repr(exc)

# Set in the CI job that runs this inside the sidecar image: there a skip would hide a
# broken image, so a missing audio stack is a failure.
_REQUIRED = os.environ.get("SONIC_GOLDEN_REQUIRED") == "1"

_AUDIO_EXT = (".mp3", ".flac", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".wma", ".aiff", ".aif")


def _corpus() -> list[str]:
    raw = os.environ.get("SONIC_GOLDEN_CORPUS", "").strip()
    if not raw:
        return []
    limit = int(os.environ.get("SONIC_GOLDEN_LIMIT", "40"))
    found: list[str] = []
    for entry in raw.split(os.pathsep):
        if os.path.isdir(entry):
            for root, _dirs, files in sorted(os.walk(entry)):
                for f in sorted(files):
                    if f.lower().endswith(_AUDIO_EXT):
                        found.append(os.path.join(root, f))
        elif os.path.isfile(entry):
            found.append(entry)
    return found[:limit]


def _strip(result: dict) -> dict:
    out = dict(result)
    out.pop("_elapsed_sec", None)
    return out


class AudioStackTest(unittest.TestCase):
    @unittest.skipUnless(_REQUIRED, "SONIC_GOLDEN_REQUIRED is not set")
    def test_audio_stack_is_importable(self) -> None:
        self.assertTrue(HAVE_AUDIO, f"SONIC_GOLDEN_REQUIRED=1 but the audio stack is missing: {_IMPORT_ERROR}")


@unittest.skipUnless(HAVE_AUDIO, "needs the sidecar audio stack (librosa, soundfile, pyloudnorm, soxr)")
class GoldenAnalyzeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="analyze-golden-")
        cls._old_chunk = os.environ.get("SONIC_ANALYZE_CHUNK_SEC")
        cls.chunk_secs = [c.strip() for c in os.environ.get("SONIC_GOLDEN_CHUNK_SEC", "7,30").split(",") if c.strip()]
        rng = np.random.default_rng(20261015)

        def tone_mix(seconds: float, sr: int, channels: int, seed_shift: float) -> np.ndarray:
            t = np.arange(int(seconds * sr)) / sr
            beat = (np.sin(2 * np.pi * 2.0 * t) > 0.95).astype(np.float64)  # 120 BPM clicks
            sig = 0.3 * np.sin(2 * np.pi * (220 + seed_shift) * t) + 0.2 * np.sin(2 * np.pi * 330 * t)
            sig += 0.4 * beat * rng.standard_normal(t.size) + 0.02 * rng.standard_normal(t.size)
            sig *= 0.5 + 0.5 * np.sin(2 * np.pi * 0.05 * t) ** 2  # slow swell, not stationary
            cols = [np.roll(sig, 37 * c) * (1.0 - 0.1 * c) for c in range(channels)]
            return np.stack(cols, axis=1).astype(np.float32) if channels > 1 else sig.astype(np.float32)

        cls.files: list[str] = []

        def write(name: str, data: np.ndarray, sr: int, subtype: str = "PCM_16") -> None:
            path = os.path.join(cls.tmp, name)
            sf.write(path, data, sr, subtype=subtype)
            cls.files.append(path)

        write("stereo_44k.flac", tone_mix(75.0, 44100, 2, 0.0), 44100)
        write("mono_48k.wav", tone_mix(62.0, 48000, 1, 7.0), 48000, "FLOAT")
        write("six_channel_44k.wav", tone_mix(40.0, 44100, 6, 3.0), 44100)
        write("stereo_22k.ogg", tone_mix(50.0, 22050, 2, 11.0), 22050, "VORBIS")

        # Digital silence with isolated clicks: chunks that are almost entirely silent,
        # some with a single non-silent STFT frame.
        sil = np.zeros((44100 * 45, 2), dtype=np.float32)
        for at in (3.0, 9.9, 17.42, 31.0, 31.02):
            i = int(at * 44100)
            sil[i : i + 64] = 0.5
        sil[int(38 * 44100) :] = tone_mix(7.0, 44100, 2, 5.0)
        write("silence_clicks.wav", sil, 44100)

        write("short_3s.wav", tone_mix(3.0, 44100, 2, 1.0), 44100)
        write("tiny_0_3s.wav", tone_mix(0.3, 44100, 1, 2.0), 44100)
        write("tiny_0_45s.wav", tone_mix(0.45, 44100, 2, 4.0), 44100)
        write("digital_silence.wav", np.zeros((44100 * 20, 2), dtype=np.float32), 44100)
        write("mono_8k.wav", tone_mix(30.0, 8000, 1, 6.0), 8000)
        write("stereo_96k.flac", tone_mix(25.0, 96000, 2, 8.0), 96000, "PCM_24")
        write("eight_channel_44k.wav", tone_mix(15.0, 44100, 8, 9.0), 44100)
        try:
            write("stereo_44k.mp3", tone_mix(40.0, 44100, 2, 10.0), 44100, "MPEG_LAYER_III")
        except Exception:  # noqa: BLE001 — libsndfile without MPEG write support
            pass
        if shutil.which("ffmpeg"):
            m4a = os.path.join(cls.tmp, "stereo_44k.m4a")  # decoded through audioread
            subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", cls.files[0], "-t", "40", "-c:a", "aac", m4a],
                check=True,
            )
            cls.files.append(m4a)
        cls.synthetic = list(cls.files)
        cls.corpus = _corpus()

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)
        if cls._old_chunk is None:
            os.environ.pop("SONIC_ANALYZE_CHUNK_SEC", None)
        else:
            os.environ["SONIC_ANALYZE_CHUNK_SEC"] = cls._old_chunk

    def test_chunked_output_equals_whole_track_output(self) -> None:
        from analyze import analyze_one
        from analyze_reference import analyze_one_reference

        runs = [(p, c) for c in self.chunk_secs for p in self.synthetic]
        runs += [(p, self.chunk_secs[0]) for p in self.corpus]
        for path, chunk_sec in runs:
            os.environ["SONIC_ANALYZE_CHUNK_SEC"] = chunk_sec
            with self.subTest(path=os.path.basename(path), chunk_sec=chunk_sec):
                try:
                    ref = _strip(analyze_one_reference(path))
                except Exception as exc:  # noqa: BLE001 — both must then fail alike
                    with self.assertRaises(type(exc)):
                        analyze_one(path)
                    continue
                new = _strip(analyze_one(path))
                if new != ref:
                    diff = sorted(
                        k for k in set(ref) | set(new) if json.dumps(ref.get(k)) != json.dumps(new.get(k))
                    )
                    self.fail(f"output differs in {diff}")


if __name__ == "__main__":
    unittest.main()
