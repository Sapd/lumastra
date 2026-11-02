// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `probeAudioSource` refuses a playlist/manifest body before ffprobe opens it
 * (ruling T7-music): Subsonic `getTranscodeDecision` returns the probe result
 * to the client, and ffprobe would follow an ffconcat script to a file in
 * another library and report its codec and layout. The source guard also
 * turns a client abort into the slot wait's 503 instead of a logged 500.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probeFormat = vi.fn();
const probeStreams = vi.fn();

vi.mock('$lib/server/utils/ffprobe.js', () => ({
    probeFormat: (...args: unknown[]) => probeFormat(...args),
    probeStreams: (...args: unknown[]) => probeStreams(...args),
    containerFromExtension: (p: string) => (p.endsWith('.flac') ? 'flac' : null),
}));

const { probeAudioSource } = await import('./source-metadata.js');
const { assertTranscodeSourceIsMedia, PlaylistSourceRefusedError } =
    await import('./source-guard.js');

let dir: string;
let playlistBody: string;
let audioLike: string;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'probe-audio-source-'));
    playlistBody = join(dir, '01 track.flac');
    await writeFile(playlistBody, 'ffconcat version 1.0\nfile v.m3u8\n');
    audioLike = join(dir, '02 track.flac');
    // `fLaC` + a metadata block header: a NUL within the first bytes, like
    // every real audio container.
    await writeFile(audioLike, Buffer.from([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
    probeFormat.mockReset().mockResolvedValue({ formatName: 'flac', bitrate: 900_000 });
    probeStreams.mockReset().mockResolvedValue({
        audio: [{ codec: 'flac', bitRate: 900_000, sampleRate: 48000, channels: 2 }],
    });
});

describe('probeAudioSource', () => {
    it('refuses a playlist body without running ffprobe', async () => {
        await expect(probeAudioSource(playlistBody)).rejects.toBeInstanceOf(
            PlaylistSourceRefusedError,
        );
        expect(probeFormat).not.toHaveBeenCalled();
        expect(probeStreams).not.toHaveBeenCalled();
    });

    it('probes a real audio source as before (control)', async () => {
        const meta = await probeAudioSource(audioLike);
        expect(meta.codec).toBe('flac');
        expect(meta.sampleRate).toBe(48000);
        expect(probeFormat).toHaveBeenCalledWith(audioLike);
    });

    it('keeps the fall-back-to-defaults contract for a missing file', async () => {
        probeFormat.mockRejectedValue(new Error('ENOENT'));
        probeStreams.mockRejectedValue(new Error('ENOENT'));
        const meta = await probeAudioSource(join(dir, 'missing.flac'));
        expect(meta.codec).toBe('unknown');
    });
});

describe('assertTranscodeSourceIsMedia', () => {
    it('maps a client abort to 503, like the slot wait', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(assertTranscodeSourceIsMedia(audioLike, ac.signal)).rejects.toMatchObject({
            name: 'AbortError',
            status: 503,
        });
    });

    it('refuses a playlist body with 415 (control)', async () => {
        await expect(assertTranscodeSourceIsMedia(playlistBody)).rejects.toMatchObject({
            status: 415,
        });
    });
});
