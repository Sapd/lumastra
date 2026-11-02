// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The push rich-notification pair, driven through BOTH gates that stand in
 * front of it: `resolveAuth` (forward-auth.ts) and then the real mounted
 * handler.
 *
 * This composition is the point of the file. The endpoints shipped with a
 * green integration suite that dispatched the def handlers directly, so it
 * proved the routes work while every one of them was answering
 * `401 Bearer token required` in production — the signature check was
 * unreachable, and a deliberately WRONG signature returned the same 401 as a
 * right one. A test that does not cross the middleware cannot see that, so
 * each case here asserts the middleware stepped aside AND what the route then
 * did with the same request.
 *
 * Companion files:
 *   - forward-auth.test.ts — the middleware decision on its own, incl. the
 *     near-miss paths that must stay bearer-gated.
 *   - utils/push-rich-paths.test.ts — the exempt-path predicate, exhaustively.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ─────────────────────────────────────────────────────────────
// Hoisted above every import so resolveAuth, mount()'s feature gate and
// signUrl/verifySignedUrl all bind to the same secret and flags.

const TEST_JWT_SECRET = vi.hoisted(() => 'push-rich-signed-middleware-secret');

vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_JELLYFIN_COMPAT: false,
        FEATURE_PUSH_NOTIFICATIONS: true,
        JWT_SECRET: TEST_JWT_SECRET,
        APP_NAME: 'Lumastra',
    },
    features: { deviceAuth: true },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: () => false,
    buildUserPermissions: () => ({ isAdmin: false }),
}));

vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: () => null,
    setCachedIsAdmin: () => {},
    getCachedAdminPinned: () => null,
    setCachedAdminPinned: () => {},
    getCachedDisabled: () => null,
    setCachedDisabled: () => {},
    getCachedUserId: () => '00000000-0000-0000-0000-0000000000aa',
    setCachedUserId: () => {},
    invalidateUserAdminCache: () => {},
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => null) },
}));

vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => true),
    getKeysByPattern: vi.fn(async () => []),
    cacheGet: vi.fn(async () => null),
    setEx: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): () => Promise<unknown[]> {
            return async () => [];
        }
    }
    return { Database: MockDatabase };
});

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn(), hasScope: () => true }),
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn() }),
}));

vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({ validate: vi.fn(), getStatus: vi.fn() }),
}));

// A truthy sql handle: the handlers only pass it to the mocked query/resolver.
const FAKE_SQL = {} as unknown;
vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => FAKE_SQL,
}));

interface FakeNotificationRow {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    created_at: Date;
}
const mockGetNotificationById = vi.fn<() => Promise<FakeNotificationRow | null>>();
vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    getNotificationById: () => mockGetNotificationById(),
}));

// Keep the PURPOSE constants real — they are what the signature covers — and
// stub only the DB-backed artwork resolver.
const mockResolvePushImageTarget =
    vi.fn<() => Promise<{ mediaId: string; role: 'thumb' | 'poster' } | null>>();
vi.mock('$lib/server/services/push/push-rich-content.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/services/push/push-rich-content.js')>();
    return { ...actual, resolvePushImageTarget: () => mockResolvePushImageTarget() };
});

const mockGetImageByCatalogId =
    vi.fn<() => Promise<{ buffer: Buffer; contentType: string } | null>>();
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({ getImageByCatalogId: () => mockGetImageByCatalogId() }),
    imageResponse: (result: { buffer: Buffer; contentType: string }) =>
        new Response(new Uint8Array(result.buffer), {
            status: 200,
            headers: { 'Content-Type': result.contentType },
        }),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';
import { mount } from '$lib/server/api/mount.js';
import { signUrl } from '$lib/server/utils/signed-url.js';
import { def as pushImageDef } from '$lib/server/api/defs/notifications/[id]/push-image.js';
import { def as pushContentDef } from '$lib/server/api/defs/notifications/[id]/push-content/[locale].js';
import {
    PUSH_CONTENT_URL_PURPOSE,
    PUSH_IMAGE_URL_PURPOSE,
} from '$lib/server/services/push/push-rich-content.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ORIGIN = 'http://localhost';
const NOTIFICATION_ID = '8f2b1c34-5d6e-4a7b-8c9d-0e1f2a3b4c5d';
const IMAGE_PATH = `/api/v1/notifications/${NOTIFICATION_ID}/push-image`;
const CONTENT_PATH = `/api/v1/notifications/${NOTIFICATION_ID}/push-content/en`;

const noopMigration = async (): Promise<void> => undefined;

function makeEvent(rawUrl: string, params: Record<string, string>): RequestEvent {
    const url = new URL(rawUrl, ORIGIN);
    return {
        url,
        request: new Request(url.toString(), { method: 'GET' }),
        params,
        route: { id: url.pathname },
        // Unauthenticated by design — an NSE holds no session and no token.
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

/**
 * Run a request the way production does: middleware first, then — only if the
 * middleware let it through — the real mounted handler.
 *
 * Returns which layer answered, so a test can assert not just the status but
 * WHO produced it. `401 Bearer token required` from the middleware and `403
 * Invalid or expired signature` from the route are the two outcomes this whole
 * fix is about telling apart.
 */
async function requestThroughChain(
    rawUrl: string,
    params: Record<string, string>,
    def: typeof pushImageDef | typeof pushContentDef,
): Promise<{ layer: 'middleware' | 'route'; response: Response }> {
    const event = makeEvent(rawUrl, params);
    const short = await resolveAuth(event, noopMigration, true);
    if (short) return { layer: 'middleware', response: short };

    const { GET } = mount(def, { surface: 'v1' });
    return { layer: 'route', response: await GET!(event) };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetNotificationById.mockResolvedValue({
        id: NOTIFICATION_ID,
        kind: 'library.new_episode',
        payload: { seriesTitle: 'Starhaven', episodeTitle: 'Cold Harbor', seasonNumber: 2 },
        created_at: new Date(),
    });
    mockResolvePushImageTarget.mockResolvedValue({
        mediaId: '11111111-2222-3333-4444-555555555555',
        role: 'thumb',
    });
    mockGetImageByCatalogId.mockResolvedValue({
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        contentType: 'image/jpeg',
    });
});

// ── push-image ───────────────────────────────────────────────────────────────

describe('GET /api/v1/notifications/{id}/push-image through the real middleware', () => {
    it('unsigned: the middleware does NOT answer — the ROUTE rejects it, 403, not 401', async () => {
        const { layer, response } = await requestThroughChain(
            IMAGE_PATH,
            { id: NOTIFICATION_ID },
            pushImageDef,
        );

        expect(layer).toBe('route');
        expect(response.status).toBe(403);
        const body = (await response.json()) as { detail?: string; title?: string };
        // Distinguishable from the middleware's `Bearer token required` 401 —
        // the failure names the signature, which is the credential here.
        expect(JSON.stringify(body)).toMatch(/signature/i);
        expect(JSON.stringify(body)).not.toMatch(/Bearer token required/);
    });

    it('unsigned: nothing about the notification is read before the signature fails', async () => {
        await requestThroughChain(IMAGE_PATH, { id: NOTIFICATION_ID }, pushImageDef);
        expect(mockGetNotificationById).not.toHaveBeenCalled();
    });

    it('WRONG signature: reaches the route and is refused there (403), not silently 401d', async () => {
        const url = `${IMAGE_PATH}?expires=99999999999&purpose=${PUSH_IMAGE_URL_PURPOSE}&sig=deadbeef`;
        const { layer, response } = await requestThroughChain(
            url,
            { id: NOTIFICATION_ID },
            pushImageDef,
        );

        expect(layer).toBe('route');
        expect(response.status).toBe(403);
        expect(mockGetNotificationById).not.toHaveBeenCalled();
    });

    it('signature minted for the OTHER endpoint is refused (purposes do not cross)', async () => {
        // Same path, but signed with the content purpose.
        const signed = signUrl(IMAGE_PATH, {
            expiresIn: 3600,
            purpose: PUSH_CONTENT_URL_PURPOSE,
        });
        const { layer, response } = await requestThroughChain(
            signed,
            { id: NOTIFICATION_ID },
            pushImageDef,
        );

        expect(layer).toBe('route');
        expect(response.status).toBe(403);
    });

    it('EXPIRED signature: 403 from the route', async () => {
        const signed = signUrl(IMAGE_PATH, { expiresIn: -60, purpose: PUSH_IMAGE_URL_PURPOSE });
        const { response } = await requestThroughChain(
            signed,
            { id: NOTIFICATION_ID },
            pushImageDef,
        );
        expect(response.status).toBe(403);
    });

    it('VALID signature: 200 with the artwork bytes', async () => {
        const signed = signUrl(IMAGE_PATH, { expiresIn: 3600, purpose: PUSH_IMAGE_URL_PURPOSE });
        const { layer, response } = await requestThroughChain(
            signed,
            { id: NOTIFICATION_ID },
            pushImageDef,
        );

        expect(layer).toBe('route');
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('image/jpeg');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
            Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        );
        expect(mockGetNotificationById).toHaveBeenCalled();
    });
});

// ── push-content ─────────────────────────────────────────────────────────────

describe('GET /api/v1/notifications/{id}/push-content/{locale} through the real middleware', () => {
    it('unsigned: the ROUTE rejects it with 403, distinct from the bearer 401', async () => {
        const { layer, response } = await requestThroughChain(
            CONTENT_PATH,
            { id: NOTIFICATION_ID, locale: 'en' },
            pushContentDef,
        );

        expect(layer).toBe('route');
        expect(response.status).toBe(403);
        expect(JSON.stringify(await response.json())).not.toMatch(/Bearer token required/);
        expect(mockGetNotificationById).not.toHaveBeenCalled();
    });

    it('VALID signature: 200 with the localized title and body', async () => {
        const signed = signUrl(CONTENT_PATH, {
            expiresIn: 3600,
            purpose: PUSH_CONTENT_URL_PURPOSE,
        });
        const { layer, response } = await requestThroughChain(
            signed,
            { id: NOTIFICATION_ID, locale: 'en' },
            pushContentDef,
        );

        expect(layer).toBe('route');
        expect(response.status).toBe(200);
        const body = (await response.json()) as { title: string; body: string };
        expect(typeof body.title).toBe('string');
        expect(body.title.length).toBeGreaterThan(0);
        expect(typeof body.body).toBe('string');
    });

    it('VALID signature for de is honoured too (both mintable locales are reachable)', async () => {
        const dePath = `/api/v1/notifications/${NOTIFICATION_ID}/push-content/de`;
        const signed = signUrl(dePath, { expiresIn: 3600, purpose: PUSH_CONTENT_URL_PURPOSE });
        const { layer, response } = await requestThroughChain(
            signed,
            { id: NOTIFICATION_ID, locale: 'de' },
            pushContentDef,
        );

        expect(layer).toBe('route');
        expect(response.status).toBe(200);
    });

    it('a signature is bound to its path: one minted for `de` does not serve `en`', async () => {
        const dePath = `/api/v1/notifications/${NOTIFICATION_ID}/push-content/de`;
        const signedDe = signUrl(dePath, { expiresIn: 3600, purpose: PUSH_CONTENT_URL_PURPOSE });
        const query = signedDe.slice(signedDe.indexOf('?'));

        const { response } = await requestThroughChain(
            CONTENT_PATH + query,
            { id: NOTIFICATION_ID, locale: 'en' },
            pushContentDef,
        );
        expect(response.status).toBe(403);
    });
});

// ── The existence question ───────────────────────────────────────────────────

describe('signature failure vs unknown notification are distinguishable — to a SIGNED caller only', () => {
    it('a valid signature for a pruned notification yields 404, not 403', async () => {
        mockGetNotificationById.mockResolvedValue(null);
        const signed = signUrl(CONTENT_PATH, {
            expiresIn: 3600,
            purpose: PUSH_CONTENT_URL_PURPOSE,
        });
        const { response } = await requestThroughChain(
            signed,
            { id: NOTIFICATION_ID, locale: 'en' },
            pushContentDef,
        );

        expect(response.status).toBe(404);
    });

    it('an UNSIGNED caller gets the same 403 whether or not the notification exists', async () => {
        const existing = await requestThroughChain(
            CONTENT_PATH,
            { id: NOTIFICATION_ID, locale: 'en' },
            pushContentDef,
        );

        mockGetNotificationById.mockResolvedValue(null);
        const missing = await requestThroughChain(
            CONTENT_PATH,
            { id: NOTIFICATION_ID, locale: 'en' },
            pushContentDef,
        );

        expect(existing.response.status).toBe(403);
        expect(missing.response.status).toBe(403);
        expect(await existing.response.text()).toBe(await missing.response.text());
    });
});
