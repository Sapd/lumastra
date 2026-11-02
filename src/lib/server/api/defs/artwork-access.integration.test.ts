// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { placeInLibraryGroup } from '../../../../../tests/integration/fixtures/library-access.fixtures.js';
import { principalLocals } from '$lib/server/api/principal-locals.test-helpers.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import { resolveMediaIdByProvider } from '$lib/server/database/queries/resolvers/media-id.resolver.js';
import { CatalogService } from '$lib/server/services/catalog.service.js';

vi.mock('$lib/server/database/connection.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/connection.js')>()),
    getDb: () => getTestDb(),
}));
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({
        cachedResolveMediaIdByProvider: (provider: string, id: string, type?: string) =>
            resolveMediaIdByProvider(getTestDb(), provider, id, type),
        getImageByCatalogId: async () => ({ buffer: Buffer.from('art') }),
        getImageByCompositeKey: async () => ({ buffer: Buffer.from('art') }),
        getTmdbImage: async () => ({ buffer: Buffer.from('upstream') }),
    }),
    imageResponse: () => new Response('art', { headers: { 'Content-Type': 'image/jpeg' } }),
}));
vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSet: async () => ({}),
}));

import { def as listing } from './media/[id]/images/index.js';
import { def as bytes } from './media/[id]/images/[role].js';
import { def as indexed } from './media/[id]/images/[role]/[index].js';

const sql = getTestDb();
const group = randomUUID();
const allowed = randomUUID();
const adult = randomUUID();
const hidden = randomUUID();
const fileIds: string[] = [];
const deniedTmdbId = String(80000000 + Math.floor(Math.random() * 10000000));
const providerIds = new Map<string, string>();

function event(id: string, viewer: 'anonymous' | 'adult' | 'kid'): RequestEvent {
    const locals: Partial<RequestEvent['locals']> =
        viewer === 'anonymous' ? {} : principalLocals({ kind: 'session', ownerIsAdmin: false });
    if (viewer === 'kid' && locals.user) {
        locals.user.isAgeRestricted = true;
        locals.user.maxAgeRating = 12;
    }
    const url = new URL(`http://localhost/api/v1/media/${id}/images/poster`);
    return {
        locals,
        params: { id, role: 'poster', index: '0' },
        url,
        request: new Request(url),
    } as unknown as RequestEvent;
}

beforeAll(async () => {
    await sql`INSERT INTO library_groups (id, name) VALUES (${group}, ${'Artwork ' + group})`;
    await sql`INSERT INTO library_group_permissions (library_group_id, allowed_groups) VALUES (${group}, ${['private-artwork']})`;
    const catalog = new CatalogService(sql);
    for (const [id, age] of [
        [allowed, 6],
        [adult, 18],
        [hidden, 6],
    ] as const) {
        await sql`INSERT INTO media_items (id, title, media_type, age_rating) VALUES (${id}, ${'Artwork ' + id}, 'movie', ${age})`;
        const externalId = 'tt' + id.replaceAll('-', '');
        providerIds.set(id, 'imdb:' + externalId + ':movie');
        await catalog.upsertExternalId(id, {
            provider: 'imdb',
            id: externalId,
            mediaType: 'movie',
        });
    }
    fileIds.push(
        (
            await placeInLibraryGroup(sql, {
                mediaItemId: hidden,
                mediaType: 'movie',
                libraryGroupId: group,
            })
        ).fileId,
    );
    await catalog.upsertExternalId(hidden, {
        provider: 'tmdb',
        id: deniedTmdbId,
        mediaType: 'movie',
    });
    invalidateLibraryGroupPermissionsCache();
});

afterAll(async () => {
    await sql`DELETE FROM media_items WHERE id IN (${allowed}, ${adult}, ${hidden})`;
    await sql`DELETE FROM media_files WHERE id = ANY(${fileIds}::uuid[])`;
    await sql`DELETE FROM library_groups WHERE id = ${group}`;
    invalidateLibraryGroupPermissionsCache();
    await closeTestDb();
});

describe.each([
    ['listing', listing],
    ['bytes', bytes],
    ['indexed bytes', indexed],
] as const)('%s external artwork access with real database checks', (_name, def) => {
    async function call(id: string, viewer: 'anonymous' | 'adult' | 'kid'): Promise<Response> {
        return def.handlers.GET!(event(id, viewer), { surface: 'v1' } as never);
    }
    it('rejects an anonymous external lookup', async () => {
        expect((await call(providerIds.get(allowed)!, 'anonymous')).status).toBe(401);
    });
    it('allows an authenticated viewer to see an accessible title', async () => {
        expect((await call(providerIds.get(allowed)!, 'kid')).status).toBe(200);
    });
    it('hides an inaccessible library title even from an adult', async () => {
        expect((await call(providerIds.get(hidden)!, 'adult')).status).toBe(404);
    });
    it('cannot evade a library restriction using TMDB numeric aliases', async () => {
        for (const id of [deniedTmdbId, `0${deniedTmdbId}`, `${deniedTmdbId}junk`]) {
            expect((await call(`tmdb:${id}:movie`, 'adult')).status).toBe(404);
        }
    });
    it('does not distinguish hidden local titles from unmapped discovery handles for a library-restricted viewer', async () => {
        const unknownId = String(Number(deniedTmdbId) + 1);
        expect((await call(`tmdb:${deniedTmdbId}:movie`, 'adult')).status).toBe(404);
        expect((await call(`tmdb:${unknownId}:movie`, 'adult')).status).toBe(404);
    });
    it('hides an adult title from a kid', async () => {
        expect((await call(providerIds.get(adult)!, 'kid')).status).toBe(404);
        expect((await call(providerIds.get(adult)!, 'adult')).status).toBe(200);
    });
    it('preserves anonymous internal UUID access', async () => {
        expect((await call(adult, 'anonymous')).status).toBe(200);
    });
});
