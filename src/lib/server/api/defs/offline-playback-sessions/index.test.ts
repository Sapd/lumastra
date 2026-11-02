// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/offline-playback-sessions/index.ts — batch ingestion for
 * playback that happened while a client was offline.
 *
 * Skew/max-age enforcement happens in the HANDLER, before the service is ever
 * called — an out-of-window record must come back `rejected` per record rather
 * than failing the whole batch (a client flushing a queue needs the valid
 * records to land even when one is stale). These tests lock that partition:
 * the service only ever sees in-window records, and a too-old record next to a
 * valid one in the same request does not affect the valid one.
 *
 * All DB/service I/O mocked — no DB required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import { OFFLINE_MAX_AGE_MS } from '$lib/schemas/offline-playback.js';
import type { OfflineSessionResult } from '$lib/server/services/offline-playback.service.js';
import type { OfflineSessionResultWire } from '$lib/schemas/offline-playback.js';

const mockGetSql = vi.fn();
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

const mockIngestOfflineSessions = vi.fn();
vi.mock('$lib/server/services/offline-playback.service.js', () => ({
    ingestOfflineSessions: (...args: unknown[]) => mockIngestOfflineSessions(...args),
}));

const { def } = await import('./index.js');

const ctx: ApiContext = { surface: 'v1' } as ApiContext;

const USER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const VALID_MEDIA_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const OLD_MEDIA_ID = 'cccccccc-0000-4000-8000-000000000003';
const VALID_EVENT_ID = 'dddddddd-0000-4000-8000-000000000004';
const OLD_EVENT_ID = 'eeeeeeee-0000-4000-8000-000000000005';

function makeRecord(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    return {
        eventId: VALID_EVENT_ID,
        mediaId: VALID_MEDIA_ID,
        startedAt: new Date(now.getTime() - 60_000).toISOString(),
        endedAt: now.toISOString(),
        positionMs: 60_000,
        runtimeMs: 3_600_000,
        sessionElapsedMs: 60_000,
        endReason: 'stopped',
        ...overrides,
    };
}

function makeEvent(body: unknown): RequestEvent {
    return {
        request: new Request('http://localhost/api/v1/offline-playback-sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        url: new URL('http://localhost/api/v1/offline-playback-sessions'),
        params: {},
        locals: {
            user: { userId: USER_ID, username: 'tester' },
        },
    } as unknown as RequestEvent;
}

function makeCtx(body: unknown): ApiContext {
    return {
        ...ctx,
        input: { body, query: undefined, params: undefined },
    } as ApiContext;
}

function callPost(body: unknown): Promise<Response> {
    const handler = def.handlers.POST!;
    return Promise.resolve(handler(makeEvent(body), makeCtx(body)));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSql.mockResolvedValue({});
    mockIngestOfflineSessions.mockResolvedValue([]);
});

describe('defs/offline-playback-sessions/index', () => {
    it('requires the media:write scope', () => {
        expect(def.auth).toEqual({ kind: 'scope', anyOf: ['media:write'] });
    });

    it('documents POST with a body schema and a 200 response schema', () => {
        const postDocs = def.docs?.POST;
        expect(postDocs).toBeDefined();
        expect(postDocs?.body).toBeDefined();
        expect(postDocs?.responses?.[200]).toBeDefined();
        expect((postDocs?.responses?.[200] as { schema?: unknown })?.schema).toBeDefined();
    });

    it('rejects a too-old record per-record without touching the service, while a valid sibling in the same batch is accepted', async () => {
        const tooOldEndedAt = new Date(Date.now() - OFFLINE_MAX_AGE_MS - 60_000).toISOString();
        const validRecord = makeRecord();
        const oldRecord = makeRecord({
            eventId: OLD_EVENT_ID,
            mediaId: OLD_MEDIA_ID,
            startedAt: tooOldEndedAt,
            endedAt: tooOldEndedAt,
        });

        const acceptedResult: OfflineSessionResult = {
            eventId: VALID_EVENT_ID,
            status: 'accepted',
        };
        mockIngestOfflineSessions.mockResolvedValue([acceptedResult]);

        const res = await callPost({ sessions: [validRecord, oldRecord] });
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
            results: OfflineSessionResultWire[];
            summary: { accepted: number; duplicate: number; rejected: number };
        };

        // The service must only ever see the in-window record.
        expect(mockIngestOfflineSessions).toHaveBeenCalledTimes(1);
        const serviceArgs = mockIngestOfflineSessions.mock.calls[0][1] as {
            records: Array<{ eventId: string }>;
        };
        expect(serviceArgs.records.map((r) => r.eventId)).toEqual([VALID_EVENT_ID]);

        expect(json.results).toEqual([
            { eventId: VALID_EVENT_ID, status: 'accepted', retryable: false, applied: false },
            // `too_old` only gets older — resubmitting can never help.
            {
                eventId: OLD_EVENT_ID,
                status: 'rejected',
                reason: 'too_old',
                retryable: false,
                applied: false,
            },
        ]);
        expect(json.summary).toEqual({ accepted: 1, duplicate: 0, rejected: 1 });
    });

    it('passes knownAsOf through to the service — it is the whole basis of the blind-spot guard', async () => {
        const knownAsOf = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
        mockIngestOfflineSessions.mockResolvedValue([
            { eventId: VALID_EVENT_ID, status: 'accepted' } satisfies OfflineSessionResult,
        ]);

        const res = await callPost({ sessions: [makeRecord({ knownAsOf })] });
        expect(res.status).toBe(200);

        const serviceArgs = mockIngestOfflineSessions.mock.calls[0][1] as {
            records: Array<{ knownAsOf?: string | null }>;
        };
        // Dropping it here would be silent: the record still ingests, and the
        // rebuilder would just read the blind spot as unbounded rather than
        // as the real 12h it was.
        expect(serviceArgs.records[0].knownAsOf).toBe(knownAsOf);
    });

    it('accepts a record with no knownAsOf at all — every already-shipped client sends none', async () => {
        mockIngestOfflineSessions.mockResolvedValue([
            { eventId: VALID_EVENT_ID, status: 'accepted' } satisfies OfflineSessionResult,
        ]);

        const res = await callPost({ sessions: [makeRecord()] });
        expect(res.status).toBe(200);

        const serviceArgs = mockIngestOfflineSessions.mock.calls[0][1] as {
            records: Array<{ eventId: string; knownAsOf?: string | null }>;
        };
        expect(serviceArgs.records.map((r) => r.eventId)).toEqual([VALID_EVENT_ID]);
        expect(serviceArgs.records[0].knownAsOf ?? null).toBeNull();
    });

    it('rejects a knownAsOf that postdates endedAt rather than letting it widen the claim', async () => {
        // A knowledge stamp in the future is the one malformation that
        // DISABLES the guard instead of tightening it — it would claim the
        // client had seen writes it cannot have seen. Must be a per-record
        // rejection, not a silent clamp.
        const record = makeRecord({
            knownAsOf: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });

        const res = await callPost({ sessions: [record] });
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
            results: OfflineSessionResultWire[];
        };
        expect(json.results[0]).toMatchObject({
            eventId: VALID_EVENT_ID,
            status: 'rejected',
            reason: 'invalid',
        });
        expect(json.results[0].details?.[0]?.field).toBe('knownAsOf');
        // Structurally bad records never reach the write path.
        expect(mockIngestOfflineSessions).not.toHaveBeenCalled();
    });

    it('rejects a duplicated eventId without masking the first record that claimed it', async () => {
        // Results are keyed by eventId end to end, so two records sharing one
        // collapse into a single verdict — and naively rejecting the
        // duplicate by key makes the FIRST record's genuine result resolve to
        // that rejection too. Both halves are asserted here.
        const first = makeRecord();
        const dup = makeRecord({ mediaId: OLD_MEDIA_ID });

        mockIngestOfflineSessions.mockResolvedValue([
            { eventId: VALID_EVENT_ID, status: 'accepted' } satisfies OfflineSessionResult,
        ]);

        const res = await callPost({ sessions: [first, dup] });
        expect(res.status).toBe(200);
        const json = (await res.json()) as { results: OfflineSessionResultWire[] };

        // Only the first reaches the write path.
        const serviceArgs = mockIngestOfflineSessions.mock.calls[0][1] as {
            records: Array<{ mediaId: string }>;
        };
        expect(serviceArgs.records).toHaveLength(1);
        expect(serviceArgs.records[0].mediaId).toBe(VALID_MEDIA_ID);

        expect(json.results).toHaveLength(2);
        expect(json.results[0]).toMatchObject({ status: 'accepted' });
        expect(json.results[1]).toMatchObject({ status: 'rejected', reason: 'invalid' });
        expect(json.results[1].details?.[0]?.field).toBe('eventId');
    });

    it('rejects one structurally invalid record per-record (200, not a batch-wide failure) while an accompanying valid record still succeeds', async () => {
        const validRecord = makeRecord();
        // endedAt precedes startedAt — fails OfflinePlaybackRecordSchema's superRefine,
        // not the (lenient) envelope schema, so it must reach the handler and
        // be rejected there rather than 422ing the whole request.
        const invalidRecord = makeRecord({
            eventId: OLD_EVENT_ID,
            mediaId: OLD_MEDIA_ID,
            startedAt: new Date().toISOString(),
            endedAt: new Date(Date.now() - 60_000).toISOString(),
        });

        const acceptedResult: OfflineSessionResult = {
            eventId: VALID_EVENT_ID,
            status: 'accepted',
        };
        mockIngestOfflineSessions.mockResolvedValue([acceptedResult]);

        const res = await callPost({ sessions: [validRecord, invalidRecord] });
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
            results: OfflineSessionResultWire[];
            summary: { accepted: number; duplicate: number; rejected: number };
        };

        // The service must never see the malformed record.
        expect(mockIngestOfflineSessions).toHaveBeenCalledTimes(1);
        const serviceArgs = mockIngestOfflineSessions.mock.calls[0][1] as {
            records: Array<{ eventId: string }>;
        };
        expect(serviceArgs.records.map((r) => r.eventId)).toEqual([VALID_EVENT_ID]);

        expect(json.results).toEqual([
            { eventId: VALID_EVENT_ID, status: 'accepted', retryable: false, applied: false },
            {
                eventId: OLD_EVENT_ID,
                status: 'rejected',
                reason: 'invalid',
                retryable: false,
                applied: false,
                details: [
                    { field: 'endedAt', message: 'endedAt must not precede startedAt' },
                    {
                        field: 'sessionElapsedMs',
                        message: 'sessionElapsedMs exceeds the wall-clock window',
                    },
                ],
            },
        ]);
        expect(json.summary).toEqual({ accepted: 1, duplicate: 0, rejected: 1 });
    });

    it('reports the failing field path in `details` for a reason: "invalid" result, without echoing the submitted value', async () => {
        // A hand-written eventId that fails Zod's UUID version/variant nibble
        // check — the real-world case that motivated this: a developer saw
        // only `reason: "invalid"` and had no way to tell it was the
        // eventId, not the timestamps or the enum. `eventId` itself is
        // always echoed back as the correlation key (existing contract,
        // unrelated to this change) — this test targets a DIFFERENT bad
        // field (`mediaId`) to prove ITS submitted value is never echoed.
        const badMediaId = 'zzzzzzzz-not-a-real-uuid-9999-zzzzzzzzzzzz';
        const res = await callPost({
            sessions: [makeRecord({ mediaId: badMediaId })],
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as { results: OfflineSessionResultWire[] };

        expect(json.results).toHaveLength(1);
        const [result] = json.results;
        expect(result.status).toBe('rejected');
        expect(result.reason).toBe('invalid');
        expect(result.details).toEqual([{ field: 'mediaId', message: expect.any(String) }]);

        // Paths only — the submitted (invalid) mediaId value must never be
        // echoed back, since these records carry user playback data and the
        // response may be logged.
        const serialized = JSON.stringify(json.results);
        expect(serialized).not.toContain(badMediaId);
    });

    it('bounds the number of `details` entries for a record failing many checks at once', async () => {
        // Every numeric/date field is wrong at once — should still report at
        // most OFFLINE_INVALID_DETAILS_MAX entries, not one per failing field
        // unbounded.
        const res = await callPost({
            sessions: [
                {
                    eventId: 'also-not-a-uuid',
                    mediaId: 'also-not-a-uuid',
                    startedAt: 'not-a-date',
                    endedAt: 'not-a-date',
                    positionMs: -1,
                    runtimeMs: -1,
                    sessionElapsedMs: -1,
                    endReason: 'bogus',
                },
            ],
        });
        const json = (await res.json()) as { results: OfflineSessionResultWire[] };
        const [result] = json.results;
        expect(result.reason).toBe('invalid');
        expect(result.details).toBeDefined();
        expect(result.details!.length).toBeGreaterThan(0);
        expect(result.details!.length).toBeLessThanOrEqual(10);
    });

    it('marks a clock-skew rejection RETRYABLE — server time catches up, the record does not change', async () => {
        // A device whose clock runs more than 5 minutes fast rejects every
        // record it submits. Nothing is wrong with the records, so a client
        // that treated this as terminal would destroy a whole flight's
        // listening over a clock it will re-sync minutes later.
        const skewed = makeRecord({
            startedAt: new Date(Date.now() + 55 * 60_000).toISOString(),
            endedAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        });

        const res = await callPost({ sessions: [skewed] });
        const json = (await res.json()) as { results: OfflineSessionResultWire[] };

        expect(json.results).toEqual([
            {
                eventId: VALID_EVENT_ID,
                status: 'rejected',
                reason: 'too_far_future',
                retryable: true,
                applied: false,
            },
        ]);
        // Never reached the write path.
        expect(mockIngestOfflineSessions).not.toHaveBeenCalled();
    });

    it('marks a write failure RETRYABLE — the group rolled back, so nothing was written', async () => {
        mockIngestOfflineSessions.mockResolvedValue([
            { eventId: VALID_EVENT_ID, status: 'rejected', reason: 'write_failed' },
        ]);

        const res = await callPost({ sessions: [makeRecord()] });
        const json = (await res.json()) as { results: OfflineSessionResultWire[] };

        expect(json.results).toEqual([
            {
                eventId: VALID_EVENT_ID,
                status: 'rejected',
                reason: 'write_failed',
                retryable: true,
                applied: false,
            },
        ]);
    });

    it('marks a duplicate NOT retryable — it is a terminal success, not a failure', async () => {
        mockIngestOfflineSessions.mockResolvedValue([
            { eventId: VALID_EVENT_ID, status: 'duplicate' },
        ]);

        const res = await callPost({ sessions: [makeRecord()] });
        const json = (await res.json()) as { results: OfflineSessionResultWire[] };

        expect(json.results).toEqual([
            { eventId: VALID_EVENT_ID, status: 'duplicate', retryable: false, applied: false },
        ]);
    });

    it('stamps retryable on every result, whichever stage produced it', async () => {
        // The point of deriving it in one place: no stage can emit a result
        // without a retryability verdict.
        mockIngestOfflineSessions.mockResolvedValue([
            { eventId: VALID_EVENT_ID, status: 'accepted' },
        ]);

        const res = await callPost({
            sessions: [makeRecord(), { eventId: OLD_EVENT_ID, mediaId: 'not-a-uuid' }],
        });
        const json = (await res.json()) as { results: OfflineSessionResultWire[] };

        expect(json.results).toHaveLength(2);
        for (const r of json.results) {
            expect(r).toHaveProperty('retryable');
            expect(typeof r.retryable).toBe('boolean');
        }
    });

    it("passes the service's applied verdict through untouched — accepted does NOT imply applied", async () => {
        // The failure this field exists for: on prod 2026-08-27 two audiobook
        // records came back `accepted` and both watch-state rows still read
        // position 0. The handler must not paper over a false verdict.
        mockIngestOfflineSessions.mockResolvedValue([
            { eventId: VALID_EVENT_ID, status: 'accepted', applied: false },
        ] satisfies OfflineSessionResult[]);

        const res = await callPost({ sessions: [makeRecord()] });
        const json = (await res.json()) as {
            results: OfflineSessionResultWire[];
            summary: { accepted: number; duplicate: number; rejected: number };
        };

        expect(json.results).toEqual([
            { eventId: VALID_EVENT_ID, status: 'accepted', retryable: false, applied: false },
        ]);
        // Losing arbitration is terminal, not a reason to resubmit.
        expect(json.results[0].retryable).toBe(false);
        // ...and it still counts as accepted, because it WAS ingested.
        expect(json.summary.accepted).toBe(1);
    });

    it('reports applied: true when the record won arbitration', async () => {
        mockIngestOfflineSessions.mockResolvedValue([
            { eventId: VALID_EVENT_ID, status: 'accepted', applied: true },
        ] satisfies OfflineSessionResult[]);

        const res = await callPost({ sessions: [makeRecord()] });
        const json = (await res.json()) as { results: OfflineSessionResultWire[] };

        expect(json.results).toEqual([
            { eventId: VALID_EVENT_ID, status: 'accepted', retryable: false, applied: true },
        ]);
    });

    it('stamps applied on every result, including ones that never reached arbitration', async () => {
        // Same contract as `retryable`: absence of the field on the wire means
        // "server too old to answer", so a result must never omit it just
        // because its stage had no verdict to report.
        mockIngestOfflineSessions.mockResolvedValue([
            { eventId: VALID_EVENT_ID, status: 'accepted', applied: true },
        ] satisfies OfflineSessionResult[]);

        const res = await callPost({
            sessions: [makeRecord(), { eventId: OLD_EVENT_ID, mediaId: 'not-a-uuid' }],
        });
        const json = (await res.json()) as { results: OfflineSessionResultWire[] };

        expect(json.results).toHaveLength(2);
        for (const r of json.results) {
            expect(typeof r.applied).toBe('boolean');
        }
        // The rejected record never reached arbitration — false, not absent.
        expect(json.results[1]).toMatchObject({ status: 'rejected', applied: false });
    });

    it('rejects a malformed record with no string eventId in its input position, preserving its valid sibling', async () => {
        const validRecord = makeRecord();
        const uncorrelatable = { mediaId: OLD_MEDIA_ID }; // no eventId at all

        mockIngestOfflineSessions.mockResolvedValue([
            { eventId: VALID_EVENT_ID, status: 'accepted' } satisfies OfflineSessionResult,
        ]);

        const res = await callPost({ sessions: [validRecord, uncorrelatable] });
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
            results: OfflineSessionResultWire[];
            summary: { accepted: number; duplicate: number; rejected: number };
        };

        expect(json.results).toHaveLength(2);
        expect(json.results[0]).toEqual({
            eventId: VALID_EVENT_ID,
            status: 'accepted',
            retryable: false,
            applied: false,
        });
        expect(json.results[1]).toMatchObject({
            eventId: null,
            status: 'rejected',
            reason: 'invalid',
            retryable: false,
            applied: false,
        });
        expect(json.summary).toEqual({ accepted: 1, duplicate: 0, rejected: 1 });
    });
});
