# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
/embed with a bounded decode: read only the 7 seconds the model embeds.

msclap 1.3.4's get_audio_embeddings() (CLAPWrapper.read_audio/load_audio_into_tensor)
decodes the WHOLE file with torchaudio, resamples it to 44.1 kHz, flattens the channels
(reshape(-1): all of channel 0, then all of channel 1, ...) and keeps ONE crop of
W = 7 * 44100 samples whose start is random.randrange(C*N - W) over that flattened
series. For a 45-minute 48 kHz file that is +5.1 GB of RSS to use 1.2 MB of audio
(preprod 2026-10-15); prod has 147 tracks longer than an hour.

This module produces the same crop without the full decode:
  1. ffprobe the header (duration, sample rate, channels),
  2. draw the start like msclap (random.randrange over C*N - W, N the 44.1 kHz length
     torchaudio's resampler would produce) and map it to (channel, offset),
  3. decode only that span (plus a margin) with `ffmpeg -ss -t`, resample it with the
     same torchaudio Resample msclap uses, starting on an input sample where the
     resampler's polyphase grid lines up with the whole-file resample,
  4. run msclap's audio path: clap.audio_encoder(x)[0] on a (1, W) tensor.

A crop that runs past the end of a channel continues at the start of the next one, as
msclap's flattened series does. The channel's real end comes from decoding to EOF, not
from the header: an mp3 header overstated the length by 2016 samples on preprod.

Measured on preprod (2026-10-15, flac 48 kHz, mp3, wav, real library files): the decoded
crop equals msclap's crop for the same start sample for sample (max |diff| 0.0) and the
embeddings match (cosine >= 0.9999999). The crop distribution is msclap's, so stored
vectors stay comparable and nothing has to be re-embedded (processing_version stays 1).
Files shorter than MIN_WINDOWED_SEC, and files ffprobe cannot read, keep using msclap's
own path unchanged (their full decode is small).
"""

from __future__ import annotations

import json
import math
import random
import subprocess
from dataclasses import dataclass

TARGET_SR = 44100
WINDOW_SEC = 7  # msclap config_2023.yml `duration`
WINDOW = WINDOW_SEC * TARGET_SR
# Input context around a span so the resampler's edge samples see real audio, and the
# decoder's first frames after a seek (mp3 bit reservoir) are discarded.
MARGIN_SEC = 0.5
FFMPEG_TIMEOUT_S = 120
# Below this, msclap's own full decode is cheap: keep it (and its repeat-pad branch).
MIN_WINDOWED_SEC = 30.0
# torchaudio's Resample builds a kernel of about (44100/g) * (sr/g) floats, g the gcd of
# the two rates. Common rates stay small (48 kHz: 147 * 160); an odd one (44101 Hz: g = 1)
# would need gigabytes. msclap's own path builds the same kernel, so such a file is
# refused with a clear error instead of being decoded at all.
MAX_RESAMPLER_TAPS = 2_000_000
# More padding than this means the header overstated the length by over a second (a
# truncated file, a VBR stream without a length header): use msclap's full decode.
MAX_PAD_SAMPLES = TARGET_SR


@dataclass(frozen=True)
class AudioInfo:
    duration_s: float
    sample_rate: int
    channels: int


def probe(path: str, timeout_s: float = 30.0) -> AudioInfo | None:
    """Header-only probe of the first audio stream. None when ffprobe cannot read it."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=sample_rate,channels,duration:format=duration",
             "-of", "json", path],
            capture_output=True, timeout=timeout_s, check=False,
        )
    except (OSError, ValueError, subprocess.SubprocessError):  # ValueError: NUL in path
        return None
    if out.returncode != 0:
        return None
    try:
        data = json.loads(out.stdout or b"{}")
        stream = (data.get("streams") or [{}])[0]
        sr = int(stream.get("sample_rate") or 0)
        ch = int(stream.get("channels") or 0)
        dur_raw = stream.get("duration") or (data.get("format") or {}).get("duration")
        dur = float(dur_raw) if dur_raw not in (None, "N/A") else 0.0
    except (ValueError, TypeError, IndexError):
        return None
    if sr <= 0 or ch <= 0 or not math.isfinite(dur) or dur <= 0:
        return None
    return AudioInfo(duration_s=dur, sample_rate=sr, channels=ch)


def resampler_is_feasible(sr_in: int) -> bool:
    g = math.gcd(sr_in, TARGET_SR)
    return (TARGET_SR // g) * (sr_in // g) <= MAX_RESAMPLER_TAPS


def resampled_length(n_in: int, sr_in: int) -> int:
    """Length torchaudio's Resample(sr_in, 44100) returns for n_in input samples."""
    if sr_in == TARGET_SR:
        return n_in
    g = math.gcd(sr_in, TARGET_SR)
    orig, new = sr_in // g, TARGET_SR // g
    return int(math.ceil(new * n_in / orig))


@dataclass(frozen=True)
class Piece:
    channel: int
    start: int   # in 44.1 kHz samples within the channel
    length: int  # at most this many; fewer when the channel ends first


def choose_start(info: AudioInfo, rng: random.Random | None = None) -> tuple[int, int] | None:
    """(channel, offset in 44.1 kHz samples) where msclap's crop of the flattened series
    starts, or None for a file short enough to keep msclap's own path."""
    if info.duration_s < MIN_WINDOWED_SEC:
        return None
    n_in = int(round(info.duration_s * info.sample_rate))
    n = resampled_length(n_in, info.sample_rate)
    total = info.channels * n
    if WINDOW >= total:
        return None
    return divmod((rng or random).randrange(total - WINDOW), n)


def _decode(path: str, start_s: float, dur_s: float, channels: int) -> "np.ndarray":
    """Decode [start_s, start_s + dur_s) at the native rate: (channels, frames) float32."""
    import numpy as np

    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start_s:.9f}", "-t", f"{dur_s:.9f}",
           "-i", path, "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"ffmpeg took over {FFMPEG_TIMEOUT_S}s to decode the window") from None
    if out.returncode != 0:
        err = out.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["?"]
        raise RuntimeError(f"ffmpeg could not decode the window: {err[0][:300]}")
    pcm = np.frombuffer(out.stdout, dtype=np.float32)
    frames = pcm.size // channels
    return pcm[: frames * channels].reshape(frames, channels).T


def read_piece(path: str, info: AudioInfo, piece: Piece) -> "np.ndarray":
    """The 44.1 kHz samples [piece.start, piece.start + piece.length) of one channel,
    or fewer when the channel ends before that."""
    import numpy as np

    sr = info.sample_rate
    if sr == TARGET_SR:
        lead = min(piece.start, int(MARGIN_SEC * sr))
        i0 = piece.start - lead
        audio = _decode(path, i0 / sr, (lead + piece.length) / sr + MARGIN_SEC, info.channels)
        seg = audio[piece.channel, lead: lead + piece.length]
    else:
        import torch
        import torchaudio.transforms as T

        g = math.gcd(sr, TARGET_SR)
        orig, new = sr // g, TARGET_SR // g
        # Start on a block boundary of the polyphase resampler: output sample k*new
        # then comes from input sample k*orig, exactly as in the whole-file resample.
        want_in = piece.start * orig / new
        block = max(0, int((want_in - MARGIN_SEC * sr) // orig))
        i0 = block * orig
        k0 = block * new
        span_in = (piece.start + piece.length - k0) * orig / new + MARGIN_SEC * sr
        audio = _decode(path, i0 / sr, span_in / sr, info.channels)
        if audio.shape[1] == 0:
            return np.zeros(0, dtype=np.float32)
        chan = torch.from_numpy(np.ascontiguousarray(audio[piece.channel]))
        res = T.Resample(sr, TARGET_SR)(chan).numpy()
        # At the real end of the stream Resample stops at ceil(new * frames / orig),
        # the same last sample the whole-file resample ends on.
        seg = res[piece.start - k0: piece.start - k0 + piece.length]
    return seg


def read_crop(path: str, info: AudioInfo, channel: int, offset: int) -> "np.ndarray | None":
    """W samples of the flattened series from (channel, offset): the rest of that
    channel, then the start of the next one, as msclap's reshape(-1) lays them out.
    None when the audio ended more than a second before the header said it would."""
    import numpy as np

    parts = []
    remaining = WINDOW
    while remaining > 0 and channel < info.channels:
        seg = read_piece(path, info, Piece(channel=channel, start=offset, length=remaining))
        parts.append(seg)
        remaining -= seg.shape[0]
        channel, offset = channel + 1, 0
    if remaining > MAX_PAD_SAMPLES:
        return None
    if remaining > 0:
        # The header overstated the length by a few ms (mp3 encoder padding) and the
        # crop ran off the last channel's real end: pad that sliver with silence.
        parts.append(np.zeros(remaining, dtype=np.float32))
    return np.concatenate(parts).astype(np.float32)


def embed_windowed(model, path: str, info: AudioInfo, rng: random.Random | None = None):
    """1024-dim embedding tensor for `path` via the bounded decode, or None when the file
    should go through msclap's own path (shorter than MIN_WINDOWED_SEC, or the audio
    ends well before its header says)."""
    import torch

    if not resampler_is_feasible(info.sample_rate):
        raise RuntimeError(
            f"unsupported sample rate {info.sample_rate} Hz: resampling it to 44.1 kHz "
            "would need gigabytes of memory"
        )
    start = choose_start(info, rng)
    if start is None:
        return None
    crop = read_crop(path, info, *start)
    if crop is None:
        return None
    x = torch.from_numpy(crop).reshape(1, -1)
    if getattr(model, "use_cuda", False) and torch.cuda.is_available():
        x = x.cuda()
    with torch.no_grad():
        return model.clap.audio_encoder(x)[0]
