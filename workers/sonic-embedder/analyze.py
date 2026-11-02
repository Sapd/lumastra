#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Music audio analysis for the sonic-embedder sidecar's POST /analyze endpoint.

Emits RAW audio features; all derivation (boundaries, fade/DJ-intro detection,
energy curve, voice/instrumental, key join, beat cap) lives in the TypeScript
adapter (essentia-analysis.service.ts deriveAnalysis()).

Environment variables:
    SONIC_ANALYZE_MAX_DURATION_SEC — reject (per-file error, not a crash) any input
                                      longer than this many seconds, from a header probe
                                      before decoding. Memory grows about 22 MB per
                                      minute of audio now (analyze_chunked.py), so this is
                                      a sanity cap against a misclassified video capture or
                                      corrupt duration metadata. Default 7200 (2 h).
    SONIC_ANALYZE_SR                — resample target instead of the native rate (librosa
                                      load semantics). Default 44100.
    SONIC_ANALYZE_CHUNK_SEC         — seconds of audio per analysis chunk, 5..120. Output-
                                      neutral; smaller chunks lower the per-job working set.
                                      Default 30.

/analyze contract (one JSON object per path):
    schema_version    int
    bpm               float    — beats per minute
    key               str      — bare pitch class "C".."B" with "#" (no 'm' suffix)
    scale             str      — "major" | "minor" (TS joins → "Am")
    average_loudness  float    — 0..1 normalised RMS
    loudness_lufs     float|None — EBU R128 integrated loudness (negative dB); None if unmeasurable
    danceability      float    — ~0..3 scale (DSP proxy)
    beats_position    [float]  — beat onset times in seconds, ascending
    frame_rms         [float]  — per-frame RMS
    frame_energy      [float]  — per-frame spectral energy
    duration          float    — seconds
    mood_tags         [str]    — lowercase, deduped, sorted (heuristic)
    extras            {object} — heuristic inputs for the TS voice/instrumental + DJ
                                  detectors, plus the vocal-band ratio signal for the
                                  TS vocal-boundary derivation (first/last vocal ms)

CLI: reads {"paths": [...]} on stdin (or paths as argv); writes one JSONL line
per path. Logs to stderr; stdout carries only JSONL. The server imports
analyze_paths(paths, threads).
"""

from __future__ import annotations

import json
import math
import os
import platform
import sys
import time
from typing import Any

# numba's JIT (pulled in by librosa.beat) crashes under its default host-CPU
# codegen on arm64 (SIGILL) — force the generic target there. On x86_64 the
# generic target instead SEGFAULTS, so set this ONLY on aarch64, and only when
# the operator hasn't pinned it. Must run before librosa/numba is imported.
if platform.machine().lower() in ("aarch64", "arm64") and "NUMBA_CPU_NAME" not in os.environ:
    os.environ["NUMBA_CPU_NAME"] = "generic"

import numpy as np

SCHEMA_VERSION = 1

# Krumhansl-Kessler key profiles (major / minor), normalised correlation method.
_KK_MAJOR = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
_KK_MINOR = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)
_PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

_DEFAULT_MAX_DURATION_SEC = 7200.0  # 2 h
_DEFAULT_ANALYZE_SR = 44100
_DEFAULT_CHUNK_SEC = 30.0


def _max_duration_sec() -> float:
    raw = os.environ.get("SONIC_ANALYZE_MAX_DURATION_SEC", "").strip()
    if raw:
        try:
            val = float(raw)
            if val > 0:
                return val
        except ValueError:
            pass
    return _DEFAULT_MAX_DURATION_SEC


def _analyze_sr() -> int:
    raw = os.environ.get("SONIC_ANALYZE_SR", "").strip()
    if raw:
        try:
            val = int(raw)
            if val > 0:
                return val
        except ValueError:
            pass
    return _DEFAULT_ANALYZE_SR


_versions_checked = False


def _warn_unvalidated_versions(ac) -> None:
    """Once per process: say so when the audio stack differs from the one the chunked
    code was proven identical on (analyze_golden_test.py)."""
    global _versions_checked
    if _versions_checked:
        return
    _versions_checked = True
    bad = ac.version_mismatches()
    if bad:
        print(
            "[analyze] WARNING: analyze_chunked.py was validated against other library versions: "
            + ", ".join(bad)
            + ". Run analyze_golden_test.py on real tracks before trusting /analyze output.",
            file=sys.stderr,
        )


def _chunk_frames(sr: int) -> int:
    """STFT frames per chunk (SONIC_ANALYZE_CHUNK_SEC). Output-neutral: it only trades
    the working set of one chunk against per-call overhead."""
    sec = _DEFAULT_CHUNK_SEC
    raw = os.environ.get("SONIC_ANALYZE_CHUNK_SEC", "").strip()
    if raw:
        try:
            val = float(raw)
            if math.isfinite(val) and val > 0:
                sec = min(max(val, 5.0), 120.0)  # the chunk's working set is not in the cost model
        except ValueError:
            pass
    return max(64, int(sec * sr / 512))


def _estimate_key(chroma_mean: np.ndarray) -> tuple[str, str]:
    """Krumhansl-Schmuckler key estimation from a 12-bin mean chroma vector.

    Returns (pitch_class, mode) where pitch_class is a bare name like "A"/"C#"
    (NO 'm' suffix) and mode is "major" | "minor". The TS side joins these into
    the Essentia-style "Am" string in exactly one place (deriveAnalysis).
    """
    best_corr = -2.0
    best_name = "C"
    best_mode = "major"
    for shift in range(12):
        name = _PITCH_NAMES[shift]
        maj = np.corrcoef(np.roll(_KK_MAJOR, shift), chroma_mean)[0, 1]
        minr = np.corrcoef(np.roll(_KK_MINOR, shift), chroma_mean)[0, 1]
        if not math.isnan(maj) and maj > best_corr:
            best_corr, best_name, best_mode = maj, name, "major"
        if not math.isnan(minr) and minr > best_corr:
            best_corr, best_name, best_mode = minr, name, "minor"
    return best_name, best_mode


def _danceability_proxy(onset_env: np.ndarray) -> float:
    """A DSP danceability proxy on Essentia's ~0..3 scale (NOT Spotify 0..1).

    ⚠️ NEEDS CALIBRATION. Essentia's Danceability algo measures the
    strength/regularity of the beat via a detrended-fluctuation-style metric.
    We approximate with the autocorrelation peak of the onset envelope (pulse
    clarity), scaled to roughly match Essentia's empirical 0..3 spread. This is
    a placeholder calibrated by eyeball — a real migration would calibrate
    against a labelled set or port the DSP Danceability algo (x86_64 only).

    The TS adapter clamps this to [0, 3] and passes it through UNTOUCHED — it
    must stay on the ~0..3 scale (downstream consumers depend on it, NOT 0..1).
    """
    if onset_env.size == 0:
        return 0.0
    oe = onset_env - onset_env.mean()
    if np.allclose(oe, 0):
        return 0.0
    if oe.size < 8:
        return 0.0
    # Only lags 0..399 are read, so compute only those (the same dot products
    # np.correlate(oe, oe, "full") computes, without its O(n^2) cost).
    from analyze_chunked import danceability_autocorr

    ac = danceability_autocorr(oe, 400)
    ac = ac / (ac[0] + 1e-9)
    peak = float(np.max(ac[4 : min(ac.size, 400)]))
    return round(max(0.0, min(3.0, peak * 3.0)), 3)


def _mood_heuristic(
    spectral_centroid: float, zcr: float, tempo: float, energy: float
) -> list[str]:
    """PLACEHOLDER mood tags from cheap spectral features. NOT the real model.

    ⚠️ NEEDS CALIBRATION. Mirrors Essentia's mood_* label vocabulary so the
    downstream Jaccard/colour code sees the same tag space. Production mood needs
    the real classifier (Gaia/TF SVM weights are CC BY-NC-SA — NonCommercial,
    license-incompatible with the commercial tier) — see the eval doc.

    Reality check: the prod static binary is Gaia-less, so mood_tags is EMPTY on
    every analyzed track today — this heuristic is at worst ≥ parity. Output is
    lowercase, deduped, sorted (the contract the TS adapter expects).
    """
    tags: list[str] = []
    if energy > 0.6 and tempo > 120:
        tags.append("party")
    if spectral_centroid > 3000 and zcr > 0.08:
        tags.append("aggressive")
    if spectral_centroid < 1500 and energy < 0.4:
        tags.append("relaxed")
    if tempo > 125 and spectral_centroid > 2500:
        tags.append("electronic")
    if energy < 0.35 and tempo < 100:
        tags.append("sad")
    if energy >= 0.5 and tempo >= 100 and spectral_centroid >= 1500:
        tags.append("happy")
    if spectral_centroid < 1800 and zcr < 0.05:
        tags.append("acoustic")
    return sorted(set(t.lower() for t in tags))


def analyze_one(path: str) -> dict[str, Any]:
    """Extract the RAW /analyze feature object for a single audio file.

    Every stage runs chunk by chunk (analyze_chunked.py) with the same output as the
    whole-track code (analyze_reference.py): memory is the decoded 44.1 kHz mono signal
    (10.6 MB per minute) plus per-frame arrays and one chunk's working set, instead of
    about 0.27 GB per minute of audio.

    Raises on failure (empty audio, decode error); the caller wraps it into a
    {"path","error"} JSONL line.
    """
    import librosa  # lazy: heavy import (numba/llvmlite); paid only on /analyze

    import analyze_chunked as ac

    t0 = time.time()

    # Cheap header-only duration probe (soundfile metadata — no PCM decode) BEFORE
    # committing to a decode. See SONIC_ANALYZE_MAX_DURATION_SEC in the module docstring.
    max_duration = _max_duration_sec()
    probe_duration = float(librosa.get_duration(path=path))
    if probe_duration > max_duration:
        raise ValueError(
            f"duration {probe_duration:.0f}s exceeds SONIC_ANALYZE_MAX_DURATION_SEC="
            f"{max_duration:.0f}s — refusing to decode it"
        )

    # Decode at a bounded sample rate (see SONIC_ANALYZE_SR): the same samples as
    # librosa.load(path, sr=..., mono=True), streamed block by block.
    _warn_unvalidated_versions(ac)
    y, sr = ac.load_mono(path, _analyze_sr(), probe_duration)
    if y.size == 0:
        raise ValueError("empty audio")
    duration = float(librosa.get_duration(y=y, sr=sr))
    chunk = _chunk_frames(sr)

    def _log(msg: str) -> None:
        print(f"[analyze] {msg} for {path}", file=sys.stderr)

    # --- Everything computed from the 2048/512 STFT (one pass over the track) ---
    fp = ac.frame_pass(y, sr, chunk, log=_log)

    # --- Loudness: EBU R128 integrated (pyloudnorm's algorithm, streamed) ---
    loudness_lufs: float | None
    try:
        measured = float(ac.integrated_loudness(y, sr))
        loudness_lufs = round(measured, 2) if math.isfinite(measured) else None
    except ValueError:  # shorter than the 400 ms gating block, as pyloudnorm raises
        loudness_lufs = None
    except Exception as exc:  # noqa: BLE001 — any measurement failure → null, TS derives
        _log(f"loudness failed: {exc!r}")
        loudness_lufs = None

    # --- Tempo + beats (FULL, uncapped — TS caps/decimates) ---
    assert fp.mel is not None
    onset_env = ac.onset_envelope(fp.mel, sr)
    fp.mel = None
    if onset_env.any():
        bpm = ac.tempo(onset_env, sr, chunk)
        tempo, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sr, bpm=bpm, units="frames"
        )
    else:  # beat_track returns this without estimating a tempo
        tempo, beat_frames = 0.0, np.array([], dtype=int)
    tempo_arr = np.atleast_1d(tempo)
    tempo = float(tempo_arr[0]) if tempo_arr.size else 0.0
    if not math.isfinite(tempo):
        tempo = 0.0
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    # Ensure ascending (defensive; TS adapter also re-sorts) and round.
    beats_position = [round(float(b), 4) for b in np.sort(beat_times)]

    # --- Key (Krumhansl-Schmuckler over mean chroma) → bare key + scale ---
    tuning = ac.estimate_tuning(fp.pitches, fp.peak_mags)
    cq = ac.cqt_prepare(y, sr, tuning)
    del y  # the CQT only needs the early-downsampled signal from here on
    key, scale = _estimate_key(ac.chroma_mean(cq, chunk))
    del cq

    # --- Per-frame RMS + spectral energy (TS fade detection + energy curve) ---
    rms = fp.rms
    # Sanitize: replace any NaN/Inf with 0 so a stray bad frame doesn't fail the
    # allow_nan=False JSON serialisation check and discard an otherwise-good track.
    rms_safe = np.nan_to_num(rms, nan=0.0, posinf=0.0, neginf=0.0)
    frame_energy_safe = np.nan_to_num(fp.energy, nan=0.0, posinf=0.0, neginf=0.0)
    frame_rms_list = [round(float(v), 6) for v in rms_safe.tolist()]
    frame_energy_list = [round(float(v), 4) for v in frame_energy_safe.tolist()]

    # Normalised average loudness 0..1 (Essentia "average_loudness" analogue).
    rms_norm = rms / (rms.max() + 1e-9)
    average_loudness = float(round(min(1.0, max(0.0, float(rms_norm.mean()))), 4))

    # --- danceability proxy + mood placeholder + extras heuristic inputs ---
    danceability = _danceability_proxy(onset_env)
    spectral_centroid = float(fp.centroid.mean())
    zcr = float(fp.zcr.mean())
    mood_tags = _mood_heuristic(spectral_centroid, zcr, tempo, average_loudness)

    # --- Vocal-band harmonic energy ratio (TS vocal-boundary derivation) ---
    # Per ~100ms bin: energy of the HARMONIC component in the vocal band
    # (300-4000 Hz) divided by total frame energy. Singing is sustained and
    # harmonic, so this rises during vocal phrases and falls in drum-only or
    # noise-heavy passages; the TS side derives first/last vocal boundaries
    # from it (first_vocal_start_ms / last_vocal_end_ms). HPSS runs on the
    # vocal-band slice only, chunk by chunk (frame_pass). Payload: frames are
    # mean-pooled into ~100ms bins (a 45-min track → ~27k floats).
    vocal_band_ratio: list[float] | None = None
    vocal_ratio_hop_ms: float | None = None
    try:
        ratio = fp.vocal_ratio
        if ratio is not None:
            hop_sec = 512.0 / sr  # librosa.stft default hop_length (n_fft 2048 // 4)
            bin_frames = max(1, int(round(0.1 / hop_sec)))
            n_bins = int(math.ceil(ratio.size / bin_frames))
            if n_bins > 0:
                padded = np.pad(ratio, (0, n_bins * bin_frames - ratio.size), mode="edge")
                pooled = padded.reshape(n_bins, bin_frames).mean(axis=1)
                pooled = np.nan_to_num(pooled, nan=0.0, posinf=0.0, neginf=0.0)
                vocal_band_ratio = [round(float(v), 4) for v in pooled.tolist()]
                vocal_ratio_hop_ms = round(bin_frames * hop_sec * 1000.0, 3)
    except Exception as exc:  # noqa: BLE001 — optional signal; never fail the track
        _log(f"vocal-band ratio failed: {exc}")
        vocal_band_ratio = None
        vocal_ratio_hop_ms = None

    # --- Spectral entropy (librosa equivalent for the TS voice/instrumental heuristic) ---
    # Per-frame: normalise power spectrum over freq bins, compute -sum(p * ln(p)).
    # Natural log (+ 1e-12 guard against log(0)); mean over non-silent frames.
    # Produces ~6-7 on most music (< 7.3 threshold the TS heuristic uses for
    # instrumental classification), giving the heuristic 3 features (zcr, centroid,
    # entropy) so the instrumental decision is driven by zcr + centroid rather than
    # always falling through to the 'voice' default.
    spectral_entropy_mean: float | None = None
    try:
        if fp.entropy is not None and fp.entropy.size:
            val = float(np.mean(fp.entropy))
            spectral_entropy_mean = round(val, 4) if math.isfinite(val) else None
    except Exception:  # noqa: BLE001 — guard against any numpy edge case
        spectral_entropy_mean = None

    elapsed = round(time.time() - t0, 2)
    return {
        "schema_version": SCHEMA_VERSION,
        "bpm": round(tempo, 2),
        "key": key,
        "scale": scale,
        "average_loudness": average_loudness,
        "loudness_lufs": loudness_lufs,
        "danceability": danceability,
        "beats_position": beats_position,
        "frame_rms": frame_rms_list,
        "frame_energy": frame_energy_list,
        "duration": round(duration, 2),
        "mood_tags": mood_tags,
        "extras": {
            # librosa-derived voice/instrumental heuristic inputs:
            "zcr_mean": round(zcr, 6),
            "spectral_centroid_mean": round(spectral_centroid, 2),
            "spectral_entropy_mean": spectral_entropy_mean,
            "dynamic_complexity": None,
            # Neutral fallbacks → TS fade uses RMS-scan, DJ-intro uses profile branch:
            "silence_rate_60": 0.0,
            "spectral_complexity_var": 0.0,
            "band_ratio_mean": [],
            "band_ratio_var": [],
            # Vocal-boundary raw signal (see block above); None when unavailable.
            "vocal_band_ratio": vocal_band_ratio,
            "vocal_ratio_hop_ms": vocal_ratio_hop_ms,
        },
        # Internal timing (non-contract; ignored by the TS adapter).
        "_elapsed_sec": elapsed,
    }


def analyze_paths(paths: list[str], threads: int | None = None) -> list[str]:
    """Analyze a batch of audio paths; return JSONL lines (one per input path).

    Each line is {"path":..,"analysis":{..}} on success or {"path":..,"error":..}
    on failure — the same discriminated convention as embed_paths in embed.py.
    Lines are returned in input order (the server joins them into the response).

    `threads` caps the numeric BLAS/numba thread budget for this batch. It is
    applied via _apply_thread_budget below (the librosa/numpy analogue of the
    torch.set_num_threads cap /embed uses).
    """
    _apply_thread_budget(threads)
    lines: list[str] = []
    for p in paths:
        try:
            res = analyze_one(p)
            lines.append(
                json.dumps({"path": p, "analysis": res}, ensure_ascii=False, allow_nan=False) + "\n"
            )
        except Exception as exc:  # noqa: BLE001 — per-file isolation
            print(f"[analyze] error on {p}: {exc}", file=sys.stderr)
            lines.append(
                json.dumps(
                    {"path": p, "error": f"{type(exc).__name__}: {exc}"},
                    ensure_ascii=False,
                    allow_nan=False,
                )
                + "\n"
            )
    return lines


def _apply_thread_budget(threads: int | None) -> None:
    """Best-effort CPU thread cap for the librosa/numpy stack.

    librosa has no single thread knob; the practical levers are the BLAS env
    vars (numpy/scipy) and numba's threading layer. We set the OMP/MKL/numba
    env vars so a per-request cap can yield to the serving path, mirroring the
    intent of /embed's torch.set_num_threads(). Only applied when threads > 0;
    absent/0 leaves the sidecar env defaults in place.
    """
    if threads is None or threads <= 0:
        return
    val = str(threads)
    # NUMBA_NUM_THREADS is deliberately NOT in this list. It is the SIZE of
    # numba's thread pool, fixed once the pool launches; numba re-reads the env
    # on a later config reload and raises "Cannot set NUMBA_NUM_THREADS to a
    # different value once the threads have been launched". Writing it here
    # poisoned the process: every request after one with a different `threads`
    # failed until a restart (e.g. /cluster threads=2, then /analyze with the
    # default). server.py sets it ONCE at startup; per request we only narrow
    # the active count inside that pool.
    for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS",
                "NUMEXPR_NUM_THREADS"):
        os.environ[var] = val
    try:
        import numba  # type: ignore[import]
        # set_num_threads() may only select up to the launched pool size.
        pool = int(getattr(numba.config, "NUMBA_NUM_THREADS", threads) or threads)
        numba.set_num_threads(max(1, min(threads, pool)))
    except Exception:  # noqa: BLE001 — numba may not expose the API / not installed
        pass


def main() -> None:
    if len(sys.argv) > 1:
        paths = sys.argv[1:]
    else:
        raw = sys.stdin.read().strip()
        paths = json.loads(raw).get("paths", []) if raw else []
    if not paths:
        print("[analyze] no paths", file=sys.stderr)
        return
    for line in analyze_paths(paths):
        sys.stdout.write(line)
        sys.stdout.flush()


if __name__ == "__main__":
    main()
