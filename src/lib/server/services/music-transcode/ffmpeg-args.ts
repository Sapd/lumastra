// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type {
    EncodeArgsInput,
    StreamCopySeekArgsInput,
    AacExtraOptions,
    MusicCodec,
} from './types.js';
import { MEDIA_PROTOCOL_WHITELIST } from '../../utils/media-protocol-whitelist.js';

function validateEncodeInput(input: { bitrateKbps: number; timeOffset: number }): void {
    if (!Number.isInteger(input.bitrateKbps) || input.bitrateKbps <= 0) {
        throw new Error(`Invalid bitrateKbps: ${input.bitrateKbps}`);
    }
    if (!Number.isFinite(input.timeOffset) || input.timeOffset < 0) {
        throw new Error(`Invalid timeOffset: ${input.timeOffset}`);
    }
}

function validateSeekInput(input: { timeOffset: number }): void {
    if (!Number.isFinite(input.timeOffset) || input.timeOffset < 0) {
        throw new Error(`Invalid timeOffset: ${input.timeOffset}`);
    }
}

function seekPrefix(timeOffset: number): string[] {
    return timeOffset > 0 ? ['-ss', String(timeOffset)] : [];
}

/**
 * `-protocol_whitelist file -i <path>`.
 *
 * Every caller passes a path resolved by `resolveMediaPath` (local-disk only
 * — see `media-protocol-whitelist.ts`), so `file` is the only protocol the
 * input needs. The whitelist alone is NOT enough for music: with `file`
 * allowed, an ffconcat script saved as a track still follows an HLS playlist
 * to an absolute path in another library (fix plan 6, Task 7 fix round 5).
 * Playlist/manifest bodies are therefore refused by content twice — at scan
 * time (`processAudioFile` → `sniffNewFileForScan`/`sniffContentChangeForScan`)
 * and before every spawn (`assertTranscodeSourceIsMedia`, `source-guard.ts`,
 * run first by `MusicTranscodeService.streamFor`).
 */
function inputArgs(path: string): string[] {
    return ['-protocol_whitelist', MEDIA_PROTOCOL_WHITELIST, '-i', path];
}

export function buildMp3EncodeArgs(input: EncodeArgsInput): string[] {
    validateEncodeInput(input);
    return [
        ...seekPrefix(input.timeOffset),
        ...inputArgs(input.srcPath),
        '-vn',
        '-map',
        '0:a:0',
        '-c:a',
        'libmp3lame',
        '-b:a',
        `${input.bitrateKbps}k`,
        '-ac',
        '2',
        '-ar',
        '44100',
        '-f',
        'mp3',
        '-id3v2_version',
        '0',
        '-write_id3v1',
        '0',
        '-write_xing',
        '0',
        'pipe:1',
    ];
}

export function buildOpusEncodeArgs(input: EncodeArgsInput): string[] {
    validateEncodeInput(input);
    return [
        ...seekPrefix(input.timeOffset),
        ...inputArgs(input.srcPath),
        '-vn',
        '-map',
        '0:a:0',
        '-c:a',
        'libopus',
        '-b:a',
        `${input.bitrateKbps}k`,
        '-vbr',
        'off',
        '-application',
        'audio',
        '-ac',
        '2',
        '-ar',
        '48000',
        // Without it the Ogg muxer draws a random stream serial (and stamps
        // the encoder version), so two encodes of one track differ byte for
        // byte — and a client that started on a live encode and reconnects
        // with a Range would be handed pages from a different stream.
        '-fflags',
        '+bitexact',
        '-f',
        'ogg',
        'pipe:1',
    ];
}

export function buildAacEncodeArgs(input: EncodeArgsInput, extras: AacExtraOptions): string[] {
    validateEncodeInput(input);
    const codec = extras.hasFdkAac ? 'libfdk_aac' : 'aac';
    const profileFlag = extras.hasFdkAac ? ['-profile:a', 'aac_low'] : [];
    return [
        ...seekPrefix(input.timeOffset),
        ...inputArgs(input.srcPath),
        '-vn',
        '-map',
        '0:a:0',
        '-c:a',
        codec,
        ...profileFlag,
        '-b:a',
        `${input.bitrateKbps}k`,
        '-ac',
        '2',
        '-ar',
        '44100',
        '-f',
        'adts',
        'pipe:1',
    ];
}

/**
 * AAC inside a plain, faststart MP4 — written to a FILE, never a pipe.
 *
 * This is the one target that cannot be muxed onto stdout. A non-fragmented
 * MP4 writes `moov` only once every sample size is known and seeks back to
 * patch it; `+faststart` then rewrites the file a second time to hoist `moov`
 * ahead of `mdat`. Both steps need a seekable output.
 *
 * The obvious way around that is a fragmented MP4
 * (`+frag_keyframe+empty_moov+default_base_moof`), and this function used to
 * emit exactly that. It is silently broken for audio: with no video keyframes
 * to fragment on, ffmpeg buffers the whole track into ONE fragment and emits
 * it at EOF via a path that seeks back to fill in the `moof`/`traf` box sizes.
 * On a pipe that seek is a no-op, the sizes stay `0x00000000`, and a reader
 * walking the box tree never reaches `mdat`. ffprobe resyncs past the damage
 * and reports a healthy 221s AAC stream, which is why this passed every check
 * we had. AVFoundation does not reject the file either — it opens it, finds
 * one audio track, answers `isPlayable == true`, and reports a duration of
 * ZERO. That empty asset is what the client sees fail: nothing to export,
 * nothing to seek, "The operation could not be completed".
 *
 * `buildAacEncodeArgs` is the streamable sibling: raw ADTS pipes fine but
 * cannot be opened from disk by AVURLAsset. Same encoder, different wrapper —
 * m4a is the one to pick when the bytes have to land in a file.
 */
export function buildM4aEncodeArgs(
    input: EncodeArgsInput,
    extras: AacExtraOptions,
    outPath: string,
): string[] {
    validateEncodeInput(input);
    validateSeekableOutput(outPath, 'buildM4aEncodeArgs');
    const codec = extras.hasFdkAac ? 'libfdk_aac' : 'aac';
    const profileFlag = extras.hasFdkAac ? ['-profile:a', 'aac_low'] : [];
    return [
        ...seekPrefix(input.timeOffset),
        ...inputArgs(input.srcPath),
        '-vn',
        '-map',
        '0:a:0',
        '-c:a',
        codec,
        ...profileFlag,
        '-b:a',
        `${input.bitrateKbps}k`,
        '-ac',
        '2',
        '-ar',
        '44100',
        '-f',
        'mp4',
        '-movflags',
        '+faststart',
        '-y',
        outPath,
    ];
}

/**
 * Reject a pipe (or an empty path) for the mp4 targets. ffmpeg does NOT fail
 * on `-f mp4 … pipe:1` — it writes structurally invalid bytes and exits 0 —
 * so nothing downstream would catch the mistake. Throwing here does.
 */
function validateSeekableOutput(outPath: string, caller: string): void {
    if (!outPath || outPath.startsWith('pipe:') || outPath === '-') {
        throw new Error(
            `${caller} requires a seekable output path, got ${JSON.stringify(outPath)}`,
        );
    }
}

export function buildStreamCopySeekArgs(input: StreamCopySeekArgsInput): string[] {
    validateSeekInput(input);
    // The mp4 muxer needs to seek back over its own output, so an m4a
    // stream-copy has to be handed a file exactly like a fresh m4a encode
    // does. Every other container muxes onto stdout without seeking.
    const outPath = input.outPath ?? '';
    const toFile = containerFor(input.codec) === 'mp4';
    if (toFile) validateSeekableOutput(outPath, 'buildStreamCopySeekArgs');
    return [
        ...seekPrefix(input.timeOffset),
        ...inputArgs(input.cachedPath),
        '-vn',
        '-map',
        '0:a:0',
        '-c:a',
        'copy',
        '-f',
        containerFor(input.codec),
        ...(toFile ? ['-movflags', '+faststart'] : []),
        ...(toFile ? ['-y', outPath] : ['pipe:1']),
    ];
}

export function containerFor(codec: MusicCodec): string {
    switch (codec) {
        case 'mp3':
            return 'mp3';
        case 'opus':
            return 'ogg';
        case 'aac':
            return 'adts';
        case 'm4a':
            return 'mp4';
    }
}

export function mimeFor(codec: MusicCodec): string {
    switch (codec) {
        case 'mp3':
            return 'audio/mpeg';
        case 'opus':
            return 'audio/ogg; codecs=opus';
        case 'aac':
            return 'audio/aac';
        case 'm4a':
            return 'audio/mp4';
    }
}
