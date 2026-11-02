// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Series ordering routes accept a legacy Jellyfin series id from an older
 * client (bare, or as `jellyfin:<id>:tv`) and map it to the internal id via
 * the rows Jellyfin sync keeps. An unmapped `jellyfin:` key is a 404.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestTvShow } from '../../../../../../../tests/integration/fixtures/index.js';

const getSeriesOrdering = vi.fn(async (_id: unknown) => null);
const checkMediaAccess = vi.fn(async (_sql: unknown, _id: string, _user: unknown) => true);

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => getTestDb() }));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (sql: unknown, id: string, user: unknown) => checkMediaAccess(sql, id, user),
}));
vi.mock('$lib/server/services/episode-ordering.service.js', () => ({
    getEpisodeOrderingService: () => ({
        getSeriesOrdering: (id: unknown) => getSeriesOrdering(id),
        getAvailableOrderings: async () => [],
        hasOrderingsCache: async () => false,
    }),
}));

import { def } from './ordering.js';

function event(id: string): RequestEvent {
    return {
        params: { id },
        url: new URL(`http://localhost/api/series/${id}/ordering`),
        request: new Request(`http://localhost/api/series/${id}/ordering`),
        locals: { user: { username: 'u', ownerIsAdmin: false, isAgeRestricted: false } },
    } as unknown as RequestEvent;
}

const CTX = {} as Parameters<NonNullable<typeof def.handlers.GET>>[1];

describe('series ordering routes — legacy Jellyfin series ids (Integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
        getSeriesOrdering.mockClear();
        checkMediaAccess.mockClear();
    });

    async function seriesWithJellyfinId(): Promise<{ seriesId: string; jellyfinId: string }> {
        const jellyfinId = crypto.randomUUID().replace(/-/g, '');
        const { id: seriesId } = await createAndInsertTestTvShow(sql, { jellyfinId });
        return { seriesId, jellyfinId };
    }

    it('maps jellyfin:<id>:tv to the internal series id', async () => {
        const { seriesId, jellyfinId } = await seriesWithJellyfinId();

        const res = await def.handlers.GET!(event(`jellyfin:${jellyfinId}:tv`), CTX);

        expect(res.status).toBe(200);
        expect(checkMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            seriesId,
            expect.anything(),
        );
        expect(getSeriesOrdering).toHaveBeenCalledWith({ mediaId: seriesId });
    });

    it('maps a bare Jellyfin series id to the internal series id', async () => {
        const { seriesId, jellyfinId } = await seriesWithJellyfinId();

        const res = await def.handlers.GET!(event(jellyfinId), CTX);

        expect(res.status).toBe(200);
        expect(getSeriesOrdering).toHaveBeenCalledWith({ mediaId: seriesId });
    });

    it('keeps an internal series UUID as is', async () => {
        const { seriesId } = await seriesWithJellyfinId();

        const res = await def.handlers.GET!(event(seriesId), CTX);

        expect(res.status).toBe(200);
        expect(getSeriesOrdering).toHaveBeenCalledWith({ mediaId: seriesId });
    });

    it('answers an unmapped jellyfin:<id>:tv with 404', async () => {
        const res = await def.handlers.GET!(
            event(`jellyfin:${crypto.randomUUID().replace(/-/g, '')}:tv`),
            CTX,
        );

        expect(res.status).toBe(404);
        expect(getSeriesOrdering).not.toHaveBeenCalled();
    });
});
