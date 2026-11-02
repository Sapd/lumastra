// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    stripSecrets,
    stripSecretsFromArgv,
    redactPaths,
    redactTitleMetadata,
    redactSecretKeys,
    isSecretKey,
    formatFailureReport,
    formatTranscodeIncidentsReport,
} from './transcode-failure-report.js';

const ROOTS = { libraryRoots: ['/data/movies', '/data/series'], transcodeRoot: '/tmp/transcode' };

describe('stripSecrets', () => {
    it('strips credential query params from a URL anywhere in the text', () => {
        const out = stripSecrets(
            "Opening 'http://jf:8096/Items/1/file?api_key=abc123&static=true'",
        );
        expect(out).not.toContain('abc123');
        expect(out).toContain('api_key=<redacted>');
        // Non-credential params must survive — they are diagnostic.
        expect(out).toContain('static=true');
    });

    it.each(['api_key', 'apikey', 'token', 'X-Emby-Token', 'stream_token'])(
        'strips the %s parameter',
        (param) => {
            expect(stripSecrets(`-i http://h/x?${param}=SEKRET`)).not.toContain('SEKRET');
        },
    );

    it('redacts the X-MediaBrowser-Token header and parameter', () => {
        const out = stripSecrets('X-MediaBrowser-Token: abc123');
        expect(out).toContain('<redacted>');
        expect(out).not.toContain('abc123');
        expect(stripSecrets('/x?X-MediaBrowser-Token=abc123')).not.toContain('abc123');
    });

    it('leaves text without credentials byte-identical', () => {
        const clean = '[hevc_qsv] Current pixel format is unsupported';
        expect(stripSecrets(clean)).toBe(clean);
    });

    it.each(['X-Emby-Token: abc123', 'Authorization: Bearer abc123'])(
        'strips a credential in header form ("%s")',
        (header) => {
            const out = stripSecrets(`ffmpeg -headers "${header}\\r\\n" -i http://jf/s`);
            expect(out).not.toContain('abc123');
            expect(out).toContain(': <redacted>');
        },
    );

    it('redacts a JWT-shaped token appearing mid-sentence in stderr', () => {
        const jwt =
            'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
        const out = stripSecrets(`[https] Opening for reading, auth=${jwt} continuing`);
        expect(out).not.toContain(jwt);
        expect(out).toContain('continuing');
    });

    // `http://user:pass@host` is neither a query parameter nor a header, so
    // both existing rules miss it — and ffmpeg echoes the full input URL,
    // userinfo included, straight into its stderr.
    it('strips a credential carried as URL userinfo', () => {
        const out = stripSecrets(
            "Opening 'http://admin:hunter2@10.0.0.5:8989/api/v3/queue' for reading",
        );
        expect(out).not.toContain('hunter2');
        expect(out).not.toContain('admin:');
        expect(out).toContain('<redacted>@');
        // The rest of the URL is diagnostic and must survive.
        expect(out).toContain('/api/v3/queue');
    });

    it('redacts a JWT-shaped token embedded as a URL path segment', () => {
        const jwt =
            'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
        const out = stripSecrets(`Opening 'http://jf:8096/stream/${jwt}/file.m3u8'`);
        expect(out).not.toContain(jwt);
        expect(out).toContain('/stream/');
        expect(out).toContain('/file.m3u8');
    });

    // Xtream Codes carries the subscriber's username AND password as PATH
    // segments (`/live/<user>/<pass>/<streamId>.ts`), not as query parameters —
    // so none of the name=value / header / userinfo / JWT rules can see them.
    // Security review 2026-09-12, C14.
    it('redacts Xtream path-form credentials in a stream URL', () => {
        const out = stripSecrets(
            "[hls @ 0x55] Opening 'http://iptv.example/live/sub9912/pw4321/442.ts' for reading",
        );
        expect(out).not.toContain('pw4321');
        expect(out).not.toContain('sub9912');
        expect(out).toContain('/live/<redacted>/<redacted>/');
        // The stream id and the diagnosis are what the report exists for.
        expect(out).toContain('442.ts');
        expect(out).toContain('for reading');
    });

    it.each(['live', 'movie', 'series', 'timeshift'])('redacts the %s path form too', (kind) => {
        const out = stripSecrets(`-i http://iptv.example/${kind}/sub9912/pw4321/442.ts`);
        expect(out).not.toContain('pw4321');
        expect(out).not.toContain('sub9912');
    });

    it('strips the username parameter, not just the password', () => {
        const out = stripSecrets(
            "Opening 'http://iptv.example/get.php?username=sub9912&password=pw4321&type=m3u_plus'",
        );
        expect(out).not.toContain('sub9912');
        expect(out).not.toContain('pw4321');
        expect(out).toContain('type=m3u_plus');
    });
});

describe('stripSecretsFromArgv', () => {
    it('strips secrets inside argv elements without dropping any element', () => {
        const argv = ['-i', 'http://jf/s?api_key=abc', '-c:v', 'hevc_qsv'];
        const out = stripSecretsFromArgv(argv);
        expect(out).toHaveLength(4);
        expect(out[1]).not.toContain('abc');
        expect(out[3]).toBe('hevc_qsv');
    });
});

describe('redactPaths', () => {
    it('replaces a library path with a placeholder, preserving the extension', () => {
        const out = redactPaths('/data/movies/Some Movie (2024)/Some Movie - Bluray.mkv', ROOTS);
        expect(out).not.toContain('Some Movie');
        expect(out).toContain('.mkv');
    });

    // Split-episode sessions run the concat demuxer, where localFilePath is a LIST
    // file rather than media (ffmpeg-transcode.service.ts:1460). FFmpeg then prints
    // Opening '<real member path>' for every member — paths that are neither the
    // input path nor the output dir, and which would otherwise reach a public issue.
    it('redacts concat member paths that appear only in stderr', () => {
        const stderr =
            "Opening '/data/series/Show/S01E01 - Part 1.mkv' for reading\n" +
            "Opening '/data/series/Show/S01E01 - Part 2.mkv' for reading";
        const out = redactPaths(stderr, ROOTS);
        expect(out).not.toContain('S01E01 - Part 1');
        expect(out).not.toContain('Show');
    });

    it('replaces the transcode output directory', () => {
        const out = redactPaths('/tmp/transcode/abc-123/stream_1/segment_00000.m4s', ROOTS);
        expect(out).not.toContain('abc-123');
    });

    it('leaves diagnostic text untouched', () => {
        const line = '[h264_qsv] Current pixel format is unsupported';
        expect(redactPaths(line, ROOTS)).toBe(line);
    });

    // The match runs to the next quote, so an UNQUOTED path (the common shape
    // in DB-sourced free text, unlike ffmpeg's quoted `Opening '…'`) used to
    // swallow every following line as part of the "path".
    it('stops a path match at the end of its line instead of eating the rest', () => {
        const text =
            '/data/movies/Some Movie (2024)/file.mkv\n[h264_qsv] pixel format unsupported, ffmpeg 7.1';
        const out = redactPaths(text, ROOTS);
        expect(out).not.toContain('Some Movie');
        expect(out).toContain('[h264_qsv] pixel format unsupported, ffmpeg 7.1');
    });

    it('stops a transcode-root match at the end of its line', () => {
        const text = '/tmp/transcode/abc-123/segment_0.m4s\nENOSPC: no space left on device';
        const out = redactPaths(text, ROOTS);
        expect(out).not.toContain('abc-123');
        expect(out).toContain('ENOSPC: no space left on device');
    });
});

describe('formatFailureReport', () => {
    const input = {
        category: 'gpu-init',
        summary: '[vost#0:0/hevc_qsv] Task finished with error code: -22',
        outcome: 'failed' as const,
        exitCode: 218,
        encoder: 'hevc_qsv',
        hwaccel: 'qsv',
        argv: ['-i', '/data/movies/Film/Film.mkv', '-c:v', 'hevc_qsv'],
        stderrTail: "Opening '/data/movies/Film/Film.mkv'\n[hevc_qsv] failed",
        source: {
            codec: 'av1',
            width: 3840,
            height: 1920,
            bitDepth: 10,
            videoRange: 'Dolby Vision',
        },
        decision: { useGpu: true, gpuEncoder: 'hevc_qsv', preserveHdr10: true },
        env: {
            appVersion: '1.2.3',
            ffmpegVersion: '7.1.4-Jellyfin',
            os: 'Linux 6.8.0',
            gpu: 'Intel Arc A380',
        },
        probeDump: "Input #0, matroska,webm, from '/data/movies/Film/Film.mkv':",
        username: 'testlistener',
        ipAddress: '10.0.0.9',
        roots: ROOTS,
    };

    it('github mode redacts paths in argv, stderr AND probe dump, and drops identity', () => {
        const md = formatFailureReport(input, 'github');
        expect(md).not.toContain('/data/movies/Film');
        expect(md).not.toContain('testlistener');
        expect(md).not.toContain('10.0.0.9');
        // Everything diagnostic survives.
        expect(md).toContain('hevc_qsv');
        expect(md).toContain('Dolby Vision');
        expect(md).toContain('7.1.4-Jellyfin');
        expect(md).toContain('Intel Arc A380');
        expect(md).toContain('3840');
    });

    it('raw mode keeps paths but is still secret-free', () => {
        const md = formatFailureReport(
            { ...input, argv: ['-i', 'http://jf/s?api_key=abc'] },
            'raw',
        );
        expect(md).toContain('/data/movies/Film');
        expect(md).not.toContain('abc');
    });

    it('renders an empty argv as unavailable rather than as an empty command', () => {
        const md = formatFailureReport({ ...input, argv: [] }, 'github');
        expect(md).toContain('args unavailable');
    });

    it('strips credentials from stderrTail in BOTH modes (CRITICAL 1)', () => {
        const stderrWithCred =
            "Opening 'http://jf:8096/Items/1/file?api_key=SUPERSECRET&static=true' for reading\n[hevc_qsv] failed";
        const mdGithub = formatFailureReport({ ...input, stderrTail: stderrWithCred }, 'github');
        const mdRaw = formatFailureReport({ ...input, stderrTail: stderrWithCred }, 'raw');
        expect(mdGithub).not.toContain('SUPERSECRET');
        expect(mdRaw).not.toContain('SUPERSECRET');
        // But the URL structure and diagnostic text survive
        expect(mdGithub).toContain('api_key=<redacted>');
        expect(mdRaw).toContain('api_key=<redacted>');
    });

    it('preserves argv flags after path redaction (CRITICAL 2)', () => {
        const argv = ['-i', '/data/movies/Film/Film.mkv', '-c:v', 'hevc_qsv', '-b:v', '5.5M'];
        const md = formatFailureReport({ ...input, argv }, 'github');
        // The path should be redacted
        expect(md).not.toContain('/data/movies/Film');
        // But the codec and bitrate flags should all survive
        expect(md).toContain('hevc_qsv');
        expect(md).toContain('-b:v');
        expect(md).toContain('5.5M');
    });

    // source/decision/env are safe today only by construction — none of the
    // three fields currently carries a path or credential. Nothing enforces
    // that; a future field (e.g. a `sourcePath` on videoInfo) must still be
    // caught here rather than shipping straight into a public GitHub issue.
    it('redacts a path planted inside source/decision/env in github mode', () => {
        const md = formatFailureReport(
            {
                ...input,
                source: { ...input.source, sourcePath: '/data/movies/Film/Film.mkv' },
                decision: { ...input.decision, workDir: '/tmp/transcode/abc-123' },
                env: { ...input.env, configPath: '/data/movies/Film/Film.mkv' },
            },
            'github',
        );
        expect(md).not.toContain('/data/movies/Film');
        expect(md).not.toContain('/tmp/transcode/abc-123');
    });

    it('strips credentials planted inside source/decision/env in BOTH modes', () => {
        const withCred = {
            ...input,
            source: { ...input.source, inputUrl: 'http://jf/s?api_key=PLANTED_SECRET' },
        };
        const mdGithub = formatFailureReport(withCred, 'github');
        const mdRaw = formatFailureReport(withCred, 'raw');
        expect(mdGithub).not.toContain('PLANTED_SECRET');
        expect(mdRaw).not.toContain('PLANTED_SECRET');
    });

    it('redacts multiple -i paths under different library roots', () => {
        const argv = [
            '-i',
            '/data/movies/Film1.mkv',
            '-i',
            '/data/series/Show/E1.mkv',
            '-c:v',
            'hevc_qsv',
        ];
        const md = formatFailureReport({ ...input, argv }, 'github');
        // Both paths should be redacted
        expect(md).not.toContain('Film1');
        expect(md).not.toContain('Show');
        // But both -i flags should survive
        const argBlock = md.split('**FFmpeg command**')[1].split('**')[0];
        const iCount = (argBlock.match(/-i/g) || []).length;
        expect(iCount).toBe(2);
        // And the codec should survive
        expect(md).toContain('hevc_qsv');
    });
});

describe('redactSecretKeys', () => {
    it('replaces credential-named values and leaves everything else intact', () => {
        const out = redactSecretKeys({
            apiKey: 'sk-live',
            batchSize: 50,
            author: 'Testuser',
            nested: { refreshToken: 'rt-live', libraryPathId: 'lp-1' },
        });
        expect(out).toEqual({
            apiKey: '<redacted>',
            batchSize: 50,
            author: 'Testuser',
            nested: { refreshToken: '<redacted>', libraryPathId: 'lp-1' },
        });
    });

    it('does not flatten a non-plain object into {}', () => {
        const date = new Date('2026-08-06T10:00:00.000Z');
        const out = redactSecretKeys({ when: date }) as { when: Date };
        expect(out.when).toBe(date);
        expect(JSON.stringify(out)).toContain('2026-08-06T10:00:00.000Z');
    });

    it('does not recurse forever on a cycle — stringify still rejects it', () => {
        const cyclic: Record<string, unknown> = { apiKey: 'sk-live' };
        cyclic.self = cyclic;
        const out = redactSecretKeys(cyclic);
        expect(() => JSON.stringify(out)).toThrow();
    });

    it('matches key names structurally, not by substring alone', () => {
        expect(isSecretKey('api_key')).toBe(true);
        expect(isSecretKey('X-Emby-Token')).toBe(true);
        expect(isSecretKey('webhookSecret')).toBe(true);
        expect(isSecretKey('author')).toBe(false);
        expect(isSecretKey('authorized')).toBe(false);
    });
});

describe('redactTitleMetadata (github mode)', () => {
    // Real shape from `ffmpeg -i` on the DV-P10/AV1 remux that triggered this work:
    // chapter names are frequently episode/scene descriptive, and the video stream
    // title carried a scene-release tag. Both survived path redaction.
    const probeDump = [
        '  Chapters:',
        '    Chapter #0:0: start 0.000000, end 15.000000',
        '      Metadata:',
        '        title           : Kapitel 01 - The Harbor Keeper Arrives',
        '  Stream #0:0: Video: av1 (Main), yuv420p10le, 3840x1920',
        '      Metadata:',
        '        title           : WOTT',
        '        BPS             : 6326540',
    ].join('\n');

    it('redacts chapter and stream title values', () => {
        const out = redactTitleMetadata(probeDump);

        expect(out).not.toContain('Kapitel 01');
        expect(out).not.toContain('Hedge Knight');
        expect(out).not.toContain('WOTT');
        expect(out).toContain('title           : <redacted>');
    });

    it('leaves structural and technical lines intact', () => {
        const out = redactTitleMetadata(probeDump);

        // Triage needs the stream/chapter layout and codec facts to survive.
        expect(out).toContain('Chapter #0:0: start 0.000000, end 15.000000');
        expect(out).toContain('Video: av1 (Main), yuv420p10le, 3840x1920');
        expect(out).toContain('BPS             : 6326540');
    });

    it('is applied by the github report but not the raw one', () => {
        const base = {
            category: 'gpu-init',
            summary: 'x',
            outcome: 'failed' as const,
            exitCode: 218,
            encoder: 'hevc_qsv',
            hwaccel: null,
            argv: [],
            stderrTail: probeDump,
            source: {},
            decision: {},
            env: {},
            roots: { libraryRoots: ['/data/series'] },
        };

        expect(formatFailureReport(base, 'github')).not.toContain('WOTT');
        // raw is for the operator's own eyes — identity is deliberately preserved.
        expect(formatFailureReport(base, 'raw')).toContain('WOTT');
    });
});

describe('redactTitleMetadata — multi-line values', () => {
    // ffmpeg prints an embedded newline as a KEYLESS continuation line. A
    // key-anchored match alone redacts only the first line and ships the rest
    // verbatim — on exactly the values (plot summaries) long enough to wrap.
    const dump = [
        '      Metadata:',
        '        description     : Ser Duncan the Tall arrives at Ashford Meadow',
        '                        : where he must find two knights to stand with him.',
        '        ENCODER         : Lavc61.19.101',
    ].join('\n');

    it('redacts continuation lines, not just the keyed first line', () => {
        const out = redactTitleMetadata(dump);

        expect(out).not.toContain('Ser Duncan');
        expect(out).not.toContain('Ashford Meadow');
        expect(out).not.toContain('two knights');
        // The following technical line must survive — the match must not run away.
        expect(out).toContain('ENCODER         : Lavc61.19.101');
    });

    it('redacts show / episode_id, which identify the release directly', () => {
        const out = redactTitleMetadata(
            [
                '        show            : A Keeper of the Seven Lanterns',
                '        episode_id      : S01E01',
            ].join('\n'),
        );

        expect(out).not.toContain('Seven Kingdoms');
        expect(out).not.toContain('S01E01');
    });
});

describe('formatTranscodeIncidentsReport (page-level "Copy for GitHub")', () => {
    const incident = {
        category: 'gpu-failure',
        encoder: 'hevc_qsv',
        occurrences: 7,
        distinctFiles: 2,
        distinctSessions: 3,
        firstSeen: '2026-09-01T10:00:00.000Z',
        lastSeen: '2026-09-02T11:00:00.000Z',
    };
    const attempt = {
        category: 'gpu-failure',
        summary: "failed opening /data/movies/Guns N' Roses Live (2019).mkv",
        outcome: 'failed' as const,
        exitCode: 1,
        encoder: 'hevc_qsv',
        hwaccel: 'qsv',
        argv: [
            'ffmpeg',
            '-i',
            '/data/movies/Guns N Roses Live (2019).mkv',
            '/tmp/transcode/out.m3u8',
        ],
        stderrTail:
            "Opening '/data/movies/Guns N Roses Live (2019).mkv' for reading\n[hevc_qsv] boom",
        source: {},
        decision: {},
        env: {},
        probeDump:
            "Input #0, matroska, from '/data/movies/Guns N Roses Live (2019).mkv':\n  Metadata:\n    title           : Secret Release Tag",
    };

    it('renders the visible list as one table when nothing is expanded', () => {
        const out = formatTranscodeIncidentsReport({
            outcome: 'failed',
            incidents: [incident, { ...incident, category: 'decode-error', encoder: null }],
            roots: ROOTS,
        });
        expect(out).toContain('### Transcode failures — failed (2 incidents)');
        expect(out).toContain('| `gpu-failure` | `hevc_qsv` | 7 | 2 | 3 |');
        // A NULL encoder renders under the same label the page shows.
        expect(out).toContain('| `decode-error` | `software` |');
        expect(out).not.toContain('FFmpeg detail');
    });

    it('names the encoder filter in the banner so a filtered copy says it is one', () => {
        const out = formatTranscodeIncidentsReport({
            outcome: 'recovered',
            encoderFilter: 'hevc_qsv',
            incidents: [incident],
            roots: ROOTS,
        });
        expect(out).toContain('recovered tab, encoder `hevc_qsv`');
    });

    it('says so explicitly when the list is empty', () => {
        const out = formatTranscodeIncidentsReport({
            outcome: 'failed',
            incidents: [],
            roots: ROOTS,
        });
        expect(out).toContain('_No incidents recorded._');
    });

    it('focuses on the expanded incident: counts + session breakdown, with no media identity', () => {
        const out = formatTranscodeIncidentsReport({
            outcome: 'failed',
            incidents: [incident],
            selected: {
                incident,
                sessions: [
                    {
                        attemptCount: 3,
                        firstSeen: '2026-09-01T10:00:00.000Z',
                        lastSeen: '2026-09-01T10:05:00.000Z',
                        terminalOutcome: 'failed',
                    },
                    {
                        attemptCount: 1,
                        firstSeen: '2026-09-02T11:00:00.000Z',
                        lastSeen: '2026-09-02T11:00:00.000Z',
                        terminalOutcome: null,
                    },
                ],
                attempts: [],
            },
            roots: ROOTS,
        });
        expect(out).toContain('### Transcode failure — `gpu-failure` on `hevc_qsv` (failed)');
        expect(out).toContain('| Occurrences | 7 |');
        expect(out).toContain('| Distinct files | 2 |');
        expect(out).toContain('| Distinct sessions | 3 |');
        expect(out).toContain('**Sessions (2)**');
        expect(out).toContain('| 1 | 3 | `failed` |');
        expect(out).toContain('| 2 | 1 | _(none — chain ends on a retry)_ |');
        // The session list carries titles/ids on the page — they must never be here.
        expect(out).not.toMatch(/playSessionId|mediaTitle|fileId/);
        // Without an open session drawer the reader is told how to get the detail.
        expect(out).toContain('Open one of the sessions on the page before copying');
    });

    it("appends the open session's FFmpeg detail in github mode — paths, titles and secrets redacted", () => {
        const out = formatTranscodeIncidentsReport({
            outcome: 'failed',
            incidents: [incident],
            selected: { incident, sessions: [], attempts: [attempt] },
            roots: ROOTS,
        });
        expect(out).toContain('**FFmpeg detail** — one session, 1 attempt');
        expect(out).toContain('**FFmpeg command**');
        expect(out).toContain('ffmpeg -i <media>/<redacted>.mkv <outdir>');
        expect(out).toContain('[hevc_qsv] boom');
        expect(out).toContain('**ffmpeg -i (source)**');
        expect(out).toContain('title           : <redacted>');
        expect(out).not.toContain('Guns N');
        expect(out).not.toContain('Secret Release Tag');
        expect(out).not.toContain('/tmp/transcode');
        expect(out).not.toContain('Open one of the sessions on the page');
    });

    it('never emits raw-mode identity even when the drawer had it', () => {
        const out = formatTranscodeIncidentsReport({
            outcome: 'failed',
            incidents: [incident],
            selected: { incident, sessions: [], attempts: [attempt] },
            roots: ROOTS,
        });
        expect(out).not.toContain('_session:');
    });
});
