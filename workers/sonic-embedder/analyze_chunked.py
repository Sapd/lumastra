# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Chunked versions of the librosa / pyloudnorm stages that /analyze runs (analyze.py),
with the same output as running each stage over the whole track.

Why: analyze_one used to run every stage over the whole decoded track at once, and the
float64 intermediates grew about 0.27 GB per minute of audio (a 45-minute track peaked at
13.2 GB on preprod). The big ones were the tempogram behind beat_track (+4.0 GB for a
15-minute track), the tuning estimate inside chroma_cqt (+2.3 GB) and the full STFT
magnitude with its float64 spectral-centroid temporary (+1.6 GB). Here only the decoded
44.1 kHz mono signal (10.6 MB per minute) and per-frame arrays stay whole-track; each stage
runs over chunks of frames.

How the output stays the same:
  - Frame-local stages (STFT, RMS, energy, centroid, entropy, zero crossings, mel, peak
    picking, HPSS, the constant-Q responses) are computed per chunk from a slice of the
    signal that includes each frame's window, padded the way the whole-signal call pads at
    the track's edges. A column's FFT, sum or sparse product does not depend on how many
    other columns the call holds, so each frame comes out bit-identical. Chunks never have
    a single column: numpy reduces a one-column array in a different order.
  - Whole-track reductions keep the per-frame values and reduce them at the end with the
    same numpy call (means, medians, the chroma mean), or accumulate in the order numpy
    uses (the tempogram mean: numpy adds its F-ordered columns one after another).
  - The decode streams blocks through the same soundfile/audioread calls and
    soxr.ResampleStream, which gives the same samples as the one-shot resample librosa
    uses; the stereo file is never held whole.
  - pyloudnorm's K-weighting runs as scipy lfilter with its state carried between chunks,
    which is the same recurrence; the gating is pyloudnorm's code.

This mirrors librosa 0.10.2 internals (vqt, tempo, onset_strength, estimate_tuning, load)
and pyloudnorm 0.2.0's integrated_loudness. requirements.txt pins both; before bumping
either, run analyze_golden_test.py against real tracks (it compares with
analyze_reference.py, the whole-track code this replaced).

Dependency-light at import (numpy only); librosa & co. are imported inside the functions.
"""

from __future__ import annotations

import math
import warnings
from dataclasses import dataclass, field

import numpy as np

N_FFT = 2048  # librosa.stft default, used by every STFT stage below
HOP = 512  # librosa default hop_length
_HPSS_KERNEL = 31  # librosa.decompose.hpss default kernel_size
_HPSS_CONTEXT = _HPSS_KERNEL // 2 + 1  # frames of context each side for the time median
_TEMPO_AC_SIZE = 8.0  # librosa.feature.tempo default ac_size (seconds)
_CQT_BINS_PER_OCTAVE = 36  # librosa.feature.chroma_cqt defaults
_CQT_OCTAVES = 7
_DECODE_BLOCK_FRAMES = 1 << 18  # ~6 s at 44.1 kHz per soundfile read
_LUFS_BLOCK_SAMPLES = 1 << 20  # samples per K-weighting lfilter call


def n_frames(n_samples: int, hop: int) -> int:
    """Frame count of a centred STFT (librosa center=True, even n_fft) over n_samples."""
    return 1 + n_samples // hop


def chunk_ranges(total: int, size: int) -> list[tuple[int, int]]:
    """Split [0, total) into pieces of about `size`.

    A short remainder joins the previous piece, so no piece has a single column unless the
    whole range does (and then it equals the whole-track call).
    """
    if total <= 0:
        return []
    size = max(2, int(size))
    if total <= size:
        return [(0, total)]
    starts = list(range(0, total, size))
    if total - starts[-1] < max(2, size // 2):
        starts.pop()
    return [(a, starts[i + 1] if i + 1 < len(starts) else total) for i, a in enumerate(starts)]


def padded_segment(y: np.ndarray, lo: int, hi: int, mode: str) -> np.ndarray:
    """y[lo:hi] of the signal as a centred librosa call sees it: positions before 0 and
    from len(y) on are padding (`constant` = zeros, `edge` = the end sample)."""
    n = y.shape[-1]
    a = min(max(lo, 0), n)
    b = min(max(hi, a), n)
    core = y[a:b]
    left, right = a - lo, hi - b
    if left or right:
        return np.pad(core, (left, right), mode=mode)
    return core


def stft_frames(
    y: np.ndarray,
    f0: int,
    f1: int,
    n_fft: int,
    hop: int,
    window: str = "hann",
    pad_mode: str = "constant",
    dtype=None,
) -> np.ndarray:
    """Columns f0..f1-1 of librosa.stft(y, center=True, ...), computed from only the
    samples those frames cover."""
    import librosa

    lo = f0 * hop - n_fft // 2
    hi = (f1 - 1) * hop - n_fft // 2 + n_fft
    seg = padded_segment(y, lo, hi, pad_mode)
    return librosa.stft(seg, n_fft=n_fft, hop_length=hop, window=window, center=False, dtype=dtype)


# Library versions analyze_golden_test.py validated this module against.
VALIDATED_VERSIONS = {"librosa": "0.10.2.post1", "pyloudnorm": "0.2.0", "soxr": "1.1.0", "numpy": "1.26.4"}


def version_mismatches() -> list[str]:
    """Installed versions that differ from VALIDATED_VERSIONS (empty when all match)."""
    from importlib.metadata import PackageNotFoundError, version

    out = []
    for name, want in VALIDATED_VERSIONS.items():
        try:
            have = version(name)
        except PackageNotFoundError:
            have = "missing"
        if have != want:
            out.append(f"{name} {have} (validated {want})")
    return out


# --- decode -------------------------------------------------------------------


class _Sink:
    """Collects mono blocks into one preallocated float32 buffer, resampling on the way
    with soxr.ResampleStream (sample-identical to the one-shot soxr.resample librosa uses)."""

    def __init__(self, sr_native: int, sr: int, est_native: int):
        self.sr_native = sr_native
        self.sr = sr
        self.n_native = 0
        self._stream = None
        if sr_native != sr:
            import soxr

            self._stream = soxr.ResampleStream(sr_native, sr, 1, dtype="float32", quality="soxr_hq")
            est = int(math.ceil(max(0, est_native) * float(sr) / sr_native)) + 64
        else:
            est = max(0, est_native)
        self._buf = np.empty(max(est, 1), dtype=np.float32)
        self._len = 0

    def _append(self, x: np.ndarray) -> None:
        need = self._len + x.shape[0]
        if need > self._buf.shape[0]:
            grown = np.empty(max(need, int(self._buf.shape[0] * 1.5) + 1), dtype=np.float32)
            grown[: self._len] = self._buf[: self._len]
            self._buf = grown
        self._buf[self._len : need] = x
        self._len = need

    def push(self, mono: np.ndarray, last: bool) -> None:
        self.n_native += mono.shape[0]
        if self._stream is None:
            self._append(mono)
        else:
            self._append(self._stream.resample_chunk(np.ascontiguousarray(mono, dtype=np.float32), last=last))

    def finish(self) -> np.ndarray:
        """The signal librosa.load returns: resample() fixes the length to
        ceil(n * ratio) and casts to the input dtype."""
        import librosa

        if self._stream is None:
            return self._buf[: self._len]
        ratio = float(self.sr) / self.sr_native
        n_samples = int(np.ceil(self.n_native * ratio))
        return np.asarray(librosa.util.fix_length(self._buf[: self._len], size=n_samples), dtype=np.float32)


def _soundfile_mono(path: str, sr: int) -> np.ndarray:
    import librosa
    import soundfile as sf

    with sf.SoundFile(path) as f:
        sr_native = f.samplerate
        # librosa reads frames=-1, which soundfile turns into "the file's frame count";
        # read exactly that many, in blocks.
        remaining = f.frames
        sink = _Sink(sr_native, sr, remaining)
        # Hold each block back until the next one is read: a file that ends early (got < k)
        # can leave a 1-frame tail, which joins the previous block (numpy averages a
        # 1-frame block's channels in a different order).
        pending: np.ndarray | None = None
        while remaining > 0:
            k = remaining if remaining < 2 * _DECODE_BLOCK_FRAMES else _DECODE_BLOCK_FRAMES
            block = f.read(frames=k, dtype="float32", always_2d=False)
            got = block.shape[0]
            remaining -= k
            if pending is not None and got < 2:
                block = np.concatenate((pending, block))
            elif pending is not None:
                sink.push(librosa.to_mono(pending.T), last=False)
            pending = block
            if got < k:
                break
        if pending is not None:
            sink.push(librosa.to_mono(pending.T), last=True)
        else:
            sink.push(np.empty(0, dtype=np.float32), last=True)
    return sink.finish()


def _audioread_mono(path: str, sr: int, duration_hint: float) -> np.ndarray:
    import audioread
    import librosa

    with audioread.audio_open(path) as f:
        sr_native = f.samplerate
        ch = f.channels
        est_s = max(f.duration or 0.0, duration_hint or 0.0)
        sink = _Sink(sr_native, sr, int(math.ceil(est_s * sr_native)))
        carry = np.empty(0, dtype=np.float32)
        for raw in f:
            frame = librosa.util.buf_to_float(raw, dtype=np.float32)
            data = np.concatenate((carry, frame)) if carry.size else frame
            if ch <= 1:
                if data.size:
                    sink.push(data, last=False)
                carry = np.empty(0, dtype=np.float32)
                continue
            # Keep at least two whole frames back so the final block is never a single
            # frame (numpy averages a 1-frame block in a different order).
            usable = max(0, data.size // ch - 2) * ch
            if usable:
                sink.push(librosa.to_mono(data[:usable].reshape((-1, ch)).T), last=False)
            carry = data[usable:]
    if ch > 1 and carry.size:
        # librosa's reshape((-1, ch)) raises on a partial frame; so do we.
        tail = carry.reshape((-1, ch)).T
        sink.push(librosa.to_mono(tail), last=True)
    else:
        sink.push(np.empty(0, dtype=np.float32), last=True)
    return sink.finish()


def load_mono(path: str, sr: int, duration_hint: float = 0.0) -> tuple[np.ndarray, int]:
    """librosa.load(path, sr=sr, mono=True), same samples, without ever holding the
    decoded multichannel file or the native-rate copy whole. duration_hint (seconds, from
    the header probe) sizes the buffer when the decoder does not report a length."""
    import soundfile as sf

    try:
        return _soundfile_mono(path, sr), sr
    except sf.SoundFileRuntimeError:
        warnings.warn("PySoundFile failed. Trying audioread instead.", stacklevel=2)
        return _audioread_mono(path, sr, duration_hint), sr


# --- per-frame pass -------------------------------------------------------------


@dataclass
class FramePass:
    rms: np.ndarray  # per frame (librosa.feature.rms on the STFT magnitude)
    energy: np.ndarray  # per frame (sum of the power spectrum)
    centroid: np.ndarray  # per frame
    zcr: np.ndarray  # per frame
    mel: np.ndarray | None  # |mel power|, (128, frames), laid out like librosa's
    entropy: np.ndarray | None  # float32, per non-silent frame; None if a chunk failed
    vocal_ratio: np.ndarray | None  # per frame; None if a chunk failed
    pitches: np.ndarray = field(default_factory=lambda: np.empty(0, np.float32))  # piptrack peaks
    peak_mags: np.ndarray = field(default_factory=lambda: np.empty(0, np.float32))


def frame_pass(y: np.ndarray, sr: int, chunk_frames: int, log=None) -> FramePass:
    """Every feature of analyze.py that is computed from the 2048/512 STFT of y."""
    import librosa

    n = n_frames(y.shape[-1], HOP)
    # Whole-track arrays take the dtype librosa returns on the first chunk (rms, for one,
    # comes back float64 although it is computed in float32).
    out: dict[str, np.ndarray] = {}

    def put(name: str, f0: int, f1: int, values: np.ndarray) -> None:
        arr = out.get(name)
        if arr is None:
            arr = out[name] = np.empty(n, dtype=values.dtype)
        arr[f0:f1] = values

    vocal_ok = True
    entropy_parts: list[np.ndarray] | None = []
    pitch_parts: list[np.ndarray] = []
    pmag_parts: list[np.ndarray] = []
    mel: np.ndarray | None = None

    freqs = librosa.fft_frequencies(sr=sr)
    band = (freqs >= 300.0) & (freqs <= 4000.0)
    want_vocal = bool(band.any()) and n > 0

    for f0, f1 in chunk_ranges(n, chunk_frames):
        # Extra columns either side only for the HPSS time median (kernel 31).
        e0 = max(0, f0 - _HPSS_CONTEXT) if want_vocal and vocal_ok else f0
        e1 = min(n, f1 + _HPSS_CONTEXT) if want_vocal and vocal_ok else f1
        D = stft_frames(y, e0, e1, N_FFT, HOP)
        mag_ext = np.abs(D)
        del D
        i0, i1 = f0 - e0, f1 - e0
        mag = mag_ext[:, i0:i1]

        put("rms", f0, f1, librosa.feature.rms(S=mag)[0])
        spec = mag**2
        put("energy", f0, f1, spec.sum(axis=0))
        put("centroid", f0, f1, librosa.feature.spectral_centroid(S=mag, sr=sr)[0])

        # onset_strength's mel spectrogram (power 2, fmax = sr/2), kept whole-track.
        mel_c = np.abs(
            librosa.feature.melspectrogram(S=spec, sr=sr, n_fft=N_FFT, hop_length=HOP, fmax=0.5 * sr)
        )
        if mel is None:
            mel = np.empty((mel_c.shape[0], n), dtype=mel_c.dtype, order=_layout(mel_c))
        mel[:, f0:f1] = mel_c
        del mel_c

        # estimate_tuning's peak picking (piptrack); only the peaks are kept.
        pitch_c, pmag_c = librosa.piptrack(S=mag, sr=sr, n_fft=N_FFT)
        peak = pitch_c > 0
        pitch_parts.append(pitch_c[peak])
        pmag_parts.append(pmag_c[peak])
        del pitch_c, pmag_c, peak

        if entropy_parts is not None:
            try:
                col_sums = spec.sum(axis=0)
                nonzero = col_sums > 0
                if nonzero.any():
                    p = spec[:, nonzero] / col_sums[nonzero]
                    entropy_parts.append(_column_entropy(p))
            except Exception as exc:  # noqa: BLE001 — the whole-track code returns None too
                if log:
                    log(f"spectral entropy failed: {exc}")
                entropy_parts = None

        zseg = padded_segment(y, f0 * HOP - N_FFT // 2, (f1 - 1) * HOP - N_FFT // 2 + N_FFT, "edge")
        put("zcr", f0, f1, librosa.feature.zero_crossing_rate(zseg, center=False)[0])

        if want_vocal and vocal_ok:
            try:
                harm_band, _ = librosa.decompose.hpss(mag_ext[band, :], kernel_size=_HPSS_KERNEL)
                vocal_energy = (harm_band.astype(np.float64) ** 2).sum(axis=0)[i0:i1]
                fe_safe = np.nan_to_num(out["energy"][f0:f1], nan=0.0, posinf=0.0, neginf=0.0)
                put("vocal_ratio", f0, f1, np.clip(vocal_energy / (fe_safe.astype(np.float64) + 1e-12), 0.0, 1.0))
            except Exception as exc:  # noqa: BLE001 — optional signal, as in the whole-track code
                if log:
                    log(f"vocal-band ratio failed: {exc}")
                vocal_ok = False
        del mag_ext, mag, spec

    return FramePass(
        rms=out["rms"],
        energy=out["energy"],
        centroid=out["centroid"],
        zcr=out["zcr"],
        mel=mel,
        entropy=np.concatenate(entropy_parts) if entropy_parts else (None if entropy_parts is None else np.empty(0, np.float32)),
        vocal_ratio=out.get("vocal_ratio") if want_vocal and vocal_ok else None,
        pitches=np.concatenate(pitch_parts) if pitch_parts else np.empty(0, np.float32),
        peak_mags=np.concatenate(pmag_parts) if pmag_parts else np.empty(0, np.float32),
    )


def _column_entropy(p: np.ndarray) -> np.ndarray:
    """-(p * log(p + 1e-12)).sum(axis=0), summed in the order the whole-track array is.

    spec[:, mask] of the whole track is a C-ordered (1025, k) array, so numpy adds each
    column's bins one after another. A one-column array is contiguous both ways and numpy
    would sum it pairwise instead; give it a twin column so the order stays the same."""
    if p.shape[1] == 1:
        return _column_entropy(np.concatenate((p, p), axis=1))[:1]
    return -(p * np.log(p + 1e-12)).sum(axis=0)


# --- loudness -------------------------------------------------------------------


def integrated_loudness(y: np.ndarray, rate: int) -> float:
    """pyloudnorm.Meter(rate).integrated_loudness(y) for mono float32 y, streamed.

    The K-weighting filters run chunk by chunk with lfilter state carried over (the same
    recurrence, so the same samples); each stage's output is stored as float32 in between,
    as pyloudnorm's in-place column assignment does. Block energies are taken over the
    same sample ranges; the gating below is pyloudnorm 0.2.0's code with numChannels = 1."""
    import pyloudnorm as pyln
    import scipy.signal

    meter = pyln.Meter(rate)
    if y.ndim != 1 or not np.issubdtype(y.dtype, np.floating):
        raise ValueError("mono float audio expected")
    if y.shape[0] < meter.block_size * rate:
        raise ValueError("Audio must have length greater than the block size.")

    stages = list(meter._filters.values())
    coeffs = [(st.b, st.a, st.passband_gain) for st in stages]
    states = [np.zeros(max(len(a), len(b)) - 1) for b, a, _ in coeffs]

    numChannels = 1
    numSamples = y.shape[0]
    G = [1.0, 1.0, 1.0, 1.41, 1.41]  # channel gains
    T_g = meter.block_size
    Gamma_a = -70.0
    overlap = meter.overlap
    step = 1.0 - overlap
    T = numSamples / meter.rate
    numBlocks = int(np.round(((T - T_g) / (T_g * step))) + 1)
    j_range = np.arange(0, numBlocks)
    z = np.zeros(shape=(numChannels, numBlocks))

    bounds = [
        (int(T_g * (j * step) * meter.rate), int(T_g * (j * step + 1) * meter.rate)) for j in j_range
    ]
    buf = np.empty(0, dtype=np.float32)  # filtered samples [buf_start, buf_start + len(buf))
    buf_start = 0
    jb = 0
    for s0 in range(0, numSamples, _LUFS_BLOCK_SAMPLES):
        x = y[s0 : s0 + _LUFS_BLOCK_SAMPLES]
        for k, (b, a, gain) in enumerate(coeffs):
            out, states[k] = scipy.signal.lfilter(b, a, x, zi=states[k])
            x = np.empty(out.shape, dtype=y.dtype)
            x[:] = gain * out
        buf = np.concatenate((buf, x)) if buf.size else x
        buf_end = buf_start + buf.shape[0]
        while jb < numBlocks:
            lo, hi = bounds[jb]
            lo, hi = min(lo, numSamples), min(hi, numSamples)
            if hi > buf_end:
                break
            z[0, jb] = (1.0 / (T_g * meter.rate)) * np.sum(np.square(buf[lo - buf_start : hi - buf_start]))
            jb += 1
        keep_from = min(bounds[jb][0], numSamples) if jb < numBlocks else buf_end
        if keep_from > buf_start:
            buf = buf[keep_from - buf_start :].copy()
            buf_start = keep_from
    if jb != numBlocks:  # cannot happen: the last chunk ends at numSamples
        raise RuntimeError(f"loudness blocks {jb}/{numBlocks} after the last chunk")

    # --- pyloudnorm 0.2.0 Meter.integrated_loudness from here on, verbatim ---
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        l = [-0.691 + 10.0 * np.log10(np.sum([G[i] * z[i, j] for i in range(numChannels)])) for j in j_range]  # noqa: E741

    J_g = [j for j, l_j in enumerate(l) if l_j >= Gamma_a]

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        z_avg_gated = [np.mean([z[i, j] for j in J_g]) for i in range(numChannels)]
    Gamma_r = -0.691 + 10.0 * np.log10(np.sum([G[i] * z_avg_gated[i] for i in range(numChannels)])) - 10.0

    J_g = [j for j, l_j in enumerate(l) if (l_j > Gamma_r and l_j > Gamma_a)]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        z_avg_gated = np.nan_to_num(np.array([np.mean([z[i, j] for j in J_g]) for i in range(numChannels)]))

    with np.errstate(divide="ignore"):
        LUFS = -0.691 + 10.0 * np.log10(np.sum([G[i] * z_avg_gated[i] for i in range(numChannels)]))
    return LUFS


# --- onset, tempo, beats --------------------------------------------------------


def onset_envelope(mel: np.ndarray, sr: int) -> np.ndarray:
    """librosa.onset.onset_strength(y=y, sr=sr) from the whole-track |mel| matrix
    (power_to_db's top_db clamp needs the global maximum, so the mel stays whole)."""
    import librosa

    return librosa.onset.onset_strength(S=librosa.power_to_db(mel), sr=sr)


def tempo(onset_env: np.ndarray, sr: int, chunk_frames: int) -> np.ndarray:
    """librosa.feature.tempo(onset_envelope=onset_env, sr=sr) without the (689 x frames)
    float64 tempogram: columns are computed in blocks and summed in numpy's order."""
    import librosa

    win_length = librosa.time_to_frames(_TEMPO_AC_SIZE, sr=sr, hop_length=HOP).item()
    n = onset_env.shape[-1]
    padded = np.pad(onset_env, [(int(win_length // 2),) * 2], mode="linear_ramp", end_values=[0, 0])
    acc = np.zeros(win_length, dtype=np.float64)
    for c0, c1 in chunk_ranges(n, chunk_frames):
        tg = librosa.feature.tempogram(
            onset_envelope=padded[c0 : c1 + win_length - 1],
            sr=sr,
            hop_length=HOP,
            win_length=win_length,
            center=False,
        )
        # np.mean(tg, axis=-1) over the whole F-ordered tempogram adds the columns in order.
        for j in range(tg.shape[1]):
            acc += tg[:, j]
        del tg
    tg_mean = (acc / n)[:, np.newaxis]
    return librosa.feature.tempo(tg=tg_mean, sr=sr, hop_length=HOP, aggregate=None)


def danceability_autocorr(oe: np.ndarray, max_lag: int) -> np.ndarray:
    """np.correlate(oe, oe, mode="full")[oe.size - 1:][:max_lag], computing only those
    lags. numpy computes each lag as the same dot product, so the values are identical;
    the full correlation was O(n^2)."""
    n = oe.shape[0]
    hi = min(n, max_lag)
    ac = np.empty(hi, dtype=oe.dtype)
    for k in range(hi):
        ac[k] = np.dot(oe[k:], oe[: n - k])
    return ac


# --- key (chroma_cqt) -------------------------------------------------------------


def estimate_tuning(pitches: np.ndarray, peak_mags: np.ndarray) -> float:
    """librosa.estimate_tuning(y=y, sr=sr, bins_per_octave=36) from the piptrack peaks
    (pitch > 0) of every frame. A median and a histogram do not depend on order."""
    import librosa

    threshold = np.median(peak_mags) if pitches.size else 0.0
    return librosa.pitch_tuning(
        pitches[peak_mags >= threshold], resolution=0.01, bins_per_octave=_CQT_BINS_PER_OCTAVE
    )


@dataclass
class CqtInput:
    y: np.ndarray  # early-downsampled signal
    sr: float
    hop: int
    sr_top: float  # vqt's `sr` after the early downsample
    freqs: np.ndarray
    alpha: np.ndarray
    sqrt_lengths: np.ndarray
    n_frames: int  # columns of the stacked CQT (__trim_stack's max_col)


def cqt_prepare(y: np.ndarray, sr: int, tuning: float) -> CqtInput:
    """The first half of librosa.vqt as chroma_cqt calls it (cqt: 7 octaves x 36 bins,
    fmin C1, hop 512, soxr_hq, scale=True): filter layout and the early downsample.
    The caller can drop the full-rate signal afterwards."""
    import librosa
    from librosa import filters
    from librosa.core import constantq

    early_downsample = getattr(constantq, "__early_downsample")
    bins_per_octave = _CQT_BINS_PER_OCTAVE
    n_bins = _CQT_OCTAVES * bins_per_octave
    n_octaves = int(np.ceil(float(n_bins) / bins_per_octave))

    fmin = librosa.note_to_hz("C1")
    fmin = fmin * 2.0 ** (tuning / bins_per_octave)
    freqs = librosa.interval_frequencies(
        n_bins=n_bins, fmin=fmin, intervals="equal", bins_per_octave=bins_per_octave, sort=True
    )
    alpha = filters._relative_bandwidth(freqs=freqs)
    _, filter_cutoff = filters.wavelet_lengths(
        freqs=freqs, sr=sr, window="hann", filter_scale=1, gamma=0, alpha=alpha
    )
    nyquist = sr / 2.0
    if filter_cutoff > nyquist:
        raise librosa.ParameterError(
            f"Wavelet basis would exceed the Nyquist frequency={nyquist}. Try reducing the number of frequency bins."
        )
    y_ds, sr_ds, hop_ds = early_downsample(y, sr, HOP, "soxr_hq", n_octaves, nyquist, filter_cutoff, True)

    lengths, _ = filters.wavelet_lengths(freqs=freqs, sr=sr_ds, window="hann", filter_scale=1, gamma=0, alpha=alpha)

    # Frame count per octave (centred STFT) along the 2:1 pyramid; __trim_stack keeps the
    # smallest. resample(..., fix=True) makes each level ceil(len / 2) long.
    counts = []
    length, hop = y_ds.shape[-1], hop_ds
    for _ in range(n_octaves):
        counts.append(n_frames(length, hop))
        if hop % 2 == 0:
            hop //= 2
            length = int(np.ceil(length * (float(1) / 2)))
    return CqtInput(
        y=y_ds,
        sr=sr_ds,
        hop=hop_ds,
        sr_top=sr_ds,
        freqs=freqs,
        alpha=alpha,
        sqrt_lengths=np.sqrt(lengths),
        n_frames=min(counts),
    )


def chroma_mean(cq: CqtInput, chunk_frames: int) -> np.ndarray:
    """librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1), given cqt_prepare's output:
    the second half of vqt (per-octave responses, computed chunk by chunk), the scale,
    the chroma mapping and the per-frame inf-norm."""
    import librosa
    from librosa import filters
    from librosa.core import constantq

    vqt_filter_fft = getattr(constantq, "__vqt_filter_fft")
    bins_per_octave = _CQT_BINS_PER_OCTAVE
    n_bins = _CQT_OCTAVES * bins_per_octave
    n_octaves = _CQT_OCTAVES
    n_filters = min(bins_per_octave, n_bins)
    dtype = librosa.util.dtype_r2c(cq.y.dtype)
    max_col = cq.n_frames

    # |V| for the whole track, F-ordered like __trim_stack's output (float32, 1 KB/frame).
    C = np.empty((n_bins, max_col), dtype=np.float32, order="F")
    my_y, my_sr, my_hop = cq.y, cq.sr, cq.hop
    end = n_bins
    for i in range(n_octaves):
        sl = slice(-n_filters, None) if i == 0 else slice(-n_filters * (i + 1), -n_filters * i)
        fft_basis, n_fft, _ = vqt_filter_fft(
            my_sr, cq.freqs[sl], 1, 1, 0.01, window="hann", gamma=0, dtype=dtype, alpha=cq.alpha[sl]
        )
        fft_basis[:] *= np.sqrt(cq.sr_top / my_sr)
        rows = slice(end - n_filters, end)
        scale = cq.sqrt_lengths[rows][:, np.newaxis]
        for a, b in chunk_ranges(max_col, chunk_frames):
            D = stft_frames(my_y, a, b, n_fft, my_hop, window="ones", pad_mode="constant", dtype=dtype)
            resp = np.empty((fft_basis.shape[0], D.shape[-1]), dtype=D.dtype)
            resp[:] = fft_basis.dot(D)
            resp /= scale
            C[rows, a:b] = np.abs(resp)
            del D, resp
        end -= n_filters
        if i < n_octaves - 1 and my_hop % 2 == 0:
            my_hop //= 2
            my_sr /= 2.0
            my_y = librosa.resample(my_y, orig_sr=2, target_sr=1, res_type="soxr_hq", scale=True)
    del my_y

    cq_to_chr = filters.cq_to_chroma(n_bins, bins_per_octave=bins_per_octave, n_chroma=12, fmin=None, window=None)
    chroma: np.ndarray | None = None
    for a, b in chunk_ranges(max_col, chunk_frames):
        ch = np.einsum("cf,...ft->...ct", cq_to_chr, C[:, a:b], optimize=True)
        ch[ch < 0.0] = 0.0
        ch = librosa.util.normalize(ch, norm=np.inf, axis=-2)
        if chroma is None:
            # The mean below adds in a different order for C- and F-ordered arrays; keep
            # the layout the whole-track call produces (F, as the chunks come out).
            chroma = np.empty((ch.shape[0], max_col), dtype=ch.dtype, order=_layout(ch))
        chroma[:, a:b] = ch
    del C
    assert chroma is not None
    return chroma.mean(axis=1)


def _layout(a: np.ndarray) -> str:
    return "F" if a.flags.f_contiguous and not a.flags.c_contiguous else "C"
