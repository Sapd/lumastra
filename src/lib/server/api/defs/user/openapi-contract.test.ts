// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Handler ↔ documented-schema divergence guard for a subset of `/api/v1/me/*`
 * routes.
 *
 * Each case invokes the def's ACTUAL exported handler (via `mount()`, so it
 * runs through the same auth/input-validation path as production), captures
 * the real JSON body, and asserts the body PARSES against the SAME zod schema
 * the route's colocated `_openapi.ts` documents. A handler/schema mismatch
 * (wrong wrapper, wrong field name, fields the handler never sends) makes the
 * `.parse()` call throw.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_USER_PATS: true,
        NEXT_EPISODE_COUNTDOWN_SECONDS: 10,
        MAL_CLIENT_ID: 'mal-client-id',
        MAL_CLIENT_SECRET: 'mal-client-secret',
    },
    features: {},
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        listForUser: vi.fn().mockResolvedValue([
            {
                id: 1,
                name: 'my-token',
                description: null,
                tokenPrefix: 'pat_abcd',
                scopes: ['read'],
                allowedIps: null,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                expiresAt: null,
                lastUsedAt: null,
                lastUsedIp: null,
                usageCount: 0,
                isExpired: false,
            },
        ]),
    }),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn().mockReturnValue({}),
}));

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: {
        one: vi.fn().mockResolvedValue(null),
    },
    upsertPlaybackPreferences: vi.fn(),
    PLAYBACK_PREF_COLUMNS: {},
}));

vi.mock('$lib/server/database/queries/mal-credentials.queries.js', () => ({
    getMalLinkStatus: vi.fn().mockResolvedValue({
        providerUsername: 'mal-user',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    deleteMalCredential: vi.fn().mockResolvedValue(true),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def as tokensDef } from './pats.js';
import { def as playbackPreferencesDef } from './playback-preferences.js';
import { def as linksIndexDef } from './links/index.js';
import { def as linksProviderDef } from './links/provider.js';

// Route OpenAPI metadata migrated onto each def as `def.docs`.
const tokensRoute = tokensDef.docs!;
const playbackPreferencesRoute = playbackPreferencesDef.docs!;
const linksIndexRoute = linksIndexDef.docs!;
const linksProviderRoute = linksProviderDef.docs!;

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeEvent(opts: {
    path: string;
    params?: Record<string, string>;
    method?: string;
}): RequestEvent {
    const url = new URL(`http://localhost${opts.path}`);
    return {
        url,
        request: new Request(url.toString(), { method: opts.method ?? 'GET' }),
        params: opts.params ?? {},
        route: { id: null },
        locals: {
            user: {
                userId: toUserId('00000000-0000-0000-0000-000000000001'),
                username: 'alice',
                groups: '',
                userGroups: [] as string[],
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: true,
                ownerIsAdmin: false,
                isModerator: false,
                maxAgeRating: null as null | number,
                isAgeRestricted: false,
                liveTvPriority: 'low' as const,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const CTX = { surface: 'v1' as const };

// ── Contract checks ──────────────────────────────────────────────────────────

describe('GET /api/v1/me/pats — handler body matches documented schema', () => {
    it('parses against the 200 response schema', async () => {
        const { GET } = mount(tokensDef, CTX);
        const res = await GET!(makeEvent({ path: '/api/v1/me/pats' }));
        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        const schema = tokensRoute.GET!.responses[200];
        expect(typeof schema === 'object' && schema !== null && 'schema' in schema).toBe(true);
        expect(() =>
            (schema as { schema: { parse: (v: unknown) => unknown } }).schema.parse(body),
        ).not.toThrow();
    });
});

describe('GET /api/v1/me/playback-preferences — handler body matches documented schema', () => {
    it('parses against the 200 response schema', async () => {
        const { GET } = mount(playbackPreferencesDef, CTX);
        const res = await GET!(makeEvent({ path: '/api/v1/me/playback-preferences' }));
        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        const schema = playbackPreferencesRoute.GET!.responses[200];
        expect(typeof schema === 'object' && schema !== null && 'schema' in schema).toBe(true);
        expect(() =>
            (schema as { schema: { parse: (v: unknown) => unknown } }).schema.parse(body),
        ).not.toThrow();
    });
});

describe('GET /api/v1/me/links — handler body matches documented schema', () => {
    it('parses against the 200 response schema and preserves the real fields', async () => {
        const { GET } = mount(linksIndexDef, CTX);
        const res = await GET!(makeEvent({ path: '/api/v1/me/links' }));
        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        const schema = linksIndexRoute.GET!.responses[200];
        expect(typeof schema === 'object' && schema !== null && 'schema' in schema).toBe(true);
        const parsed = (schema as { schema: { parse: (v: unknown) => unknown } }).schema.parse(
            body,
        ) as { links: Array<Record<string, unknown>> };
        // The handler sends `providerUsername`, `name`, and `configured` — a
        // schema still declaring the never-populated `username` field (and
        // omitting `name`/`configured`) would parse without throwing (zod
        // silently strips undeclared keys) but drop the real data.
        expect(parsed.links[0]).toMatchObject({
            provider: 'mal',
            name: 'MyAnimeList',
            configured: true,
            linked: true,
            providerUsername: 'mal-user',
        });
    });
});

describe('GET /api/v1/me/links/{provider} — handler body matches documented schema', () => {
    it('parses against the 200 response schema', async () => {
        const { GET } = mount(linksProviderDef, CTX);
        const res = await GET!(
            makeEvent({ path: '/api/v1/me/links/mal', params: { provider: 'mal' } }),
        );
        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        const schema = linksProviderRoute.GET!.responses[200];
        expect(typeof schema === 'object' && schema !== null && 'schema' in schema).toBe(true);
        expect(() =>
            (schema as { schema: { parse: (v: unknown) => unknown } }).schema.parse(body),
        ).not.toThrow();
    });
});
