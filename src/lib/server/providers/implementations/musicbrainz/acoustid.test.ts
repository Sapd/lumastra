// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gunzipSync } from 'node:zlib';

const h = vi.hoisted(() => ({
    exists: new Set<string>(),
    audioFiles: new Set<string>(['/m/a.flac']),
    execResult: { stdout: '', error: null as Error | null },
    execCalls: [] as Array<{ file: string; args: string[] }>,
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, existsSync: (p: string) => h.exists.has(String(p)) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        access: async (p: string) => {
            if (!h.audioFiles.has(String(p))) throw new Error('ENOENT');
        },
    };
});

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        execFile: (
            file: string,
            args: string[],
            _opts: unknown,
            cb: (err: Error | null, stdout: string) => void,
        ) => {
            h.execCalls.push({ file, args });
            queueMicrotask(() => cb(h.execResult.error, h.execResult.stdout));
            return { pid: undefined };
        },
    };
});

vi.mock('$lib/server/utils/fetch-utils.js', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('$lib/server/tasks/http-rate-limit.js', () => ({ acquireHttpToken: vi.fn() }));
vi.mock('$lib/server/tasks/secrets.js', () => ({
    PluginSecrets: vi
        .fn()
        .mockImplementation(() => ({ getOptional: vi.fn().mockResolvedValue(null) })),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { acquireHttpToken } from '$lib/server/tasks/http-rate-limit.js';
import {
    ACOUSTID_BATCH_SIZE,
    ACOUSTID_RPS,
    AcoustIdKeyRejectedError,
    AcoustIdRequestRejectedError,
    AcoustIdTransientError,
    MATCH_SCORE_THRESHOLD,
    __resetFpcalcForTests,
    generateFingerprint,
    isFpcalcAvailable,
    isPerItemRejection,
    lookupAcoustIdBatch,
    normalizeTitle,
    resolveAcoustIdApiKey,
    selectConfidentMatch,
    type AcoustIdResult,
} from './acoustid.js';

const mockFetch = vi.mocked(fetchWithTimeout);

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

const REC1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const REC2 = 'aaaaaaaa-0000-4000-8000-000000000002';

describe('acoustid', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.exists.clear();
        h.execCalls.length = 0;
        h.execResult = { stdout: '', error: null };
        __resetFpcalcForTests();
        delete process.env.ACOUSTID_API_KEY;
    });

    // ── fpcalc ───────────────────────────────────────────────────────────────

    describe('generateFingerprint', () => {
        it('reports unavailable when no fpcalc binary exists', async () => {
            expect(isFpcalcAvailable()).toBe(false);
            expect(await generateFingerprint('/m/a.flac')).toEqual({
                ok: false,
                reason: 'fpcalc-unavailable',
            });
            expect(h.execCalls).toHaveLength(0);
        });

        it('runs fpcalc -json and rounds the duration', async () => {
            h.exists.add('/usr/bin/fpcalc');
            h.execResult.stdout = JSON.stringify({ fingerprint: 'AQAD', duration: 199.65 });
            const r = await generateFingerprint('/m/a.flac');
            expect(r).toEqual({ ok: true, fingerprint: 'AQAD', duration: 200 });
            expect(h.execCalls[0]).toEqual({
                file: '/usr/bin/fpcalc',
                args: ['-json', '/m/a.flac'],
            });
        });

        it('returns fpcalc-failed for a decode error or bad output', async () => {
            h.exists.add('/usr/bin/fpcalc');
            h.execResult.error = new Error('ERROR: Could not decode audio');
            expect(await generateFingerprint('/m/a.flac')).toMatchObject({
                ok: false,
                reason: 'fpcalc-failed',
            });
            h.execResult = { stdout: '{"duration": 3}', error: null };
            expect(await generateFingerprint('/m/a.flac')).toMatchObject({
                ok: false,
                reason: 'fpcalc-failed',
            });
        });

        it('classifies a timeout and a vanished file as retryable, not as undecodable', async () => {
            h.exists.add('/usr/bin/fpcalc');
            h.execResult.error = Object.assign(new Error('Command failed'), {
                killed: true,
                signal: 'SIGTERM',
            });
            expect(await generateFingerprint('/m/a.flac')).toMatchObject({
                ok: false,
                reason: 'fpcalc-timeout',
            });
            h.execResult.error = new Error(
                'Command failed\nERROR: Could not open the input file (No such file or directory)',
            );
            expect(await generateFingerprint('/m/gone.flac')).toMatchObject({
                ok: false,
                reason: 'file-missing',
            });
        });

        it('does not spawn when already aborted', async () => {
            h.exists.add('/usr/bin/fpcalc');
            const ac = new AbortController();
            ac.abort();
            expect(await generateFingerprint('/m/a.flac', { signal: ac.signal })).toEqual({
                ok: false,
                reason: 'aborted',
            });
            expect(h.execCalls).toHaveLength(0);
        });
    });

    // ── key ──────────────────────────────────────────────────────────────────

    describe('resolveAcoustIdApiKey', () => {
        it('is undefined when neither secret nor env is set', async () => {
            expect(await resolveAcoustIdApiKey()).toBeUndefined();
        });
        it('falls back to the env var, trimmed', async () => {
            process.env.ACOUSTID_API_KEY = '  envkey ';
            expect(await resolveAcoustIdApiKey()).toBe('envkey');
        });
    });

    // ── lookup ───────────────────────────────────────────────────────────────

    describe('lookupAcoustIdBatch', () => {
        const q = [
            { fingerprint: 'FP0', duration: 100 },
            { fingerprint: 'FP1', duration: 200 },
        ];

        it('sends one gzipped batch POST and maps replies by index', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({
                    status: 'ok',
                    fingerprints: [
                        { index: 1, results: [{ id: 'x', score: 1, recordings: [{ id: REC1 }] }] },
                        { index: 0, results: [] },
                    ],
                }),
            );
            const out = await lookupAcoustIdBatch(q, 'KEY');
            expect(out).toEqual([[], [{ id: 'x', score: 1, recordings: [{ id: REC1 }] }]]);

            const [url, init] = mockFetch.mock.calls[0];
            expect(url).toBe('https://api.acoustid.org/v2/lookup');
            expect(init!.method).toBe('POST');
            expect((init!.headers as Record<string, string>)['Content-Encoding']).toBe('gzip');
            const params = new URLSearchParams(gunzipSync(init!.body as Buffer).toString());
            expect(params.get('client')).toBe('KEY');
            expect(params.get('batch')).toBe('1');
            // Space-separated: a literal '+' would arrive as %2B and return no recordings.
            expect(params.get('meta')).toBe('recordings releasegroups releases compress');
            expect(params.get('fingerprint.1')).toBe('FP1');
            expect(params.get('duration.0')).toBe('100');
        });

        it('takes a rate-limit token per request at under 3 req/s', async () => {
            expect(ACOUSTID_RPS).toBeLessThan(3);
            expect(ACOUSTID_BATCH_SIZE).toBeGreaterThan(1);
            mockFetch.mockImplementation(async () =>
                jsonResponse({ status: 'ok', fingerprints: [] }),
            );
            await lookupAcoustIdBatch(q, 'KEY');
            await lookupAcoustIdBatch(q, 'KEY');
            expect(acquireHttpToken).toHaveBeenCalledTimes(2);
            expect(acquireHttpToken).toHaveBeenCalledWith(
                'acoustid',
                { rps: ACOUSTID_RPS },
                undefined,
            );
        });

        it('returns null for an index the server left out (undecodable fingerprint)', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ status: 'ok', fingerprints: [{ index: 0, results: [] }] }),
            );
            expect(await lookupAcoustIdBatch(q, 'KEY')).toEqual([[], null]);
        });

        it('throws AcoustIdKeyRejectedError for error code 4', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse(
                    { status: 'error', error: { code: 4, message: 'invalid API key' } },
                    400,
                ),
            );
            await expect(lookupAcoustIdBatch(q, 'BAD')).rejects.toBeInstanceOf(
                AcoustIdKeyRejectedError,
            );
        });

        it('throws AcoustIdTransientError for 5xx, 429, rate-limit code and network errors', async () => {
            mockFetch.mockResolvedValueOnce(new Response('oops', { status: 503 }));
            await expect(lookupAcoustIdBatch(q, 'K')).rejects.toBeInstanceOf(
                AcoustIdTransientError,
            );
            mockFetch.mockResolvedValueOnce(new Response('', { status: 429 }));
            await expect(lookupAcoustIdBatch(q, 'K')).rejects.toBeInstanceOf(
                AcoustIdTransientError,
            );
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ status: 'error', error: { code: 14, message: 'too many' } }, 400),
            );
            await expect(lookupAcoustIdBatch(q, 'K')).rejects.toBeInstanceOf(
                AcoustIdTransientError,
            );
            mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
            await expect(lookupAcoustIdBatch(q, 'K')).rejects.toBeInstanceOf(
                AcoustIdTransientError,
            );
        });

        it('throws a per-item rejection for error code 3', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse(
                    { status: 'error', error: { code: 3, message: 'invalid fingerprint' } },
                    400,
                ),
            );
            const err = await lookupAcoustIdBatch(q, 'K').catch((e) => e);
            expect(err).toBeInstanceOf(AcoustIdRequestRejectedError);
            expect(isPerItemRejection(err)).toBe(true);
            expect(isPerItemRejection(new AcoustIdTransientError('x'))).toBe(false);
        });

        it('sends nothing for an empty batch', async () => {
            expect(await lookupAcoustIdBatch([], 'K')).toEqual([]);
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    // ── match selection ──────────────────────────────────────────────────────

    describe('selectConfidentMatch', () => {
        const rec = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
            id,
            title,
            artists: [{ id: 'AR', name: 'Band' }],
            releasegroups: [{ id: 'RG', title: 'Album', releases: [{ id: 'REL' }] }],
            ...extra,
        });

        it('matches a single recording above the threshold', () => {
            const d = selectConfidentMatch([
                { id: 'a', score: 0.95, recordings: [rec(REC1, 'Song')] },
            ]);
            expect(d.kind).toBe('matched');
            if (d.kind === 'matched') {
                expect(d.match.recordingMbid).toBe(REC1);
                expect(d.match.artistMbids).toEqual(['ar']);
                expect(d.match.releaseGroups).toEqual([
                    { id: 'rg', title: 'Album', releaseIds: ['rel'] },
                ]);
            }
        });

        it('ignores results below the threshold', () => {
            const low = MATCH_SCORE_THRESHOLD - 0.01;
            expect(
                selectConfidentMatch([{ id: 'a', score: low, recordings: [rec(REC1, 'Song')] }])
                    .kind,
            ).toBe('no-match');
        });

        it('no-match for empty results or results without recordings', () => {
            expect(selectConfidentMatch([]).kind).toBe('no-match');
            expect(selectConfidentMatch([{ id: 'a', score: 1 }]).kind).toBe('no-match');
        });

        it('drops a recording whose duration disagrees with the file', () => {
            const r: AcoustIdResult[] = [
                { id: 'a', score: 1, recordings: [rec(REC1, 'Song', { duration: 400 })] },
            ];
            expect(selectConfidentMatch(r, { durationSec: 200 }).kind).toBe('no-match');
            expect(selectConfidentMatch(r, { durationSec: 395 }).kind).toBe('matched');
        });

        it('narrows several recordings by title, then album', () => {
            const r: AcoustIdResult[] = [
                {
                    id: 'a',
                    score: 0.98,
                    recordings: [rec(REC1, 'Song (Remastered 2011)'), rec(REC2, 'Other Song')],
                },
            ];
            const d = selectConfidentMatch(r, { title: 'song' });
            expect(d.kind === 'matched' && d.match.recordingMbid).toBe(REC1);

            const sameTitle: AcoustIdResult[] = [
                {
                    id: 'a',
                    score: 0.98,
                    recordings: [
                        rec(REC1, 'Song', {
                            releasegroups: [{ id: 'RG1', title: 'Greatest Hits' }],
                        }),
                        rec(REC2, 'Song', { releasegroups: [{ id: 'RG2', title: 'Album' }] }),
                    ],
                },
            ];
            const d2 = selectConfidentMatch(sameTitle, { title: 'Song', album: 'Album' });
            expect(d2.kind === 'matched' && d2.match.recordingMbid).toBe(REC2);
        });

        it('is ambiguous rather than guessing between two plausible recordings', () => {
            const r: AcoustIdResult[] = [
                { id: 'a', score: 0.99, recordings: [rec(REC1, 'Song'), rec(REC2, 'Song')] },
            ];
            expect(selectConfidentMatch(r, { title: 'Song', album: 'Nope' })).toEqual({
                kind: 'ambiguous',
                candidates: 2,
            });
        });

        it('collapses the same recording reported under two AcoustID tracks', () => {
            const r: AcoustIdResult[] = [
                { id: 'a', score: 0.9, recordings: [rec(REC1, 'Song')] },
                { id: 'b', score: 0.99, recordings: [rec(REC1, 'Song')] },
            ];
            const d = selectConfidentMatch(r);
            expect(d.kind === 'matched' && d.match.score).toBe(0.99);
        });
    });

    describe('normalizeTitle', () => {
        it('ignores case, accents, punctuation and bracketed qualifiers', () => {
            expect(normalizeTitle('Rückblick (Live) [2011 Remaster]')).toBe('ruckblick');
            expect(normalizeTitle('Rock & Roll!')).toBe('rock and roll');
            expect(normalizeTitle(null)).toBe('');
        });
    });
});
