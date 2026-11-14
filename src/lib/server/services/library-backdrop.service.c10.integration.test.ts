// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for C10 (2026-09-18 fix plan 4 task 6) — the library
 * mosaic/backdrop image leaked a restricted library's poster art with no
 * relation to the caller, reachable identically through three independent
 * route handlers:
 *
 *   1. src/lib/server/api/defs/libraries/[id]/images/[role].ts
 *   2. src/routes/api/image/library/[id]/[type]/+server.ts
 *   3. src/routes/(modules)/j/Items/[itemId]/Images/[imageType]/+server.ts
 *
 * (plus a fourth, non-image-bytes sibling: defs/libraries/[id]/images/index.ts,
 * the roles listing, which shares the same gap and the same fix.)
 *
 * The fix is ONE gated path: `isLibraryGroup(sql, id, user)` in
 * library-backdrop.service.ts now takes the caller's LibraryAccessUser and
 * folds the denied-group check into the existence check, so a denied group
 * and a nonexistent one are indistinguishable to every caller. This test
 * proves that at the shared function (real Postgres, two rows — a group the
 * caller may see and one it may not) AND drives routes 1 and 2 directly to
 * prove each of them actually uses the gated function rather than a
 * bypassable copy.
 *
 * Review round 1 correction: route 3 is `authz: public` and is NEVER wrapped
 * in `withJellyfinAuth` — `locals.user` is always undefined there in
 * production (`/j/*` is self-authenticating per-route; `forward-auth.ts`'s
 * `resolveAuth` passes `/j/*` straight through with no identity resolved).
 * The first round of this test invented a `locals.user` that route 3 can
 * never have, which is exactly the "test at the seam, never a hand-built
 * principal" failure Global Constraint 2 exists to prevent — a real request
 * to route 3 would have hit `toLibraryAccessUser(undefined)` → `undefined`,
 * skipping the denied-group check entirely, and the invented principal in
 * the test hid that. The fix removes library-group serving from route 3
 * altogether (a library-group id now falls through to the same
 * unauthenticated catalog-image path an unrecognized id already takes,
 * landing on the same default placeholder — see that route's own
 * `defaultImageResponse` doc comment) rather than adding real auth to an
 * image proxy Infuse/Swiftfin/etc. fetch without credentials. Route 3's test
 * below asserts that real, credential-free behavior — no invented user.
 *
 * 2026-10-02: route 3 serves the mosaic again, but only for a signed ImageTag
 * that /j/UserViews mints for groups the caller is not denied
 * (jellyfin-compat/library-image-tag.ts). The tag is the capability; the
 * untagged behavior above is unchanged.
 *
 * Also covers the round-1 CRITICAL: the denial check must live in SQL
 * (`id != ALL(denied::uuid[])`), not as a JS `.includes(itemId)` against the
 * raw request string — Jellyfin's native client form is a DASHLESS uuid,
 * which Postgres treats as equal to the canonical dashed form under `::uuid`
 * but a JS string `.includes()` would not.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

function locals(userGroups: string[]): RequestEvent['locals'] {
    return {
        user: {
            username: 'route-c10-test',
            userId: randomUUID(),
            groups: '',
            userGroups,
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            isAdmin: false,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: false,
            liveTvPriority: 'low',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

describe.runIf(RUN)('Library mosaic/backdrop image access gate (C10)', () => {
    let sql: postgres.Sql;
    let deniedGroupId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    async function seed(): Promise<void> {
        deniedGroupId = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Route C10 Denied Group')`;
        await sql`
            INSERT INTO library_paths (library_group_id, path, media_type, enabled)
            VALUES (${deniedGroupId}::uuid, '/data/route-c10-denied', 'movie', true)
        `;
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: deniedGroupId,
            allowedGroups: ['adults'],
        });
        invalidateLibraryGroupPermissionsCache();
    }

    async function cleanup(): Promise<void> {
        if (deniedGroupId) {
            await deleteLibraryGroupPermission(sql, deniedGroupId);
            await sql`DELETE FROM library_paths WHERE library_group_id = ${deniedGroupId}::uuid`;
            await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
        }
        invalidateLibraryGroupPermissionsCache();
    }

    it('isLibraryGroup: a denied group and a nonexistent id are both false; an allowed group is true', async () => {
        await seed();
        try {
            const { isLibraryGroup } =
                await import('$lib/server/services/library-backdrop.service.js');
            const { toLibraryAccessUser } =
                await import('$lib/server/cache/library-group-permissions-cache.js');
            const denied = toLibraryAccessUser({ ownerIsAdmin: false, userGroups: ['kids'] });
            const allowed = toLibraryAccessUser({ ownerIsAdmin: false, userGroups: ['adults'] });

            const unknownId = randomUUID();
            expect(await isLibraryGroup(sql, unknownId, denied)).toBe(false);
            expect(await isLibraryGroup(sql, deniedGroupId, denied)).toBe(false);
            expect(await isLibraryGroup(sql, deniedGroupId, allowed)).toBe(true);
        } finally {
            await cleanup();
        }
    });

    it('isLibraryGroup: the denial check is immune to a dashless UUID — the native Jellyfin client form', async () => {
        // Round-1 CRITICAL: the first fix compared `denied.includes(itemId)` in
        // JS. `getDeniedLibraryGroups` returns canonical lowercase-dashed ids;
        // isUuid() accepts (and Jellyfin clients natively send) a dashless
        // 32-hex form. Postgres treats every UUID spelling as equal under
        // `::uuid`, so the SQL-side existence check found the row either way,
        // but the JS-side denial check missed on the dashless spelling and
        // failed OPEN. Assert both spellings deny identically.
        await seed();
        try {
            const { isLibraryGroup } =
                await import('$lib/server/services/library-backdrop.service.js');
            const { toLibraryAccessUser } =
                await import('$lib/server/cache/library-group-permissions-cache.js');
            const denied = toLibraryAccessUser({ ownerIsAdmin: false, userGroups: ['kids'] });

            const dashless = deniedGroupId.replace(/-/g, '');
            expect(dashless).not.toContain('-');
            expect(await isLibraryGroup(sql, dashless, denied)).toBe(false);
            expect(await isLibraryGroup(sql, dashless.toUpperCase(), denied)).toBe(false);
        } finally {
            await cleanup();
        }
    });

    it('route 1 — defs/libraries/[id]/images/[role].ts: denied group 404s byte-identically to an unknown id', async () => {
        await seed();
        try {
            const { def } = await import('$lib/server/api/defs/libraries/[id]/images/[role].js');
            const GET = def.handlers.GET!;

            const unknownId = randomUUID();
            const unknownResp = await GET(
                {
                    params: { id: unknownId, role: 'poster' },
                    request: new Request(
                        `http://localhost/api/v1/libraries/${unknownId}/images/poster`,
                    ),
                    locals: locals(['kids']),
                } as unknown as RequestEvent,
                {} as never,
            );
            const deniedResp = await GET(
                {
                    params: { id: deniedGroupId, role: 'poster' },
                    request: new Request(
                        `http://localhost/api/v1/libraries/${deniedGroupId}/images/poster`,
                    ),
                    locals: locals(['kids']),
                } as unknown as RequestEvent,
                {} as never,
            );
            expect(deniedResp.status).toBe(unknownResp.status);
            expect(deniedResp.status).toBe(404);
            expect(await deniedResp.text()).toBe(await unknownResp.text());

            const allowedResp = await GET(
                {
                    params: { id: deniedGroupId, role: 'poster' },
                    request: new Request(
                        `http://localhost/api/v1/libraries/${deniedGroupId}/images/poster`,
                    ),
                    locals: locals(['adults']),
                } as unknown as RequestEvent,
                {} as never,
            );
            expect(allowedResp.status).toBe(200);
        } finally {
            await cleanup();
        }
    });

    it('route 2 — routes/api/image/library/[id]/[type]: denied group 404s byte-identically to an unknown id', async () => {
        await seed();
        try {
            const { GET } =
                await import('../../../routes/api/image/library/[id]/[type]/+server.js');

            const unknownId = randomUUID();
            const unknownResp = await GET({
                params: { id: unknownId, type: 'poster' },
                url: new URL(`http://localhost/api/image/library/${unknownId}/poster`),
                request: new Request(`http://localhost/api/image/library/${unknownId}/poster`),
                locals: locals(['kids']),
                getClientAddress: () => '127.0.0.1',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            const deniedResp = await GET({
                params: { id: deniedGroupId, type: 'poster' },
                url: new URL(`http://localhost/api/image/library/${deniedGroupId}/poster`),
                request: new Request(`http://localhost/api/image/library/${deniedGroupId}/poster`),
                locals: locals(['kids']),
                getClientAddress: () => '127.0.0.1',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            expect(deniedResp.status).toBe(unknownResp.status);
            expect(deniedResp.status).toBe(404);
            expect(await deniedResp.text()).toBe(await unknownResp.text());

            const allowedResp = await GET({
                params: { id: deniedGroupId, type: 'poster' },
                url: new URL(`http://localhost/api/image/library/${deniedGroupId}/poster`),
                request: new Request(`http://localhost/api/image/library/${deniedGroupId}/poster`),
                locals: locals(['adults']),
                getClientAddress: () => '127.0.0.1',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            expect(allowedResp.status).toBe(200);
        } finally {
            await cleanup();
        }
    });

    it('route 3 — /j/Items/{itemId}/Images/{imageType}: WITHOUT a signed tag never serves the library mosaic (unauthenticatable surface); a library-group id collapses to the same placeholder as an unknown id, with NO locals.user', async () => {
        await seed();
        try {
            const { GET } =
                await import('../../../routes/(modules)/j/Items/[itemId]/Images/[imageType]/+server.js');

            // No `locals.user` at all — this is the real shape of every request
            // this route ever receives in production (see the module doc
            // comment above). A test that invents one here would not be
            // testing the seam this route actually has.
            const unknownId = randomUUID();
            const unknownResp = await GET({
                params: { itemId: unknownId, imageType: 'Primary' },
                url: new URL(`http://localhost/j/Items/${unknownId}/Images/Primary`),
                request: new Request(`http://localhost/j/Items/${unknownId}/Images/Primary`),
                locals: {},
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            // The denied library group's id, fetched with no session — this is
            // exactly the request an unauthenticated attacker with the group's
            // UUID would send.
            const groupResp = await GET({
                params: { itemId: deniedGroupId, imageType: 'Primary' },
                url: new URL(`http://localhost/j/Items/${deniedGroupId}/Images/Primary`),
                request: new Request(`http://localhost/j/Items/${deniedGroupId}/Images/Primary`),
                locals: {},
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);

            // This surface is intentionally always-200 (anti-oracle design, see
            // the route's own defaultImageResponse doc comment). The invariant
            // is that a library-group id gets the exact same placeholder bytes
            // an unknown id gets — i.e. this route never serves the real
            // mosaic at all, so there is nothing left for an unauthenticated
            // caller to leak.
            expect(groupResp.status).toBe(unknownResp.status);
            expect([...groupResp.headers].sort()).toEqual([...unknownResp.headers].sort());
            const [groupBytes, unknownBytes] = await Promise.all([
                groupResp.arrayBuffer(),
                unknownResp.arrayBuffer(),
            ]);
            expect(Buffer.from(groupBytes).equals(Buffer.from(unknownBytes))).toBe(true);
        } finally {
            await cleanup();
        }
    });

    // 2026-10-02: route 3 serves the mosaic again, but only behind the signed
    // ImageTag that /j/UserViews mints for groups the caller is NOT denied
    // (library-image-tag.ts). Still no locals.user — the tag is the capability.
    async function getRoute3(groupId: string, query: string): Promise<Response> {
        const { GET } =
            await import('../../../routes/(modules)/j/Items/[itemId]/Images/[imageType]/+server.js');
        const url = `http://localhost/j/Items/${groupId}/Images/Primary${query}`;
        return GET({
            params: { itemId: groupId, imageType: 'Primary' },
            url: new URL(url),
            request: new Request(url),
            locals: {},
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    }

    it('route 3 — a tag minted for THIS library serves its art (an empty library: its placeholder, not the default one)', async () => {
        await seed();
        try {
            const { libraryImageTag } =
                await import('$lib/server/jellyfin-compat/library-image-tag.js');
            const tag = libraryImageTag(deniedGroupId);
            expect(tag, 'JWT_SECRET (or the master key it derives from) must be set').toBeTruthy();

            const tagged = await getRoute3(deniedGroupId, `?tag=${tag}&maxHeight=300`);
            expect(tagged.status).toBe(200);
            expect(tagged.headers.get('content-type')).toBe('image/webp');
            expect(tagged.headers.get('x-lumastra-placeholder')).toBeNull();
            expect(tagged.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/);

            // Dashless id form (some Jellyfin clients) — same library, same art.
            const dashless = await getRoute3(deniedGroupId.replace(/-/g, ''), `?tag=${tag}`);
            expect(dashless.headers.get('etag')).toBe(tagged.headers.get('etag'));
        } finally {
            await cleanup();
        }
    });

    it('route 3 — a tag for ANOTHER library, a forged tag, or none: the default placeholder, byte-identical to an unknown id', async () => {
        await seed();
        try {
            const { libraryImageTag } =
                await import('$lib/server/jellyfin-compat/library-image-tag.js');
            const otherTag = libraryImageTag(randomUUID())!;
            const unknown = await getRoute3(randomUUID(), '');
            const unknownBytes = Buffer.from(await unknown.arrayBuffer());

            for (const query of [`?tag=${otherTag}`, `?tag=${'f'.repeat(40)}`, '']) {
                const resp = await getRoute3(deniedGroupId, query);
                expect(resp.status).toBe(unknown.status);
                expect(resp.headers.get('x-lumastra-placeholder')).toBe(
                    unknown.headers.get('x-lumastra-placeholder'),
                );
                expect(Buffer.from(await resp.arrayBuffer()).equals(unknownBytes)).toBe(true);
            }
        } finally {
            await cleanup();
        }
    });
});
