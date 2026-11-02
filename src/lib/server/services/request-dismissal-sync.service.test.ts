// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for request-dismissal-sync.service.ts — the ONE place that keeps
 * the popup, the durable inbox and the For-You "fulfilled requests" rail
 * agreeing about a dismissal.
 *
 * Both directions are covered, because they fail differently:
 *   - inbox/For-You → flags: does a UUID-keyed dismissal also produce the
 *     external-id composite key the popup's dismissedMap reads?
 *   - popup → inbox: does an external-id-keyed dismissal resolve a UUID and
 *     retire the unread `request.available` row?
 *
 * Every DB touch goes through a mocked query module: this exercises the key
 * MAPPING, which is the part that silently mismatches in production.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const setFlagExecute = vi.fn();
const removeFlag = vi.fn();
const getExternalIdsByMediaId = vi.fn();
const getMediaItemSummaryById = vi.fn();
const resolveExternalIdToUuid = vi.fn();
const markRequestAvailableReadByMediaId = vi.fn();
const cacheDelete = vi.fn();

vi.mock('$lib/server/database/queries/user-media-flags.queries.js', () => ({
    setFlag: { execute: (...args: unknown[]) => setFlagExecute(...args) },
    removeFlag: (...args: unknown[]) => removeFlag(...args),
}));

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getExternalIdsByMediaId: (...args: unknown[]) => getExternalIdsByMediaId(...args),
    getMediaItemSummaryById: (...args: unknown[]) => getMediaItemSummaryById(...args),
    resolveExternalIdToUuid: (...args: unknown[]) => resolveExternalIdToUuid(...args),
    buildExternalIdsObject: (records: Array<{ provider: string; external_id: string }>) =>
        Object.fromEntries(records.map((r) => [r.provider, r.external_id])),
}));

vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    markRequestAvailableReadByMediaId: (...args: unknown[]) =>
        markRequestAvailableReadByMediaId(...args),
}));

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: { for: () => ({ delete: (...args: unknown[]) => cacheDelete(...args) }) },
    CACHE_NAMESPACES: { fulfilledRequests: { name: 'fulfilledRequests' } },
}));

vi.mock('$lib/paraglide/runtime.js', () => ({ locales: ['en', 'de'] }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
    },
}));

const SQL = {} as unknown as postgres.Sql;
const USER = '11111111-2222-3333-4444-555555555555';
const MEDIA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function loadService(): Promise<typeof import('./request-dismissal-sync.service.js')> {
    return import('./request-dismissal-sync.service.js');
}

/**
 * Let every pending microtask/timer settle. Needed before a NEGATIVE assertion
 * about fire-and-forget work: `vi.waitFor(() => expect(x).not.toHaveBeenCalled())`
 * passes on its first tick and would be a false green.
 */
async function flushAsync(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The flag rows setFlag was asked to ensure, as `${targetType}:${targetId}`. */
function writtenFlags(): string[] {
    return setFlagExecute.mock.calls.map((call) => {
        const params = call[1] as { targetId: string; targetType: string };
        return `${params.targetType}:${params.targetId}`;
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    setFlagExecute.mockResolvedValue({ id: 'flag-1' });
    removeFlag.mockResolvedValue(undefined);
    getExternalIdsByMediaId.mockResolvedValue([]);
    getMediaItemSummaryById.mockResolvedValue(null);
    resolveExternalIdToUuid.mockResolvedValue(null);
    markRequestAvailableReadByMediaId.mockResolvedValue([]);
    cacheDelete.mockResolvedValue(undefined);
});

describe('syncRequestDismissal — inbox / For-You (UUID) → the popup key shape', () => {
    it('writes BOTH the K-UUID and the K-EXT flag for a series dismissal', async () => {
        getExternalIdsByMediaId.mockResolvedValue([{ provider: 'tmdb', external_id: '1399' }]);
        const { syncRequestDismissal } = await loadService();

        const result = await syncRequestDismissal(
            SQL,
            USER,
            { mediaId: MEDIA, mediaType: 'tv' },
            'inbox',
        );

        // K-UUID uses the dismissal taxonomy ('series'), which is what the
        // For-You anti-join matches. K-EXT uses target_type 'request' and the
        // STORAGE media-type spelling 'tv' — 'series' there would produce a key
        // that matches no stored popup dismissal.
        expect(writtenFlags()).toEqual([`series:${MEDIA}`, 'request:tmdb:1399:tv']);
        expect(result.unmapped).toBeNull();
        expect(result.extKey).toBe('tmdb:1399:tv');
    });

    it('accepts the public "series" spelling and the For-You taxonomy alike', async () => {
        getExternalIdsByMediaId.mockResolvedValue([{ provider: 'tmdb', external_id: '1399' }]);
        const { syncRequestDismissal } = await loadService();

        const result = await syncRequestDismissal(
            SQL,
            USER,
            { mediaId: MEDIA, mediaType: 'series' },
            'for-you',
        );

        expect(result.extKey).toBe('tmdb:1399:tv');
    });

    it('falls back to the catalog row when the caller did not say what type it is', async () => {
        getMediaItemSummaryById.mockResolvedValue({ media_type: 'movie' });
        getExternalIdsByMediaId.mockResolvedValue([{ provider: 'tmdb', external_id: '550' }]);
        const { syncRequestDismissal } = await loadService();

        const result = await syncRequestDismissal(SQL, USER, { mediaId: MEDIA }, 'inbox');

        expect(result.extKey).toBe('tmdb:550:movie');
        expect(writtenFlags()).toEqual([`movie:${MEDIA}`, 'request:tmdb:550:movie']);
    });

    it('reports no-external-id rather than silently no-op when the item has no provider id', async () => {
        getExternalIdsByMediaId.mockResolvedValue([]);
        const { syncRequestDismissal } = await loadService();

        const result = await syncRequestDismissal(
            SQL,
            USER,
            { mediaId: MEDIA, mediaType: 'movie' },
            'inbox',
        );

        // The inbox row and the For-You rail are still reconciled; only the
        // popup's dismissedMap cannot see this one.
        expect(result.unmapped).toBe('no-external-id');
        expect(result.extKey).toBeNull();
        expect(writtenFlags()).toEqual([`movie:${MEDIA}`]);
        expect(markRequestAvailableReadByMediaId).toHaveBeenCalledWith(SQL, USER, MEDIA);
    });
});

describe('syncRequestDismissal — popup (external id) → the inbox row', () => {
    it('resolves a UUID from the provider id and marks the unread inbox row read', async () => {
        resolveExternalIdToUuid.mockResolvedValue(MEDIA);
        markRequestAvailableReadByMediaId.mockResolvedValue(['row-a', 'row-b']);
        const { syncRequestDismissal } = await loadService();

        const result = await syncRequestDismissal(
            SQL,
            USER,
            { externalIds: { tmdb: '550' }, mediaType: 'movie' },
            'popup',
        );

        expect(resolveExternalIdToUuid).toHaveBeenCalledWith(SQL, '550', 'movie', 'tmdb');
        expect(result.inboxRowsMarkedRead).toBe(2);
        expect(writtenFlags()).toEqual([`movie:${MEDIA}`, 'request:tmdb:550:movie']);
        expect(result.unmapped).toBeNull();
    });

    it('reports no-uuid and touches no inbox row for media that is not in the catalog', async () => {
        resolveExternalIdToUuid.mockResolvedValue(null);
        const { syncRequestDismissal } = await loadService();

        const result = await syncRequestDismissal(
            SQL,
            USER,
            { externalIds: { tmdb: '999' }, mediaType: 'movie' },
            'popup',
        );

        expect(result.unmapped).toBe('no-uuid');
        expect(markRequestAvailableReadByMediaId).not.toHaveBeenCalled();
        expect(writtenFlags()).toEqual(['request:tmdb:999:movie']);
    });

    it('uses externalIds.internal when the popup happens to carry one', async () => {
        const { syncRequestDismissal } = await loadService();

        const result = await syncRequestDismissal(
            SQL,
            USER,
            { externalIds: { internal: MEDIA, tmdb: '550' }, mediaType: 'movie' },
            'popup',
        );

        // No resolution round-trip needed, and the K-EXT key still EXCLUDES the
        // UUID (buildExternalIdKey with includeUuids:false) — the popup's own
        // key builder does the same, so the two must agree.
        expect(resolveExternalIdToUuid).not.toHaveBeenCalled();
        expect(result.uuidKey).toBe(MEDIA);
        expect(result.extKey).toBe('tmdb:550:movie');
    });
});

describe('syncRequestDismissal — best-effort contract', () => {
    it('never throws when a flag write fails', async () => {
        setFlagExecute.mockRejectedValue(new Error('db down'));
        getExternalIdsByMediaId.mockResolvedValue([{ provider: 'tmdb', external_id: '550' }]);
        const { syncRequestDismissal } = await loadService();

        await expect(
            syncRequestDismissal(SQL, USER, { mediaId: MEDIA, mediaType: 'movie' }, 'inbox'),
        ).resolves.toMatchObject({ unmapped: 'nothing' });
    });

    it('does nothing at all when there is neither a uuid nor an external id', async () => {
        const { syncRequestDismissal } = await loadService();

        const result = await syncRequestDismissal(SQL, USER, { mediaType: 'movie' }, 'popup');

        expect(result.unmapped).toBe('nothing');
        expect(setFlagExecute).not.toHaveBeenCalled();
    });

    it('refuses a non-UUID user id rather than writing a flag under a username', async () => {
        const { syncRequestDismissal } = await loadService();

        const result = await syncRequestDismissal(
            SQL,
            'denis',
            { mediaId: MEDIA, mediaType: 'movie' },
            'inbox',
        );

        expect(result.unmapped).toBe('nothing');
        expect(setFlagExecute).not.toHaveBeenCalled();
    });
});

describe('scheduleDismissalSyncForInboxRow — kind gating', () => {
    it('ignores a library.new_episode row (reading it is not a request dismissal)', async () => {
        const { scheduleDismissalSyncForInboxRow } = await loadService();

        scheduleDismissalSyncForInboxRow(SQL, USER, {
            kind: 'library.new_episode',
            payload: { mediaId: MEDIA, seriesId: 'series-uuid' },
        });
        await flushAsync();
        expect(setFlagExecute).not.toHaveBeenCalled();
    });

    it('reconciles a request.available row', async () => {
        getExternalIdsByMediaId.mockResolvedValue([{ provider: 'tmdb', external_id: '550' }]);
        const { scheduleDismissalSyncForInboxRow } = await loadService();

        scheduleDismissalSyncForInboxRow(SQL, USER, {
            kind: 'request.available',
            payload: { mediaId: MEDIA, mediaType: 'movie', title: 'Quiet Orbit' },
        });

        await vi.waitFor(() =>
            expect(writtenFlags()).toEqual([`movie:${MEDIA}`, 'request:tmdb:550:movie']),
        );
    });

    it('ignores a request.available row whose payload lost its mediaId', async () => {
        const { scheduleDismissalSyncForInboxRow } = await loadService();

        scheduleDismissalSyncForInboxRow(SQL, USER, {
            kind: 'request.available',
            payload: { title: 'Quiet Orbit' },
        });
        await flushAsync();
        expect(setFlagExecute).not.toHaveBeenCalled();
    });
});

describe('syncRequestUndismissal — the inverse must clear both shapes too', () => {
    it('removes the K-UUID and K-EXT rows together', async () => {
        getExternalIdsByMediaId.mockResolvedValue([{ provider: 'tmdb', external_id: '550' }]);
        const { syncRequestUndismissal } = await loadService();

        await syncRequestUndismissal(SQL, USER, { mediaId: MEDIA, mediaType: 'movie' }, 'for-you');

        const targets = removeFlag.mock.calls.map(
            (call) => (call[1] as { targetId: string }).targetId,
        );
        expect(targets).toEqual([MEDIA, 'tmdb:550:movie']);
    });

    it('does not resurrect the inbox row', async () => {
        getExternalIdsByMediaId.mockResolvedValue([{ provider: 'tmdb', external_id: '550' }]);
        const { syncRequestUndismissal } = await loadService();

        await syncRequestUndismissal(SQL, USER, { mediaId: MEDIA, mediaType: 'movie' }, 'popup');

        // read_at is monotonic — a re-request earns a NEW row when the media
        // next becomes playable, not the stale "ready" one.
        expect(markRequestAvailableReadByMediaId).not.toHaveBeenCalled();
    });
});

describe('dismiss / un-dismiss ordering — the LAST-REQUESTED intent wins', () => {
    /**
     * Both legs are fire-and-forget, so a dismiss and the un-dismiss a
     * re-request triggers are two racing async chains over the same
     * `(user, media)`. These tests pin the property that matters: the outcome
     * follows REQUEST order, never completion order.
     *
     * The asymmetry is deliberate and is what makes the test fail without the
     * fix — the FIRST-requested leg is given a slow key lookup, so its writes
     * would otherwise land last and win. `Promise.all` evaluates its array
     * left to right and each leg runs synchronously up to its first `await`,
     * so the leg listed first is also the leg that stamps the lower sequence
     * and issues the first `getExternalIdsByMediaId` call.
     */
    function slowFirstLookup(): void {
        let call = 0;
        getExternalIdsByMediaId.mockImplementation(async () => {
            const nth = ++call;
            await new Promise((resolve) => setTimeout(resolve, nth === 1 ? 25 : 0));
            return [{ provider: 'tmdb', external_id: '550' }];
        });
    }

    it('an un-dismiss requested AFTER a slow dismiss still leaves the item visible', async () => {
        slowFirstLookup();
        const { syncRequestDismissal, syncRequestUndismissal } = await loadService();

        const [dismissResult] = await Promise.all([
            syncRequestDismissal(SQL, USER, { mediaId: MEDIA, mediaType: 'movie' }, 'popup'),
            syncRequestUndismissal(SQL, USER, { mediaId: MEDIA, mediaType: 'movie' }, 'popup'),
        ]);

        // The re-request was the user's last word: both flag shapes must end
        // up cleared, and the superseded dismiss must not write them back.
        expect(dismissResult.superseded).toBe(true);
        expect(writtenFlags()).toEqual([]);
        expect(markRequestAvailableReadByMediaId).not.toHaveBeenCalled();
        expect(
            removeFlag.mock.calls.map((call) => (call[1] as { targetId: string }).targetId),
        ).toEqual([MEDIA, 'tmdb:550:movie']);
    });

    it('a dismiss requested AFTER a slow un-dismiss still leaves the item hidden', async () => {
        slowFirstLookup();
        const { syncRequestDismissal, syncRequestUndismissal } = await loadService();

        const [, dismissResult] = await Promise.all([
            syncRequestUndismissal(SQL, USER, { mediaId: MEDIA, mediaType: 'movie' }, 'for-you'),
            syncRequestDismissal(SQL, USER, { mediaId: MEDIA, mediaType: 'movie' }, 'for-you'),
        ]);

        // The dismiss was last, so both shapes must be set and the un-dismiss
        // must not have clawed them back.
        expect(dismissResult.superseded).toBe(false);
        expect(removeFlag).not.toHaveBeenCalled();
        expect(writtenFlags()).toEqual([`movie:${MEDIA}`, 'request:tmdb:550:movie']);
    });

    it('serializes rather than drops when the same intent is requested twice for one item', async () => {
        // Two dismissals in a row is not a conflict — the later one wins and
        // the earlier one is skipped as redundant, but the item still ends up
        // dismissed. (Regression guard against a supersede rule that lets an
        // item fall through unwritten.)
        getExternalIdsByMediaId.mockResolvedValue([{ provider: 'tmdb', external_id: '550' }]);
        const { syncRequestDismissal } = await loadService();

        await Promise.all([
            syncRequestDismissal(SQL, USER, { mediaId: MEDIA, mediaType: 'movie' }, 'inbox'),
            syncRequestDismissal(SQL, USER, { mediaId: MEDIA, mediaType: 'movie' }, 'inbox'),
        ]);

        expect(writtenFlags()).toEqual([`movie:${MEDIA}`, 'request:tmdb:550:movie']);
    });

    it('does not order two DIFFERENT media against each other', async () => {
        const OTHER = 'ffffffff-1111-2222-3333-444444444444';
        getExternalIdsByMediaId.mockImplementation(async (_sql: unknown, mediaId: string) => [
            { provider: 'tmdb', external_id: mediaId === MEDIA ? '550' : '1399' },
        ]);
        const { syncRequestDismissal, syncRequestUndismissal } = await loadService();

        await Promise.all([
            syncRequestDismissal(SQL, USER, { mediaId: MEDIA, mediaType: 'movie' }, 'inbox'),
            syncRequestUndismissal(SQL, USER, { mediaId: OTHER, mediaType: 'movie' }, 'inbox'),
        ]);

        // Unrelated items share a global sequence but not a queue, so neither
        // may suppress the other.
        expect(writtenFlags()).toEqual([`movie:${MEDIA}`, 'request:tmdb:550:movie']);
        expect(
            removeFlag.mock.calls.map((call) => (call[1] as { targetId: string }).targetId),
        ).toEqual([OTHER, 'tmdb:1399:movie']);
    });
});
