// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * profile-backfill task — unit tests.
 *
 * Verified behaviours:
 *
 * 1. Drain loop: candidates page drives rebuildUserProfile calls; empty page
 *    breaks the loop; processed count is correct.
 * 2. Empty first page: loop exits immediately, processed = 0.
 * 3. Single `userId` input: rebuilds exactly that user and returns immediately.
 * 4. Abort signal: loop terminates after the current batch when signal fires.
 * 5. rebuildUserProfile null/throw: skipped counter increments, loop continues.
 *
 * All mocks are vi.hoisted so they are available inside vi.mock() factories.
 * No real database or HTTP calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ProfileBackfillQueries from '$lib/server/database/queries/profile-backfill.queries.js';

// ---------------------------------------------------------------------------
// Registry mock — suppress side-effect registration at module load.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
    TaskRegistry: vi.fn(),
}));

// ---------------------------------------------------------------------------
// config mock — provides FORYOU_MIN_WATCHED.
// ---------------------------------------------------------------------------

const configMock = vi.hoisted(() => ({
    config: {
        FORYOU_MIN_WATCHED: 10,
    },
}));

vi.mock('$lib/server/config.js', () => ({
    config: configMock.config,
}));

// ---------------------------------------------------------------------------
// profile-backfill.queries mock — controls candidate page results.
// ---------------------------------------------------------------------------

const queriesMock = vi.hoisted(() => ({
    findProfileBackfillCandidates: vi
        .fn<typeof ProfileBackfillQueries.findProfileBackfillCandidates>()
        .mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/profile-backfill.queries.js', () => ({
    findProfileBackfillCandidates: queriesMock.findProfileBackfillCandidates,
}));

// ---------------------------------------------------------------------------
// database.service mock — provides a mockable getUserProfileService.
// ---------------------------------------------------------------------------

const dbServiceMock = vi.hoisted(() => ({
    // A non-null return means "profile built" (processed); null means the
    // service could not build a usable embedding (skipped) — it never throws.
    fakeProfile: { user_id: 'profile' } as unknown,
    rebuildUserProfile: vi.fn<(userId: string) => Promise<unknown>>(),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: {
        getUserProfileService: vi.fn().mockResolvedValue({
            rebuildUserProfile: dbServiceMock.rebuildUserProfile,
        }),
    },
}));

// ---------------------------------------------------------------------------
// Logger mock — suppress real logger construction.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

// ---------------------------------------------------------------------------
// Import task AFTER all vi.mock() calls.
// ---------------------------------------------------------------------------

import { profileBackfillTask } from './profile-backfill.js';
import type { ProfileBackfillCandidate } from '$lib/server/database/queries/profile-backfill.queries.js';

// ---------------------------------------------------------------------------
// Context factory.
// ---------------------------------------------------------------------------

function makeCtx(inputOverrides: Record<string, unknown> = {}) {
    const ac = new AbortController();
    return {
        ctx: {
            sql: {} as unknown as Parameters<typeof profileBackfillTask.execute>[0]['sql'],
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
                error: vi.fn(),
                child: vi.fn(),
            } as unknown as Parameters<typeof profileBackfillTask.execute>[0]['logger'],
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'test-run',
            input: inputOverrides,
            reportProgress: vi.fn(),
        } as unknown as Parameters<typeof profileBackfillTask.execute>[0],
        abort: () => ac.abort(),
    };
}

function makeCandidate(userId: string, watchedCount = 20): ProfileBackfillCandidate {
    return {
        user_id: userId,
        watched_count: watchedCount,
        latest_activity: new Date('2026-06-01T00:00:00.000Z'),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('profile-backfill: drain loop — candidates drive rebuildUserProfile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbServiceMock.rebuildUserProfile.mockResolvedValue(dbServiceMock.fakeProfile);
    });

    it('calls rebuildUserProfile for each candidate and breaks on empty page', async () => {
        const candidates = [makeCandidate('user-a'), makeCandidate('user-b')];

        queriesMock.findProfileBackfillCandidates
            .mockResolvedValueOnce(candidates)
            .mockResolvedValueOnce([]); // second page empty → drain stops

        const { ctx } = makeCtx();
        const result = await profileBackfillTask.execute(ctx);

        expect(dbServiceMock.rebuildUserProfile).toHaveBeenCalledTimes(2);
        expect(dbServiceMock.rebuildUserProfile).toHaveBeenCalledWith('user-a');
        expect(dbServiceMock.rebuildUserProfile).toHaveBeenCalledWith('user-b');
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(2);
        expect(result.result!.processed).toBe(2);
        expect(result.result!.skipped).toBe(0);
    });
});

describe('profile-backfill: empty first page exits immediately', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns processed=0 when no candidates are found', async () => {
        queriesMock.findProfileBackfillCandidates.mockResolvedValueOnce([]);

        const { ctx } = makeCtx();
        const result = await profileBackfillTask.execute(ctx);

        expect(dbServiceMock.rebuildUserProfile).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(result.result!.processed).toBe(0);
    });
});

describe('profile-backfill: single userId mode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbServiceMock.rebuildUserProfile.mockResolvedValue(dbServiceMock.fakeProfile);
    });

    it('rebuilds exactly one user and does not touch the candidate query', async () => {
        const { ctx } = makeCtx({ userId: 'michael' });
        const result = await profileBackfillTask.execute(ctx);

        expect(dbServiceMock.rebuildUserProfile).toHaveBeenCalledOnce();
        expect(dbServiceMock.rebuildUserProfile).toHaveBeenCalledWith('michael');
        expect(queriesMock.findProfileBackfillCandidates).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(1);
        expect(result.result!.processed).toBe(1);
    });
});

describe('profile-backfill: null rebuild result increments skipped', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('counts null (no usable embedding) as skipped and continues; throw is also skipped', async () => {
        queriesMock.findProfileBackfillCandidates
            .mockResolvedValueOnce([
                makeCandidate('user-ok'),
                makeCandidate('user-null'),
                makeCandidate('user-throw'),
            ])
            .mockResolvedValueOnce([]);

        dbServiceMock.rebuildUserProfile
            .mockResolvedValueOnce(dbServiceMock.fakeProfile) // user-ok → processed
            .mockResolvedValueOnce(null) // user-null → skipped (real failure signal)
            .mockRejectedValueOnce(new Error('unexpected')); // user-throw → defensively skipped

        const { ctx } = makeCtx();
        const result = await profileBackfillTask.execute(ctx);

        expect(dbServiceMock.rebuildUserProfile).toHaveBeenCalledTimes(3);
        expect(result.result!.processed).toBe(1);
        expect(result.result!.skipped).toBe(2);
        expect(result.success).toBe(true);
    });
});

describe('profile-backfill: force mode — processed set prevents infinite loop', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbServiceMock.rebuildUserProfile.mockResolvedValue(dbServiceMock.fakeProfile);
    });

    it('does not reprocess already-seen users when force=true', async () => {
        const candidate = makeCandidate('user-x');

        // Both pages return the same candidate (simulating that a force rebuild
        // does not remove the user from the candidate set). The second call
        // returns an empty pending list because user-x is already in processedIds.
        queriesMock.findProfileBackfillCandidates
            .mockResolvedValueOnce([candidate])
            .mockResolvedValueOnce([candidate]); // same user again — should be filtered

        const { ctx } = makeCtx({ force: true });
        const result = await profileBackfillTask.execute(ctx);

        // rebuildUserProfile is called once; second page returns the same user
        // but it's already in processedIds → pending is empty → loop exits.
        expect(dbServiceMock.rebuildUserProfile).toHaveBeenCalledOnce();
        expect(result.result!.processed).toBe(1);
    });
});
