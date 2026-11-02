// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Structural guard for the preview's audio-track wiring.
 *
 * The preview path resolved the viewer's preferred audio track correctly and
 * then failed to carry it to ffmpeg for months, while every preview test stayed
 * green — because none of them looked at what `startJob` was handed. The
 * manifest even reported the intended language while the segments carried the
 * file's first audio stream, so the failure was invisible from the outside
 * unless you compared the audio you heard against a title whose preferred track
 * is not stream 0.
 *
 * Getting it right needs THREE things to agree, and each one is silently
 * useless without the other two:
 *
 *   1. `startJob({ audioTracks })` gets the file's FULL list in stream_index
 *      order. Muxed resolves an ABSOLUTE index to an array POSITION, which is
 *      meaningless against a one-element array (it resolves to position 0 —
 *      the first audio stream — which is the original bug).
 *   2. `startJob({ hlsOutput })` says `hlsAudioMode: 'muxed'`. Without it the
 *      strategy takes the demux branch and maps by array position, so it emits
 *      `-map 0:a:0` no matter what was selected.
 *   3. The preview's own `streamUrl` carries `hlsAudioMode=muxed`.
 *      playback.service computes `isMuxedMode` from the REQUEST, before the job
 *      is resolved — so a muxed job served by a URL that does not say muxed
 *      gets a DEMUX master advertising stream_0/stream_1 renditions that muxed
 *      ffmpeg never writes, and every one of them 404s.
 *
 * This asserts on source text rather than behaviour, following
 * device-surface-parity.test.ts. That is deliberate: driving `createPreview`
 * far enough to observe the ffmpeg args needs a database, a playback plan, a
 * probe and the cache store, and a harness that heavy would be its own source
 * of false confidence. The invariant here is genuinely structural — two call
 * sites and three callers of the shared URL builder that must not disagree.
 * This catches the realistic regression: someone adding a fourth preview URL
 * or a third startJob call without preserving the audio wiring.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVICE = resolve(__dirname, 'preview-session.service.ts');
const rawSrc = readFileSync(SERVICE, 'utf8');

/**
 * Comments stripped before matching. The note in the service explains the old
 * broken shape by quoting it verbatim, so a naive search finds
 * `audioTracks: [resolvedAudioTrack]` in PROSE and reports the bug as still
 * present. Documenting a fix must not trip the guard that proves it.
 */
const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('preview audio wiring — the job side', () => {
    it('hands startJob the full audio list, never a one-element array', () => {
        // The original bug, in one line.
        expect(
            src.includes('audioTracks: [resolvedAudioTrack]'),
            'startJob is being passed a single-element audioTracks array again. Muxed resolves ' +
                'an absolute stream index to an ARRAY POSITION, so a one-element array always ' +
                "resolves to position 0 — the file's first audio stream — regardless of what " +
                'the resolver picked. Pass previewAudioTracks (the full list).',
        ).toBe(false);

        const passes = src.match(/audioTracks: previewAudioTracks,/g) ?? [];
        expect(passes.length, 'expected both startJob call sites to pass the full list').toBe(2);
    });

    it('pairs every audioTracks pass with the muxed hlsOutput', () => {
        // The two are only correct TOGETHER: the full list without muxed mode
        // makes the demux branch encode every audio stream as its own rendition
        // in a hover preview; muxed without the full list cannot resolve the
        // index. Neither is a safe half-migration.
        const paired =
            src.match(/audioTracks: previewAudioTracks,\s*\n\s*hlsOutput: previewHlsOutput,/g) ??
            [];
        expect(
            paired.length,
            'audioTracks and hlsOutput must be passed together at both startJob call sites',
        ).toBe(2);
    });

    it('declares muxed mode, and omits the track index rather than laundering a 0', () => {
        const block = src.slice(
            src.indexOf('const previewHlsOutput'),
            src.indexOf('const previewHlsOutput') + 400,
        );
        expect(block).toContain("hlsAudioMode: 'muxed'");
        // Absolute 0 names the VIDEO stream on essentially every file. When no
        // absolute index resolved, the field must be ABSENT so the strategy
        // falls back to the file's own default track.
        expect(block).toContain('selectedAbsolute !== undefined');
        expect(
            /hlsAudioTrackIndex:\s*(selectedAbsolute\s*\?\?|.*\|\|)\s*0/.test(block),
            'hlsAudioTrackIndex must never be coerced to 0 — that is the video stream',
        ).toBe(false);
    });
});

describe('preview audio wiring — the serving side', () => {
    const builder = src.slice(
        src.indexOf('export async function buildPreviewStreamHref('),
        src.indexOf('export interface CreatePreviewResult'),
    );
    /** Every HLS entry point must stay inside the shared, muxed URL builder. */
    const streamPaths = src.match(/`[^`]*\/hls\/master\.m3u8[^`]*`/g) ?? [];
    const builderPaths = builder.match(/`[^`]*\/hls\/master\.m3u8[^`]*`/g) ?? [];

    it('finds the shared preview URL builder and all three callers', () => {
        // Keep these checks non-vacuous and reject URLs bypassing the builder.
        expect(builderPaths).toHaveLength(1);
        expect(streamPaths).toEqual(builderPaths);
        expect(src.match(/await buildPreviewStreamHref\(/g) ?? []).toHaveLength(3);
    });

    it('pins muxed audio in the query used by both preview URL surfaces', () => {
        expect(builder).toMatch(
            /const query = new URLSearchParams\(\{\s*PlaySessionId: playbackSessionId,\s*fileId,\s*hlsAudioMode: 'muxed',\s*\}\)/,
        );
        expect(builder).toContain('return `${path}?${query}`');
        expect(builder).toContain('return buildGrantedHref(grant, path, query)');
    });
});

describe('preview audio wiring — files with no audio at all', () => {
    /**
     * A silent film is a SUPPORTED input, and most of a public-domain library.
     *
     * The service used to conflate "no audio rows in the database" with "not
     * probed yet" and synthesize a placeholder track for both. For an audio-less
     * file that phantom then defeated the strategy's existence guard — which
     * tests the ARRAY, and the array had an entry — so ffmpeg was told to
     * `-map 0:a:0` on a file whose only stream is video, and exited 234 with
     * "Stream map '' matches no streams" before writing one segment. Every hover
     * preview of every silent film died there.
     *
     * The discriminator is whether ANY `media_streams` row exists for the item:
     * the probe writes a file's streams in one pass, so a video row with no
     * audio row beside it is a positive statement that there is no audio. The
     * synthetic track is then reachable only when nothing has been probed.
     */
    it('gates the synthetic track on "nothing probed", not "no audio rows"', () => {
        expect(
            /if \(availableAudioStreams\.length === 0\) \{/.test(src),
            'The synthetic audio track is gated on an empty audio list again. That gate cannot ' +
                'tell a file that HAS no audio from a file nobody has PROBED, so it invents a ' +
                "phantom track for silent films and ffmpeg dies with \"Stream map '' matches " +
                'no streams". Gate it on whether any media_streams row exists instead.',
        ).toBe(false);

        expect(
            src.includes('if (!audioLayoutKnown) {'),
            'expected the synthetic track to be gated on audioLayoutKnown',
        ).toBe(true);
    });

    it('derives audioLayoutKnown from ALL stream rows, not just the audio ones', () => {
        // getAudioStreamsForMediaItem filters to stream_type='audio' in SQL, so
        // it returns zero rows for a probed-but-silent file AND for an unprobed
        // one. It cannot answer this question; the unfiltered read can.
        expect(
            src.includes('getAudioStreamsForMediaItem'),
            'The audio-only query cannot distinguish "probed, no audio" from "not probed" — ' +
                'both come back empty. Read all stream rows and filter in memory.',
        ).toBe(false);

        const block = src.slice(
            src.indexOf('let audioLayoutKnown'),
            src.indexOf('if (!audioLayoutKnown) {'),
        );
        expect(block).toContain('getStreamsForMediaItem');
        expect(block).toContain('audioLayoutKnown = dbStreamRows.length > 0;');
        expect(block).toMatch(/filter\(\(row\) => row\.stream_type === 'audio'\)/);
    });
});
