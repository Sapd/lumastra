// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The "Copy for GitHub" output is the deliverable, so its redaction is what is
 * asserted here: a deliberately-planted subscriber token, provider URL and
 * filesystem path must not survive into text a user pastes into a public issue.
 */
import { describe, test, expect } from 'vitest';
import {
    formatLiveTvFailureReport,
    type LiveTvFailureReportInput,
} from './livetv-failure-report.js';

/** Everything an IPTV failure realistically leaks, in one fixture. */
const DIRTY_STDERR = [
    "[hls @ 0x55] Opening 'http://iptv.provider.example/live/subscriber9912/442.ts?token=SUPERSECRET123' for reading",
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123',
    "[http @ 0x66] Opening 'http://admin:hunter2@10.0.0.5:8989/backup.ts' for reading",
    "[hls @ 0x77] Opening '/tmp/lumastra-live/ch-uuid/segment-4.ts' for writing",
    'Server returned 404 Not Found',
    'Error opening input: Server returned 404 Not Found',
].join('\n');

const INPUT: LiveTvFailureReportInput = {
    channelId: '7f1c2b3a-0000-4444-8888-aaaabbbbcccc',
    channelName: 'Orb Sports HD',
    occurredAt: '2026-08-06T10:00:00.000Z',
    source: 'ingest',
    outcome: 'crashed',
    exitCode: 1,
    signal: null,
    rungId: null,
    stderrTail: DIRTY_STDERR,
    probe: {
        success: false,
        error: 'timeout',
        url: 'http://iptv.provider.example/live/subscriber9912/442.ts?token=SUPERSECRET123',
    },
    decision: { videoAction: 'transcode', videoEncoder: 'h264_qsv', reason: 'interlaced source' },
    roots: { libraryRoots: ['/data/movies'], transcodeRoot: '/tmp/lumastra-live' },
};

describe('formatLiveTvFailureReport — github mode', () => {
    const report = formatLiveTvFailureReport(INPUT, 'github');

    test('no credential survives', () => {
        expect(report).not.toContain('SUPERSECRET123');
        expect(report).not.toContain('hunter2');
        expect(report).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    test('no provider host or subscriber path survives', () => {
        expect(report).not.toContain('iptv.provider.example');
        expect(report).not.toContain('subscriber9912');
        expect(report).not.toContain('10.0.0.5');
    });

    test('the local segment path is redacted', () => {
        expect(report).not.toContain('/tmp/lumastra-live/ch-uuid');
        expect(report).toContain('<outdir>');
    });

    test('the diagnostic content an issue needs still survives', () => {
        expect(report).toContain('Server returned 404 Not Found');
        expect(report).toContain('h264_qsv');
        expect(report).toContain('ingest');
        expect(report).toContain('crashed');
        // Scheme is kept — "it was plain http" is a real clue.
        expect(report).toContain('http://<redacted>');
    });

    test('the channel is identified by name, never by raw id', () => {
        expect(report).toContain('Orb Sports HD');
        expect(report).not.toContain('7f1c2b3a-0000-4444-8888-aaaabbbbcccc');
    });

    test('an unnamed channel does not fall back to leaking its id', () => {
        const anonymous = formatLiveTvFailureReport({ ...INPUT, channelName: null }, 'github');
        expect(anonymous).not.toContain('7f1c2b3a-0000-4444-8888-aaaabbbbcccc');
        expect(anonymous).toContain('(unnamed channel)');
    });

    test('a loopback URL is kept — it is the proxy talking to itself, not the user', () => {
        const egress = formatLiveTvFailureReport(
            {
                ...INPUT,
                source: 'egress',
                rungId: '540p2m',
                stderrTail: "Opening 'http://127.0.0.1:3000/proxy/ch/playlist.m3u8' for reading",
            },
            'github',
        );
        expect(egress).toContain('http://127.0.0.1:3000/proxy/ch/playlist.m3u8');
    });
});

describe('formatLiveTvFailureReport — hosts without a scheme', () => {
    /**
     * The single most common IPTV failure is a DNS miss, and libavformat/tcp.c prints
     * the host BARE — no `scheme://` — so `redactUpstreamUrls` cannot see it. Nothing
     * else in the chain can either: `stripSecrets` is name=value/header/userinfo/JWT
     * only and `redactPaths` is filesystem-root only.
     */
    test('a bare hostname in a resolve failure does not reach the issue', () => {
        const report = formatLiveTvFailureReport(
            {
                ...INPUT,
                stderrTail:
                    '[tcp @ 0x55] Failed to resolve hostname iptv.provider.example: Name or service not known\n' +
                    'Error opening input: Input/output error',
            },
            'github',
        );

        expect(report).not.toContain('iptv.provider.example');
        // The diagnosis — that it was a name-resolution failure — must survive.
        expect(report).toContain('Failed to resolve hostname');
        expect(report).toContain('Name or service not known');
    });

    test('a loopback hostname is kept — the proxy resolving itself is a real clue', () => {
        const report = formatLiveTvFailureReport(
            { ...INPUT, stderrTail: 'Failed to resolve hostname localhost: no address' },
            'github',
        );

        expect(report).toContain('resolve hostname localhost');
    });

    test('raw mode keeps the bare host for the operator', () => {
        const report = formatLiveTvFailureReport(
            { ...INPUT, stderrTail: 'Failed to resolve hostname iptv.provider.example: nope' },
            'raw',
        );

        expect(report).toContain('iptv.provider.example');
    });
});

describe('formatLiveTvFailureReport — channel id inside a segment path', () => {
    /**
     * Segment paths are `<HLS_TEMP_DIR>/<channelId>/…`, and `HLS_TEMP_DIR` is an env
     * var on the PROXY that the app cannot read. A deployment that moved it off the
     * default gets no root match at all — so github mode must strip the internal
     * channel UUID on its own rather than relying on the path rule to hide it.
     */
    test('the channel uuid is gone even when the segment root is unknown', () => {
        const report = formatLiveTvFailureReport(
            {
                ...INPUT,
                stderrTail: `[hls @ 0x77] Opening '/srv/hls-cache/${INPUT.channelId}/segment-4.ts' for writing`,
            },
            'github',
        );

        expect(report).not.toContain(INPUT.channelId);
    });
});

describe('formatLiveTvFailureReport — Xtream path-form credentials', () => {
    /**
     * Xtream Codes puts the subscriber's username and password in the URL PATH
     * (`/live/<user>/<pass>/<streamId>.ts`), and FFmpeg echoes that input URL
     * verbatim. Both report modes — and the stored `stderr_tail`, which goes
     * through the same `stripSecrets` at write time — must be free of it.
     * Security review 2026-09-12, C14.
     */
    const XTREAM_INPUT: LiveTvFailureReportInput = {
        ...INPUT,
        stderrTail:
            "[hls @ 0x55] Opening 'http://iptv.example/live/sub9912/pw4321/442.ts' for reading\n" +
            'Server returned 403 Forbidden',
        probe: { success: false, url: 'http://iptv.example/live/sub9912/pw4321/442.ts' },
    };

    test.each(['github', 'raw'] as const)('%s mode leaks neither half', (mode) => {
        const report = formatLiveTvFailureReport(XTREAM_INPUT, mode);
        expect(report).not.toContain('pw4321');
        expect(report).not.toContain('sub9912');
        expect(report).toContain('Server returned 403 Forbidden');
    });
});

describe('formatLiveTvFailureReport — raw mode', () => {
    const report = formatLiveTvFailureReport(INPUT, 'raw');

    test('keeps paths and the provider host for the operator', () => {
        expect(report).toContain('iptv.provider.example');
        expect(report).toContain('/tmp/lumastra-live/ch-uuid');
        expect(report).toContain('7f1c2b3a-0000-4444-8888-aaaabbbbcccc');
    });

    test('still strips credentials — they must never reach any output', () => {
        expect(report).not.toContain('SUPERSECRET123');
        expect(report).not.toContain('hunter2');
        expect(report).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });
});
