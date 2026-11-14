// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runtime coverage for endpoints the static `client-contract-parity.test.ts`
 * guard cannot assert (M5 in the contract-cleanup backlog):
 *
 *   - GET /api/health     — masked because the v1 `[...path]` catch-all's
 *                            `_openapi.ts` resolves first and documents no
 *                            GET 2xx schema for this path.
 *   - GET /api/assistant   — same catch-all-masking; also a module route.
 *   - GET /api/playlists   — same catch-all-masking.
 *
 * Each test below invokes the REAL handler (mocking only its DB/service
 * dependencies) and asserts the JSON body satisfies the CLIENT's Zod schema
 * for that endpoint — the exact assertion the static guard would have made
 * had it been able to resolve the server side. This is test-only coverage;
 * it does not restructure the `[...path]` catch-all.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { SystemHealthResponseSchema } from '$lib/schemas/api-admin-responses';
import { ChatRateLimitResponseSchema } from '$lib/schemas/api-ai-responses';
import { playlistSchema } from '$lib/schemas/playlists';
import { PageBlockSchema } from '$lib/schemas/pagination';

// ---------------------------------------------------------------------------
// GET /api/health?detail=true — SystemHealthResponseSchema
//
// NOTE: this file deliberately does NOT mock `$lib/server/config.js` — the
// /api/assistant import graph below (assistant tools →
// jellyseerr/jellyfin clients) instantiates several module-scope singletons
// that read many `config.*` keys eagerly at import time. The real config
// module already provides safe defaults for every key (env-driven with
// fallbacks), so importing it for real is far more robust here than trying
// to hand-mock every key those singletons happen to touch.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/api/mount.js', () => ({
    enforce: vi.fn(async () => null),
}));

vi.mock('$lib/server/health/component-health.js', () => ({
    buildComponentHealth: vi.fn(async () => ({
        database: { status: 'pass' },
        valkey: { status: 'pass' },
    })),
}));

describe('GET /api/health?detail=true — runtime parity with SystemHealthResponseSchema', () => {
    it('emits a body the client schema accepts', async () => {
        const { GET } = await import('../src/routes/api/health/+server.js');
        const url = new URL('http://localhost/api/health?detail=true');
        const res = await GET({
            url,
            locals: { user: { ownerIsAdmin: true } },
        } as unknown as Parameters<typeof GET>[0]);

        expect(res.status).toBe(200);
        const body: unknown = JSON.parse(await res.text());
        expect(() => SystemHealthResponseSchema.parse(body)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// GET /api/assistant — ChatRateLimitResponseSchema
// ---------------------------------------------------------------------------

vi.mock('$lib/server/database', () => ({
    getDb: vi.fn(() => ({})), // non-null sentinel
}));

vi.mock('$lib/server/config/domains/ai.js', () => ({
    getAiConfig: vi.fn(() => ({
        assistantDailyTokenLimitAdmin: 100_000,
        assistantDailyTokenLimitUser: 20_000,
    })),
}));

vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: vi.fn(() => false),
}));

vi.mock('$lib/server/database/queries/assistant-rag.queries.js', () => ({
    getDailyTokenUsage: vi.fn(async () => 1234),
}));

describe('GET /api/assistant — runtime parity with ChatRateLimitResponseSchema', () => {
    it('emits a body the client schema accepts', async () => {
        const { GET } = await import('../src/routes/api/(modules)/assistant/+server.js');
        const res = await GET({
            url: new URL('http://localhost/api/assistant'),
            locals: {
                user: { username: 'alice', userId: 'user-uuid', userGroups: [] },
            },
        } as unknown as Parameters<typeof GET>[0]);

        expect(res.status).toBe(200);
        const body: unknown = JSON.parse(await res.text());
        expect(() => ChatRateLimitResponseSchema.parse(body)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// GET /api/playlists — playlistsPagedResponseSchema ({ items, page })
//
// `playlistsPagedResponseSchema` in `$lib/api/playlists.ts` is a local
// (non-exported) const, so it's reconstructed here from the same building
// blocks (`playlistSchema` + the shared `PageBlockSchema`) it is built from.
// ---------------------------------------------------------------------------

const PlaylistsPagedResponseSchema = z.object({
    items: z.array(playlistSchema),
    page: PageBlockSchema,
});

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => ({})), // non-null sentinel
}));

// Keep artwork I/O mocked while exercising the real playlist projection.
vi.mock('$lib/server/services/image-descriptor/avatars.js', async () => {
    const { userAvatarSet } = await import('$lib/server/services/image-descriptor/resolver.js');
    return {
        userImageSets: async (_sql: unknown, surface: 'internal' | 'v1', ids: string[]) =>
            new Map(
                ids.map((userId) => [userId, userAvatarSet(surface, { userId, version: '0' })]),
            ),
    };
});

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    // A UUID, not the legacy numeric id: the def now passes this through
    // toUserId(), which rejects anything that is not a users.id UUID.
    getUserIdByUsername: vi.fn(async () => '00000000-0000-4000-8000-000000000042'),
}));

// The def calls this before branching on scope; unmocked it would reach the
// real query with this file's stub `sql`.
vi.mock('$lib/server/database/queries/watchlist-playlist.queries.js', () => ({
    ensureWatchlistPlaylist: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/database/queries/playlists.queries.js', () => ({
    getOwnedPlaylists: vi.fn(async () => [
        {
            id: 1,
            user_id: '00000000-0000-4000-8000-000000000042',
            owner_display_name: 'Alice',
            name: 'My Playlist',
            description: null,
            visibility: 'private',
            playlist_type: 'general',
            cover_image: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            item_count: 3,
            member_count: 1,
            revision: 0,
            is_system: false,
            cover_items: [],
        },
    ]),
    getSharedPlaylists: vi.fn(async () => []),
}));

// The def's GET handler builds a viewer access context (for cover-art
// library/age filtering) via `buildSearchAccessContext`, which — unmocked —
// resolves real permissions through `getAllLibraryGroupPermissions(sql)` and
// throws "sql is not a function" against the `getDb()` sentinel object above
// (there is no real DB in this unit test). Mock the whole module the same way
// `playlists-collection.def.test.ts` does for the same def, including the
// `searchAccessBoundary` projection the handler also calls directly.
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({
        username: 'alice',
        deniedGroupIds: null,
        ageRating: null,
        liveTvAllowed: true,
        showUnavailableMedia: true,
    })),
    unauthenticatedSearchAccessContext: vi.fn(() => ({
        username: null,
        deniedGroupIds: null,
        ageRating: { maxAgeRating: -1, allowUnrated: false },
        liveTvAllowed: false,
        showUnavailableMedia: false,
    })),
    searchAccessBoundary: vi.fn(
        (ctx: {
            deniedGroupIds: string[] | null;
            ageRating: { maxAgeRating: number | null; allowUnrated: boolean } | null;
        }) => ({
            library:
                ctx.deniedGroupIds && ctx.deniedGroupIds.length > 0
                    ? { kind: 'denyGroups', ids: ctx.deniedGroupIds }
                    : { kind: 'all' },
            age:
                ctx.ageRating && ctx.ageRating.maxAgeRating !== null
                    ? {
                          kind: 'limit',
                          maxAgeRating: ctx.ageRating.maxAgeRating,
                          allowUnrated: ctx.ageRating.allowUnrated,
                      }
                    : { kind: 'any' },
        }),
    ),
}));

describe('GET /api/playlists (def) — runtime parity with { items, page } envelope', () => {
    it('emits a body the client schema accepts', async () => {
        const { def } = await import('$lib/server/api/defs/playlists/index.js');
        const url = new URL('http://localhost/api/playlists');
        const event = {
            url,
            locals: { user: { username: 'alice' } },
        } as unknown as Parameters<NonNullable<typeof def.handlers.GET>>[0];

        const res = await def.handlers.GET!(event, {
            surface: 'internal',
        });

        expect(res.status).toBe(200);
        const body: unknown = JSON.parse(await res.text());
        const parsed = PlaylistsPagedResponseSchema.parse(body);
        expect(parsed.items).toHaveLength(1);
        expect(parsed.items[0]).toMatchObject({
            owner: { userId: '00000000-0000-4000-8000-000000000042', displayName: 'Alice' },
            images: {},
            revision: 0,
            memberCount: 1,
        });
    });
});
