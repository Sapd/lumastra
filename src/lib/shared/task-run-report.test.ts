// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { formatTaskRunReport, type TaskRunReportInput } from './task-run-report.js';

const roots = {
    libraryRoots: ['/data/movies', '/srv/media/music'],
    transcodeRoot: '/tmp/transcode',
};

function base(overrides: Partial<TaskRunReportInput> = {}): TaskRunReportInput {
    return {
        runId: '11111111-2222-3333-4444-555555555555',
        taskId: 'file-library-scan',
        label: 'File Library Scan',
        state: 'failed',
        trigger: 'scheduled',
        startedAt: '2026-08-06T10:00:00.000Z',
        completedAt: '2026-08-06T10:04:00.000Z',
        ownerInstanceId: 'web-1',
        scope: { libraryGroupId: 'lg-7' },
        error: { message: 'boom', kind: 'permanent' },
        input: { libraryPathId: 'lp-1' },
        roots,
        ...overrides,
    };
}

describe('formatTaskRunReport — structural fields', () => {
    it('renders run id, task id, state and trigger', () => {
        const out = formatTaskRunReport(base(), 'github');
        expect(out).toContain('11111111-2222-3333-4444-555555555555');
        expect(out).toContain('file-library-scan');
        expect(out).toContain('failed');
        expect(out).toContain('scheduled');
    });

    it('renders the input JSON verbatim when it holds only structural identifiers', () => {
        const out = formatTaskRunReport(base(), 'github');
        expect(out).toContain('"libraryPathId": "lp-1"');
    });

    it('renders "(no input)" when input is empty', () => {
        const out = formatTaskRunReport(base({ input: undefined }), 'github');
        expect(out).toContain('(no input)');
    });

    it('renders "(no error recorded)" when the run has no error', () => {
        const out = formatTaskRunReport(base({ error: null, state: 'completed' }), 'github');
        expect(out).toContain('(no error recorded)');
    });

    it('renders "(stack not captured)" when the error carries no stack', () => {
        const out = formatTaskRunReport(base(), 'github');
        expect(out).toContain('(stack not captured)');
    });
});

describe('formatTaskRunReport — github mode redaction', () => {
    it('redacts a library-root path embedded in the stack', () => {
        const out = formatTaskRunReport(
            base({
                error: {
                    message: 'ENOENT',
                    kind: 'permanent',
                    stack: [
                        'Error: ENOENT',
                        '    at scan (/data/movies/Denis Private Stash/leak.mkv:1:1)',
                        '    at run (/app/build/server/chunks/runner.js:42:7)',
                    ].join('\n'),
                },
            }),
            'github',
        );
        expect(out).not.toContain('/data/movies/Denis Private Stash');
        expect(out).not.toContain('leak.mkv');
        expect(out).toContain('<media>/<redacted>');
        // App source frames are the point of a stack trace — they must survive.
        expect(out).toContain('/app/build/server/chunks/runner.js');
    });

    it('redacts a library-root path embedded in the error message', () => {
        const out = formatTaskRunReport(
            base({
                error: {
                    message: "failed on /srv/media/music/Guns N' Roses/track.flac",
                    kind: 'permanent',
                },
            }),
            'github',
        );
        expect(out).not.toContain("Guns N' Roses");
        expect(out).not.toContain('track.flac');
    });

    it('redacts a library-root path carried inside the input payload', () => {
        const out = formatTaskRunReport(
            base({ input: { path: '/data/movies/Secret Folder/movie.mkv', force: true } }),
            'github',
        );
        expect(out).not.toContain('Secret Folder');
        expect(out).not.toContain('movie.mkv');
        expect(out).toContain('"force": true');
    });

    it('strips a credential-shaped value from the input payload', () => {
        const out = formatTaskRunReport(
            base({ input: { url: 'https://tmdb.example/api?api_key=sk-supersecret-value' } }),
            'github',
        );
        expect(out).not.toContain('sk-supersecret-value');
        expect(out).toContain('<redacted>');
    });

    // Regression: `stripSecrets` only matches `name=value` (query parameter) and
    // `name: value` (unquoted header). `JSON.stringify` emits `"name": "value"`,
    // which matches NEITHER — the quote before the colon breaks the header shape
    // and the closing quote is excluded from its value class. A plugin task with
    // a `.passthrough()` input schema could therefore ship a live credential
    // into a public GitHub issue. Keys are matched structurally instead.
    it('strips credential-shaped JSON KEYS in the input payload (not just query strings)', () => {
        const input = {
            apiKey: 'sk-PLUGIN-SECRET',
            token: 'tok-abc123',
            password: 'hunter2',
            webhookSecret: 'whsec-XYZ',
            authorization: 'Bearer live-bearer-value',
            nested: { accessToken: 'nested-access-token' },
            list: [{ clientSecret: 'array-client-secret' }],
        };
        for (const mode of ['github', 'raw'] as const) {
            const out = formatTaskRunReport(base({ input }), mode);
            expect(out).not.toContain('sk-PLUGIN-SECRET');
            expect(out).not.toContain('tok-abc123');
            expect(out).not.toContain('hunter2');
            expect(out).not.toContain('whsec-XYZ');
            expect(out).not.toContain('live-bearer-value');
            expect(out).not.toContain('nested-access-token');
            expect(out).not.toContain('array-client-secret');
            // The key names themselves stay — they are diagnostics, not secrets.
            expect(out).toContain('"apiKey": "<redacted>"');
            expect(out).toContain('"accessToken": "<redacted>"');
        }
    });

    it('does not redact innocuous keys that merely share a substring', () => {
        const out = formatTaskRunReport(
            base({ input: { author: 'Denis', authorized: true, batchSize: 50 } }),
            'github',
        );
        expect(out).toContain('"author": "Denis"');
        expect(out).toContain('"authorized": true');
        expect(out).toContain('"batchSize": 50');
    });

    it('strips URL userinfo credentials from the error message', () => {
        const out = formatTaskRunReport(
            base({
                error: {
                    message: 'connect failed http://admin:hunter2@10.0.0.5:8989',
                    kind: 'transient',
                },
            }),
            'github',
        );
        expect(out).not.toContain('hunter2');
    });

    it('strips a JWT-shaped token from the stack', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW5pcyJ9.c2lnbmF0dXJlLXZhbHVl';
        const out = formatTaskRunReport(
            base({ error: { message: 'auth failed', kind: 'transient', stack: `Bearer ${jwt}` } }),
            'github',
        );
        expect(out).not.toContain(jwt);
    });

    it('drops the scope user id in github mode but keeps it in raw mode', () => {
        const withUser = base({ scope: { libraryGroupId: 'lg-7', userId: 'denis-uuid-1234' } });
        expect(formatTaskRunReport(withUser, 'github')).not.toContain('denis-uuid-1234');
        expect(formatTaskRunReport(withUser, 'raw')).toContain('denis-uuid-1234');
    });
});

describe('formatTaskRunReport — raw mode', () => {
    it('keeps library paths for the operator', () => {
        const out = formatTaskRunReport(
            base({ input: { path: '/data/movies/Secret Folder/movie.mkv' } }),
            'raw',
        );
        expect(out).toContain('/data/movies/Secret Folder/movie.mkv');
    });

    it('still strips credentials — they must never reach any output', () => {
        const out = formatTaskRunReport(
            base({ input: { url: 'https://x/y?token=abc123secret' } }),
            'raw',
        );
        expect(out).not.toContain('abc123secret');
    });
});

describe('formatTaskRunReport — non-serializable input', () => {
    it('does not throw on a circular input payload', () => {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        const out = formatTaskRunReport(base({ input: circular }), 'github');
        expect(out).toContain('(input not serializable)');
    });
});
