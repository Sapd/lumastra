// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for audiobook-progress-push.service.ts.
 *
 * The behaviours locked here are the ones that make this safe to call inline
 * from an offline flush: it pushes the ARBITRATED position (never the raw
 * client one), it never asserts `isFinished`, it honours the same push gate the
 * watch-sync sweep uses, and it cannot throw into its caller.
 *
 * All DB/credential I/O mocked — no DB required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';

const mockGetUserRaw = vi.fn();
vi.mock('../tasks/secrets.js', () => ({
    PluginSecrets: class {
        getUserRaw = (...args: unknown[]) => mockGetUserRaw(...args);
    },
}));

const mockListPreferences = vi.fn();
vi.mock('../database/queries/watch-sync-preferences.queries.js', () => ({
    listPreferences: (...args: unknown[]) => mockListPreferences(...args),
}));

const { pushAudiobookProgressToAbs } = await import('./audiobook-progress-push.service.js');

const USER_ID = 'aaaaaaaa-0000-4000-8000-000000000001' as UserId;
const MEDIA_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

interface PushRow {
    media_id: string;
    resume_position_ms: number;
    abs_item_id: string;
    runtime_seconds?: number | null;
}

/** Minimal `postgres.Sql` stand-in: the tagged template resolves to `rows`. */
function makeSql(rows: PushRow[] | Error): postgres.Sql {
    const sql = ((): Promise<PushRow[]> =>
        rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)) as unknown as {
        array: (v: unknown) => unknown;
    };
    sql.array = (v: unknown) => v;
    return sql as unknown as postgres.Sql;
}

function makeClient(impl?: (...args: unknown[]) => Promise<boolean>) {
    const patchProgressAs = vi.fn(impl ?? (() => Promise.resolve(true)));
    return { client: { patchProgressAs } };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserRaw.mockResolvedValue('abs-key');
    mockListPreferences.mockResolvedValue(new Map());
});

describe('pushAudiobookProgressToAbs', () => {
    it('pushes the arbitrated position in SECONDS and never asserts isFinished', async () => {
        const deps = makeClient();
        // 1_400_000ms is what the rebuild settled on — deliberately not any
        // value the caller passed in, which it never sees.
        const sql = makeSql([
            { media_id: MEDIA_ID, resume_position_ms: 1_400_000, abs_item_id: 'abs-1' },
        ]);

        const result = await pushAudiobookProgressToAbs({
            sql,
            userId: USER_ID,
            mediaIds: [MEDIA_ID],
            deps,
        });

        expect(result).toEqual({ pushed: 1, skipped: 0, failed: 0 });
        expect(deps.client.patchProgressAs).toHaveBeenCalledTimes(1);
        const [key, itemId, body] = deps.client.patchProgressAs.mock.calls[0];
        expect(key).toBe('abs-key');
        expect(itemId).toBe('abs-1');
        expect(body).toEqual({ currentTime: 1400 });
        // The finished flag is AudiobookShelf's to set — asserting it here is
        // what freezes the book's arbitration permanently.
        expect(body).not.toHaveProperty('isFinished');
    });

    /**
     * Finding #24 regression: without a `duration`, a progress row this PATCH
     * CREATES (a book the listener only ever downloaded, never opened in ABS)
     * is born with `duration: 0`, and ABS's own near-end rule then refuses to
     * ever mark it finished -- the offline design's whole premise (ABS's rule
     * finishes the book) silently never fires. `patchProgressAs`'s duration-less
     * body used to make that structurally impossible to fix from this lane.
     */
    it('sends duration in SECONDS alongside currentTime when the local runtime is known', async () => {
        const deps = makeClient();
        const sql = makeSql([
            {
                media_id: MEDIA_ID,
                resume_position_ms: 1_400_000,
                abs_item_id: 'abs-1',
                runtime_seconds: 36_000,
            },
        ]);

        await pushAudiobookProgressToAbs({ sql, userId: USER_ID, mediaIds: [MEDIA_ID], deps });

        const [, , body] = deps.client.patchProgressAs.mock.calls[0];
        expect(body).toEqual({ currentTime: 1400, duration: 36_000 });
    });

    /**
     * Guarded on `> 0`: an unknown local runtime must never overwrite a good
     * upstream duration with zero, which would break the row the same way a
     * missing duration does.
     */
    it('omits duration rather than sending zero when the local runtime is unknown', async () => {
        const deps = makeClient();
        const sql = makeSql([
            {
                media_id: MEDIA_ID,
                resume_position_ms: 1_400_000,
                abs_item_id: 'abs-1',
                runtime_seconds: null,
            },
        ]);

        await pushAudiobookProgressToAbs({ sql, userId: USER_ID, mediaIds: [MEDIA_ID], deps });

        const [, , body] = deps.client.patchProgressAs.mock.calls[0];
        expect(body).toEqual({ currentTime: 1400 });
        expect(body).not.toHaveProperty('duration');
    });

    it('does not push, and does not mint a credential, for a user with no ABS link', async () => {
        mockGetUserRaw.mockResolvedValue(null);
        const deps = makeClient();

        const result = await pushAudiobookProgressToAbs({
            sql: makeSql([]),
            userId: USER_ID,
            mediaIds: [MEDIA_ID],
            deps,
        });

        expect(result).toEqual({ pushed: 0, skipped: 1, failed: 0 });
        expect(deps.client.patchProgressAs).not.toHaveBeenCalled();
    });

    it("pushes for a 'pull'-only user, and never reads sync direction at all", async () => {
        // The invariant this protects: a listener's outcome must not depend on
        // whether their device had a network connection. Live playback already
        // writes this listener's position to ABS via syncSessionAs/closeSessionAs
        // with no direction check, so gating the offline catch-up would mean the
        // same person, same book, same listening, silently loses their resume
        // point only when they happened to be offline.
        mockListPreferences.mockResolvedValue(
            new Map([[USER_ID, { direction: 'pull', pushWatermark: null }]]),
        );
        const deps = makeClient();

        const result = await pushAudiobookProgressToAbs({
            sql: makeSql([
                { media_id: MEDIA_ID, resume_position_ms: 1_400_000, abs_item_id: 'abs-1' },
            ]),
            userId: USER_ID,
            mediaIds: [MEDIA_ID],
            deps,
        });

        expect(result).toEqual({ pushed: 1, skipped: 0, failed: 0 });
        expect(deps.client.patchProgressAs).toHaveBeenCalledTimes(1);
        // Regression guard: re-introducing the sweep's direction gate here is
        // what broke the connectivity invariant in the first place.
        expect(mockListPreferences).not.toHaveBeenCalled();
    });

    it('reports an upstream failure without throwing into the caller', async () => {
        const deps = makeClient(() => Promise.reject(new Error('ABS 500')));

        const result = await pushAudiobookProgressToAbs({
            sql: makeSql([
                { media_id: MEDIA_ID, resume_position_ms: 1_400_000, abs_item_id: 'abs-1' },
            ]),
            userId: USER_ID,
            mediaIds: [MEDIA_ID],
            deps,
        });

        expect(result).toEqual({ pushed: 0, skipped: 0, failed: 1 });
    });

    it('counts an unknown upstream item (404) as skipped, not pushed', async () => {
        const deps = makeClient(() => Promise.resolve(false));

        const result = await pushAudiobookProgressToAbs({
            sql: makeSql([
                { media_id: MEDIA_ID, resume_position_ms: 1_400_000, abs_item_id: 'gone' },
            ]),
            userId: USER_ID,
            mediaIds: [MEDIA_ID],
            deps,
        });

        expect(result).toEqual({ pushed: 0, skipped: 1, failed: 0 });
    });

    it('swallows a failed position read and pushes nothing', async () => {
        const deps = makeClient();

        const result = await pushAudiobookProgressToAbs({
            sql: makeSql(new Error('query failed')),
            userId: USER_ID,
            mediaIds: [MEDIA_ID],
            deps,
        });

        expect(result).toEqual({ pushed: 0, skipped: 1, failed: 0 });
        expect(deps.client.patchProgressAs).not.toHaveBeenCalled();
    });

    it('is a no-op with no media ids, touching neither credentials nor the client', async () => {
        const deps = makeClient();

        const result = await pushAudiobookProgressToAbs({
            sql: makeSql([]),
            userId: USER_ID,
            mediaIds: [],
            deps,
        });

        expect(result).toEqual({ pushed: 0, skipped: 0, failed: 0 });
        expect(mockGetUserRaw).not.toHaveBeenCalled();
        expect(deps.client.patchProgressAs).not.toHaveBeenCalled();
    });

    it('pushes each distinct book once for a batch spanning several books', async () => {
        const second = 'cccccccc-0000-4000-8000-000000000003';
        const deps = makeClient();

        const result = await pushAudiobookProgressToAbs({
            sql: makeSql([
                { media_id: MEDIA_ID, resume_position_ms: 1_000, abs_item_id: 'abs-1' },
                { media_id: second, resume_position_ms: 2_000, abs_item_id: 'abs-2' },
            ]),
            userId: USER_ID,
            // Duplicated on purpose: a flush carries many records per book.
            mediaIds: [MEDIA_ID, second, MEDIA_ID],
            deps,
        });

        expect(result.pushed).toBe(2);
        expect(deps.client.patchProgressAs).toHaveBeenCalledTimes(2);
    });
});
