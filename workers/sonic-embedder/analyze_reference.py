# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
The whole-track /analyze code as it was before analyze_chunked.py (main a93936d472),
kept unchanged as the reference for analyze_golden_test.py and for measuring memory.
Not used by the server. Every stage here holds full-length intermediates, so a long
track costs about 0.27 GB per minute of audio.
"""

from __future__ import annotations

import math
import sys
import time
from typing import Any

import numpy as np

from analyze import (
    SCHEMA_VERSION,
    _analyze_sr,
    _estimate_key,
    _max_duration_sec,
    _mood_heuristic,
)


def _danceability_proxy_reference(onset_env: np.ndarray) -> float:
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
    ac = np.correlate(oe, oe, mode="full")[oe.size - 1 :]
    ac = ac / (ac[0] + 1e-9)
    if ac.size < 8:
        return 0.0
    peak = float(np.max(ac[4 : min(ac.size, 400)]))
    return round(max(0.0, min(3.0, peak * 3.0)), 3)


def analyze_one_reference(path: str) -> dict[str, Any]:
    """Extract the RAW /analyze feature object for a single audio file.

    Raises on failure (empty audio, decode error); the caller wraps it into a
    {"path","error"} JSONL line.
    """
    import librosa  # lazy: heavy import (numba/llvmlite); paid only on /analyze
    import pyloudnorm as pyln

    t0 = time.time()

    # Cheap header-only duration probe (soundfile metadata — no PCM decode) BEFORE
    # committing to a full load. Every stage below scales with sample count, so an
    # oversized/misclassified file must be rejected here, not after it is already
    # sitting in RAM. See SONIC_ANALYZE_MAX_DURATION_SEC in the module docstring.
    max_duration = _max_duration_sec()
    probe_duration = float(librosa.get_duration(path=path))
    if probe_duration > max_duration:
        raise ValueError(
            f"duration {probe_duration:.0f}s exceeds SONIC_ANALYZE_MAX_DURATION_SEC="
            f"{max_duration:.0f}s — refusing to load full PCM (likely a misclassified "
            "non-music file)"
        )

    # Decode at a bounded sample rate (see SONIC_ANALYZE_SR) — high-res sources
    # otherwise decode at native resolution, multiplying memory for no analysis
    # benefit. librosa uses soundfile then audioread(ffmpeg) fallback for mp3.
    y, sr = librosa.load(path, sr=_analyze_sr(), mono=True)
    if y.size == 0:
        raise ValueError("empty audio")
    duration = float(librosa.get_duration(y=y, sr=sr))

    # --- Tempo + beats (FULL, uncapped — TS caps/decimates) ---
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr, units="frames"
    )
    tempo_arr = np.atleast_1d(tempo)
    tempo = float(tempo_arr[0]) if tempo_arr.size else 0.0
    if not math.isfinite(tempo):
        tempo = 0.0
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    # Ensure ascending (defensive; TS adapter also re-sorts) and round.
    beats_position = [round(float(b), 4) for b in np.sort(beat_times)]

    # --- Key (Krumhansl-Schmuckler over mean chroma) → bare key + scale ---
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key, scale = _estimate_key(chroma.mean(axis=1))

    # --- Loudness: EBU R128 integrated (pyloudnorm) ---
    loudness_lufs: float | None
    try:
        meter = pyln.Meter(sr)
        measured = float(meter.integrated_loudness(y))
        loudness_lufs = round(measured, 2) if math.isfinite(measured) else None
    except Exception:  # noqa: BLE001 — any measurement failure → null, TS derives
        loudness_lufs = None

    # --- Per-frame RMS + spectral energy (TS fade detection + energy curve) ---
    # Compute the STFT magnitude ONCE and reuse it for rms/centroid/energy/entropy
    # instead of each feature call recomputing its own full-resolution STFT.
    stft_mag = np.abs(librosa.stft(y))
    rms = librosa.feature.rms(S=stft_mag)[0]
    spec = stft_mag ** 2
    frame_energy = spec.sum(axis=0)
    # Sanitize: replace any NaN/Inf with 0 so a stray bad frame doesn't fail the
    # allow_nan=False JSON serialisation check and discard an otherwise-good track.
    rms_safe = np.nan_to_num(rms, nan=0.0, posinf=0.0, neginf=0.0)
    frame_energy_safe = np.nan_to_num(frame_energy, nan=0.0, posinf=0.0, neginf=0.0)
    frame_rms_list = [round(float(v), 6) for v in rms_safe.tolist()]
    frame_energy_list = [round(float(v), 4) for v in frame_energy_safe.tolist()]

    # Normalised average loudness 0..1 (Essentia "average_loudness" analogue).
    rms_norm = rms / (rms.max() + 1e-9)
    average_loudness = float(round(min(1.0, max(0.0, float(rms_norm.mean()))), 4))

    # --- danceability proxy + mood placeholder + extras heuristic inputs ---
    danceability = _danceability_proxy_reference(onset_env)
    spectral_centroid = float(librosa.feature.spectral_centroid(S=stft_mag, sr=sr).mean())
    zcr = float(librosa.feature.zero_crossing_rate(y)[0].mean())
    mood_tags = _mood_heuristic(spectral_centroid, zcr, tempo, average_loudness)

    # --- Vocal-band harmonic energy ratio (TS vocal-boundary derivation) ---
    # Per ~100ms bin: energy of the HARMONIC component in the vocal band
    # (300-4000 Hz) divided by total frame energy. Singing is sustained and
    # harmonic, so this rises during vocal phrases and falls in drum-only or
    # noise-heavy passages; the TS side derives first/last vocal boundaries
    # from it (first_vocal_start_ms / last_vocal_end_ms).
    # Memory: HPSS is run on the vocal-band SLICE only (~17% of bins) — running
    # it on the full spectrogram would add two full-size copies (H+P) on top of
    # stft_mag, blowing the /analyze memory bound for long tracks. Payload:
    # frames are mean-pooled into ~100ms bins (a 45-min track → ~27k floats).
    vocal_band_ratio: list[float] | None = None
    vocal_ratio_hop_ms: float | None = None
    try:
        freqs = librosa.fft_frequencies(sr=sr)
        band = (freqs >= 300.0) & (freqs <= 4000.0)
        if band.any() and stft_mag.shape[1] > 0:
            harm_band, _ = librosa.decompose.hpss(stft_mag[band, :])
            vocal_energy = (harm_band.astype(np.float64) ** 2).sum(axis=0)
            ratio = np.clip(
                vocal_energy / (frame_energy_safe.astype(np.float64) + 1e-12), 0.0, 1.0
            )
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
        print(f"[analyze] vocal-band ratio failed for {path}: {exc}", file=sys.stderr)
        vocal_band_ratio = None
        vocal_ratio_hop_ms = None

    # --- Spectral entropy (librosa equivalent for the TS voice/instrumental heuristic) ---
    # Per-frame: normalise power spectrum over freq bins, compute -sum(p * ln(p)).
    # Natural log (+ 1e-12 guard against log(0)); mean over frames.
    # Produces ~6-7 on most music (< 7.3 threshold the TS heuristic uses for
    # instrumental classification), giving the heuristic 3 features (zcr, centroid,
    # entropy) so the instrumental decision is driven by zcr + centroid rather than
    # always falling through to the 'voice' default.
    spectral_entropy_mean: float | None
    try:
        col_sums = spec.sum(axis=0)
        nonzero = col_sums > 0
        if nonzero.any():
            p = spec[:, nonzero] / col_sums[nonzero]
            frame_entropy = -(p * np.log(p + 1e-12)).sum(axis=0)
            val = float(np.mean(frame_entropy))
            spectral_entropy_mean = round(val, 4) if math.isfinite(val) else None
        else:
            spectral_entropy_mean = None
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
