// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Legacy Jellyfin item ids from older clients: the resolver maps them through
 * the `external_ids` rows Jellyfin sync keeps (database lookup only). The
 * mapped item must be active, a merged item forwards to its canonical item,
 * and the resolved ids never carry a `jellyfin` key. An unknown UUID is a 404
 * through `withIdResolution`, never a guess.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestMovie } from '../../../../tests/integration/fixtures/index.js';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => getTestDb() }));
vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: () => null,
    subscribeToChannel: vi.fn(async () => undefined),
}));

import { mediaIdResolver } from './media-id-resolver.js';
import { withIdResolution } from '../middleware/id-resolution.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

function hexId(): string {
    return crypto.randomUUID().replace(/-/g, '');
}

describe.skipIf(SKIP_TESTS)('MediaIdResolver legacy Jellyfin ids (Integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['external_ids', 'media_items']);
    });

    it('maps a Jellyfin id of an active item to its internal id without a jellyfin key', async () => {
        const jellyfinId = hexId();
        const { id } = await createAndInsertTestMovie(sql, { jellyfinId });

        const resolved = await mediaIdResolver.resolveAnyMediaId(jellyfinId);

        expect(resolved.internalId).toBe(id);
        expect(resolved.source).toBe('jellyfin');
        expect(resolved.externalIds).not.toHaveProperty('jellyfin');
    });

    it('follows the canonical chain of a merged item', async () => {
        const jellyfinId = hexId();
        const { id: mergedId } = await createAndInsertTestMovie(sql, { jellyfinId });
        const { id: canonicalId } = await createAndInsertTestMovie(sql, {});
        await sql`
            UPDATE media_items SET status = 'merged', canonical_id = ${canonicalId}
            WHERE id = ${mergedId}
        `;

        const resolved = await mediaIdResolver.resolveAnyMediaId(jellyfinId);

        expect(resolved.internalId).toBe(canonicalId);
        expect(resolved.wasCanonicalized).toBe(true);
        expect(resolved.externalIds).not.toHaveProperty('jellyfin');
    });

    it('does not answer a Jellyfin id whose item is deleted', async () => {
        const jellyfinId = hexId();
        const { id } = await createAndInsertTestMovie(sql, { jellyfinId });
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${id}`;

        await expect(mediaIdResolver.resolveAnyMediaId(jellyfinId)).rejects.toThrow(/not found/);
    });

    it('answers an unknown UUID with 404 through withIdResolution', async () => {
        const handler = vi.fn(async () => new Response('ok'));
        const route = withIdResolution(handler);
        const event = {
            params: { id: crypto.randomUUID() },
            url: new URL('http://localhost/api/media/x'),
            route: { id: '/api/media/[id]' },
            request: new Request('http://localhost/api/media/x'),
            locals: {},
        } as unknown as RequestEvent;

        const res = await route(event);

        expect(res.status).toBe(404);
        expect(handler).not.toHaveBeenCalled();
    });
});
