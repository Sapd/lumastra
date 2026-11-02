// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    generateCompleteVodManifest,
    parseFFmpegManifest,
    rewriteMediaPlaylist,
    initSegmentNameForStreamDir,
    generateVodPlaylist,
} from './vod-playlist.js';

describe('HLS VOD playlist helpers', () => {
    it('rewrites init and segment URIs with request parameters', () => {
        const playlist = [
            '#EXTM3U',
            '#EXT-X-MAP:URI="init_0.mp4"',
            '#EXTINF:6.000000,',
            'segment_00000.m4s',
            '#EXT-X-ENDLIST',
        ].join('\n');
        const params = new URLSearchParams({
            PlaySessionId: 'play',
            audioStreamIndex: '2',
        });

        const rewritten = rewriteMediaPlaylist(playlist, params);

        expect(rewritten).toContain(
            '#EXT-X-MAP:URI="init_0.mp4?PlaySessionId=play&audioStreamIndex=2"',
        );
        expect(rewritten).toContain('segment_00000.m4s?PlaySessionId=play&audioStreamIndex=2');
    });

    it('parses FFmpeg target duration, segment durations, and program date time', () => {
        const parsed = parseFFmpegManifest(
            [
                '#EXTM3U',
                '#EXT-X-TARGETDURATION:11',
                '#EXT-X-PROGRAM-DATE-TIME:2026-04-12T00:00:00.000Z',
                '#EXTINF:10.177000,',
                'segment_00000.m4s',
                '#EXTINF:9.843000,',
                'segment_00001.m4s',
            ].join('\n'),
        );

        expect(parsed.targetDuration).toBe(11);
        expect(parsed.segments).toEqual([
            {
                duration: 10.177,
                programDateTime: '2026-04-12T00:00:00.000Z',
            },
            {
                duration: 9.843,
                programDateTime: undefined,
            },
        ]);
    });

    it('falls back to synthetic durations when keyframe durations are empty', () => {
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n',
            {
                totalDurationSeconds: 18,
                segmentDurationSeconds: 6,
                totalSegments: 3,
                isComplete: false,
                keyframeSegmentDurations: [],
            },
            new URLSearchParams(),
        );

        expect(manifest).toContain('#EXT-X-TARGETDURATION:6');
        expect(manifest.match(/#EXTINF/g)).toHaveLength(3);
        expect(manifest).not.toContain('Infinity');
    });

    it('uses keyframeStreamOffset for keyframe playlists in muxed mode', () => {
        // Muxed mode: single playlist uses keyframe-derived durations.
        // (In demux mode, the handler strips keyframeSegmentDurations before
        // calling generateCompleteVodManifest so both playlists use uniform
        // numbering for Safari/AVPlayer segment-number matching.)
        const kfCount = 1123;
        const kfDurations = Array.from({ length: kfCount }, (_, i) =>
            i === kfCount - 1 ? 5.744 : 10.427,
        );

        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n',
            {
                totalDurationSeconds: 11707.744,
                segmentDurationSeconds: 10,
                totalSegments: 1171,
                isComplete: false,
                startTimeSeconds: 10970,
                keyframeSegmentDurations: kfDurations,
                keyframeStreamOffset: 1052,
            },
            new URLSearchParams(),
        );

        // Should have exactly kfCount segments (not 1171 uniform segments)
        const segmentCount = (manifest.match(/#EXTINF/g) || []).length;
        expect(segmentCount).toBe(kfCount);

        // Segment names should cover the full range 0..1122
        expect(manifest).toContain('segment_00000.m4s');
        expect(manifest).toContain('segment_01122.m4s');
        // Should NOT contain segment 1123+ (uniform would generate these)
        expect(manifest).not.toContain('segment_01123.m4s');

        // EXT-X-START is NOT used — playback-manager.ts handles resume via
        // videoElement.currentTime, and EXT-X-START causes long loading pauses
        // in Safari/AVPlayer on large VOD playlists.
        expect(manifest).not.toContain('#EXT-X-START');
    });

    it('includes PROGRAM-DATE-TIME on every segment for AVPlayer demux sync', () => {
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n',
            {
                totalDurationSeconds: 30,
                segmentDurationSeconds: 10,
                totalSegments: 3,
                isComplete: false,
                keyframeSegmentDurations: [10.427, 10.427, 9.146],
            },
            new URLSearchParams(),
        );

        const pdtCount = (manifest.match(/#EXT-X-PROGRAM-DATE-TIME/g) || []).length;
        const segmentCount = (manifest.match(/#EXTINF/g) || []).length;

        // Every segment must have a PDT tag — without it, Safari/AVPlayer
        // falls back to segment-number matching for demux audio/video sync,
        // which breaks when audio (uniform) and video (keyframe) have
        // different segment durations.
        expect(pdtCount).toBe(segmentCount);
        expect(pdtCount).toBe(3);
    });

    it('ignores invalid keyframe duration values for target duration and segment EXTINF', () => {
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n',
            {
                totalDurationSeconds: 18,
                segmentDurationSeconds: 6,
                totalSegments: 3,
                isComplete: false,
                keyframeSegmentDurations: [10.25, NaN, 7.5],
            },
            new URLSearchParams(),
        );

        expect(manifest).toContain('#EXT-X-TARGETDURATION:11');
        expect(manifest).toContain('#EXTINF:10.250000,');
        expect(manifest).toContain('#EXTINF:6.000000,');
        expect(manifest).toContain('#EXTINF:7.500000,');
    });
    it('raises TARGETDURATION to cover a long copy-mode GOP in FFmpeg real durations', () => {
        // Demux video strips keyframe durations but still emits FFmpeg's REAL
        // durations for produced segments. They average ~10 s (so the uniform
        // base wins), yet one long GOP is 22 s. A declared TARGETDURATION of 10
        // makes AVPlayer reject the playlist (CoreMedia -12642).
        const ffmpegManifest = [
            '#EXTM3U',
            '#EXT-X-TARGETDURATION:23',
            '#EXT-X-MAP:URI="init_1.mp4"',
            ...[10.8, 22.04, 0.96, 7.72, 8.48].flatMap((d, i) => [
                `#EXTINF:${d.toFixed(6)},`,
                `segment_${String(i).padStart(5, '0')}.m4s`,
            ]),
        ].join('\n');
        const manifest = generateCompleteVodManifest(
            ffmpegManifest,
            {
                totalDurationSeconds: 50,
                segmentDurationSeconds: 10,
                totalSegments: 5,
                isComplete: true,
            },
            new URLSearchParams(),
        );

        const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(manifest)?.[1]);
        const extinfs = [...manifest.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
        expect(extinfs).toContain(22.04);
        expect(target).toBe(22);
        for (const d of extinfs) expect(Math.round(d)).toBeLessThanOrEqual(target);
    });

    it('declares the planned keyframe maximum before FFmpeg has produced the long GOP', () => {
        // First fetch: no FFmpeg data yet, every entry is the uniform 10 s. The
        // floor keeps TARGETDURATION at its final value so a refetch after the
        // 17.48 s segment is written does not change it.
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_1.mp4"\n',
            {
                totalDurationSeconds: 30,
                segmentDurationSeconds: 10,
                totalSegments: 3,
                isComplete: false,
                minTargetDurationSeconds: 17.48,
            },
            new URLSearchParams(),
        );
        expect(manifest).toContain('#EXT-X-TARGETDURATION:18');
        expect(manifest).toContain('#EXTINF:10.000000,');
    });

    it('keeps the uniform TARGETDURATION when no segment exceeds it', () => {
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n',
            {
                totalDurationSeconds: 30,
                segmentDurationSeconds: 10,
                totalSegments: 3,
                isComplete: false,
            },
            new URLSearchParams(),
        );
        expect(manifest).toContain('#EXT-X-TARGETDURATION:10');
    });
});

describe('initSegmentNameForStreamDir', () => {
    // A burn-in transcode re-encodes video, so its first init segment takes
    // seconds to appear — and the VOD playlist is served the moment the client
    // asks, well before that. The fallback used to guess `init_0.mp4`, which is
    // only ever right for stream_0. On stream_3 the client cached a playlist
    // pointing at a file that never exists and 404'd forever, with no error
    // surfaced: AVPlayer kept fetching media segments but never got a moov, so it
    // never configured a decoder — a permanent spinner.
    it('names the stream its own init segment', () => {
        expect(initSegmentNameForStreamDir('stream_3')).toBe('init_3.mp4');
        expect(initSegmentNameForStreamDir('stream_0')).toBe('init_0.mp4');
    });

    it('works on a full path, not just a bare directory name', () => {
        expect(initSegmentNameForStreamDir('/tmp/lumastra-transcode/ps/gen-0001/stream_3')).toBe(
            'init_3.mp4',
        );
    });

    it('handles double-digit stream indices', () => {
        expect(initSegmentNameForStreamDir('stream_12')).toBe('init_12.mp4');
    });

    it('falls back to init_0.mp4 for a non stream_N directory (muxed root)', () => {
        expect(initSegmentNameForStreamDir('')).toBe('init_0.mp4');
        expect(initSegmentNameForStreamDir('/tmp/ps/gen-0001')).toBe('init_0.mp4');
    });
});

describe('generateCompleteVodManifest — init fallback', () => {
    it('uses the caller fallback when FFmpeg has not written EXT-X-MAP yet', () => {
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n',
            {
                totalSegments: 3,
                segmentDurationSeconds: 6,
                isComplete: true,
                totalDurationSeconds: 18,
            },
            new URLSearchParams(),
            0,
            'init_3.mp4',
        );

        expect(manifest).toContain('init_3.mp4');
        expect(manifest).not.toContain('init_0.mp4');
    });

    it('still prefers the URI FFmpeg actually wrote', () => {
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_3.mp4"\n',
            {
                totalSegments: 3,
                segmentDurationSeconds: 6,
                isComplete: true,
                totalDurationSeconds: 18,
            },
            new URLSearchParams(),
            0,
            'init_9.mp4',
        );

        expect(manifest).toContain('init_3.mp4');
    });
});

// ---------------------------------------------------------------------------
// generateVodPlaylist — security fix C23 (2026-09-16)
// ---------------------------------------------------------------------------
//
// generateVodPlaylist (used by the /j/ master.m3u8 pre-generated-VOD path)
// built its segment lines with manual string concatenation instead of
// HlsPlaylistBuilder.segment() — the same escaped builder
// buildVodManifestContent (this file, above) already uses — so a
// PlaySessionId or api_key carrying a raw CR/LF was reflected verbatim into
// every segment line, letting a client inject arbitrary HLS tags (e.g. a
// forged #EXT-X-ENDLIST) into its own manifest. This is the unfixed sibling
// of 2026-09-13's C28 fix, which added stripCrlf() to HlsPlaylistBuilder but
// never touched this second, hand-rolled playlist builder in the same file.

describe('generateVodPlaylist — CRLF injection via PlaySessionId/api_key (C23)', () => {
    const BASE_OPTIONS = {
        itemId: 'item-1',
        runtimeSeconds: 12,
        segmentDuration: 6,
    };

    it('strips CR/LF from a malicious playSessionId instead of reflecting it verbatim', () => {
        const playlist = generateVodPlaylist({
            ...BASE_OPTIONS,
            playSessionId: 'x\r\n#EXT-X-ENDLIST',
        });

        const lines = playlist.split('\n');
        // The injected tag must never appear as its OWN line — only the
        // single legitimate #EXT-X-ENDLIST the builder appends at the end.
        const endlistLines = lines.filter((l) => l === '#EXT-X-ENDLIST');
        expect(endlistLines).toHaveLength(1);
        expect(lines[lines.length - 2]).toBe('#EXT-X-ENDLIST');
        // No raw CR should survive into the output at all.
        expect(playlist).not.toContain('\r');
    });

    it('strips CR/LF from a malicious apiKey the same way', () => {
        const playlist = generateVodPlaylist({
            ...BASE_OPTIONS,
            playSessionId: 'sess-1',
            apiKey: 'key\r\n#EXT-X-ENDLIST',
        });

        const lines = playlist.split('\n');
        const endlistLines = lines.filter((l) => l === '#EXT-X-ENDLIST');
        expect(endlistLines).toHaveLength(1);
        expect(playlist).not.toContain('\r');
    });

    it('still round-trips a well-formed playSessionId/apiKey into every segment URI', () => {
        const playlist = generateVodPlaylist({
            ...BASE_OPTIONS,
            playSessionId: 'sess-1',
            apiKey: 'key-1',
        });

        const segmentLines = playlist
            .split('\n')
            .filter((l) => l.startsWith('/j/Videos/item-1/hls/'));
        expect(segmentLines.length).toBeGreaterThan(0);
        for (const line of segmentLines) {
            expect(line).toContain('PlaySessionId=sess-1');
            expect(line).toContain('api_key=key-1');
        }
    });
});

describe('VOD playlists — tail sliver folded into the last segment', () => {
    // A 12.021 s container over 12.000 s of video: FFmpeg writes two video
    // segments, so the playlist must not list a third 0.021 s one.
    const extinfs = (playlist: string): number[] =>
        [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));

    it('generateVodPlaylist (/j) lists 6 + 6.021, not 6 + 6 + 0.021', () => {
        const playlist = generateVodPlaylist({
            itemId: 'item',
            runtimeSeconds: 12.021,
            segmentDuration: 6,
            playSessionId: 'ps',
        });
        expect(extinfs(playlist)).toEqual([6, 6.021]);
        expect(playlist).not.toContain('segment_00002');
    });

    it('the synthetic part of a transcode VOD manifest ends on the folded entry', () => {
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-MAP:URI="init_1.mp4"\n',
            {
                totalDurationSeconds: 12.021,
                segmentDurationSeconds: 6,
                totalSegments: 2,
                isComplete: false,
            },
            new URLSearchParams(),
        );
        expect(extinfs(manifest)).toEqual([6, 6.021]);
        expect(manifest).toContain('#EXT-X-TARGETDURATION:6');
    });

    it('a distinct stream cadence uses the same folded grid', () => {
        // FFmpeg reports a 10 s audio cadence against a 6 s job grid.
        const manifest = generateCompleteVodManifest(
            '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MAP:URI="init_0.mp4"\n' +
                '#EXTINF:10.000000,\nsegment_00000.m4s\n',
            {
                totalDurationSeconds: 20.03,
                segmentDurationSeconds: 6,
                totalSegments: 4,
                isComplete: false,
            },
            new URLSearchParams(),
        );
        expect(extinfs(manifest)).toEqual([10, 10.03]);
    });
});

describe('buildGopGridManifest', () => {
    it('lists every grid entry with its exact duration, PDT and ENDLIST', async () => {
        const { buildGopGridManifest } = await import('./vod-playlist.js');
        const grid = { durations: [13.25, 14.625, 3.125, 21.02, 6.5], count: 5 };
        const m = buildGopGridManifest(
            grid,
            'init_1.mp4',
            new URLSearchParams({ PlaySessionId: 'p' }),
        );
        const extinf = [...m.matchAll(/#EXTINF:([\d.]+),/g)].map((x) => Number(x[1]));
        expect(extinf).toEqual(grid.durations);
        expect(m).toContain('#EXT-X-TARGETDURATION:21');
        expect(m).toContain('#EXT-X-MAP:URI="init_1.mp4?PlaySessionId=p"');
        expect(m).toContain('segment_00004.m4s?PlaySessionId=p');
        expect(m).toContain('#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:27.875Z');
        expect(m.trim().endsWith('#EXT-X-ENDLIST')).toBe(true);
        expect(m).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    });
});

it('keeps foreign playlist, init, key and segment URIs untouched', () => {
    const content =
        '#EXTM3U\n#EXT-X-KEY:URI="https://cdn.test/key"\n#EXT-X-MAP:URI="//cdn.test/init.mp4"\nhttps://cdn.test/segment.ts\n';
    expect(
        rewriteMediaPlaylist(
            content,
            new URLSearchParams({ grant: 'secret', PlaySessionId: 'session' }),
            'https://app.test',
        ),
    ).toBe(content);
    const local = rewriteMediaPlaylist(
        'https://app.test/api/v1/playback/id/hls/segment.ts',
        new URLSearchParams({ grant: 'secret' }),
        'https://app.test',
    );
    expect(local).toBe('https://app.test/api/v1/playback/id/hls/segment.ts?grant=secret');
});
