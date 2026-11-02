// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    AnonymousServerInfoSchema,
    ServerInfoSchema,
    ServerFeaturesSchema,
} from '$lib/schemas/server-info.js';

const configState = vi.hoisted(() => ({
    APP_NAME: 'Lumastra',
    buildInfo: { version: '0.1.0-5-gabc1234' },
    FEATURE_DEVICE_AUTH: true,
    AUTH_NATIVE_LOGIN_ENABLED: true,
    MIN_CLIENT_VERSION_IOS: '',
    MIN_CLIENT_VERSION_TVOS: '',
    MIN_CLIENT_VERSION_WEB: '',
    MIN_CLIENT_VERSION_OTHER: '',
}));
vi.mock('$lib/server/config.js', () => ({ config: configState }));
const { getServerId, rateLimit } = vi.hoisted(() => ({ getServerId: vi.fn(), rateLimit: vi.fn() }));
vi.mock('$lib/server/config/server-id.js', () => ({ getServerId }));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({ checkRateLimit: rateLimit }));
vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIpStrict: () => null }));
beforeEach(() => {
    getServerId.mockResolvedValue('11111111-1111-4111-8111-111111111111');
    rateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
});
vi.mock('$lib/server/server-branding.js', () => ({
    getServerBranding: async () => ({
        appName: 'Lumastra',
        appDescription: 'Media Dashboard',
        secret: 'do not emit',
    }),
}));
vi.mock('./capabilities.js', () => ({
    buildServerCapabilities: vi.fn(async (surface: 'internal' | 'v1') => ({
        playback: {
            direct: true,
            remux: false,
            transcode: false,
            transcoder: {
                engine: 'ffmpeg',
                videoCodecs: [],
                audioCodecs: [],
                containers: [],
                maxResolution: '4K',
                hdrPassthrough: true,
                dolbyVisionPassthrough: false,
            },
            hlsVariants: [],
            maxBitrateKbps: null,
        },
        liveTv: {
            available: true,
            adaptiveLadder: {
                enabled: false,
                defaultQuality: 'original',
                includeOriginalExperimental: false,
                rungs: [],
            },
        },
        music: { available: false, clustering: false, sonicSimilarity: false, sonicMixes: false },
        audiobooks: { available: false },
        features: Object.fromEntries(
            Object.keys(ServerFeaturesSchema.shape).map((key) => [key, false]),
        ),
        integrations: { requests: { available: false } },
        push: { available: false },
        events: {
            href: surface === 'v1' ? '/api/v1/events' : '/api/events',
            reconnectMaxMs: 30000,
            kinds: [],
        },
        metadata: { primary: 'en', additional: [] },
    })),
}));
import { def, buildServerInfo, sanitizeRelease, serverInfoEtag } from './index.js';

function event(principal?: App.Locals['principal']): RequestEvent {
    return {
        locals: { principal, user: { hasRequestPermission: true } },
        request: new Request('http://localhost/api/v1/server'),
    } as unknown as RequestEvent;
}

const versionWarn = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => ({ warn: versionWarn }) } }));
describe('server bootstrap tiers', () => {
    it.each([
        'MIN_CLIENT_VERSION_IOS',
        'MIN_CLIENT_VERSION_TVOS',
        'MIN_CLIENT_VERSION_WEB',
        'MIN_CLIENT_VERSION_OTHER',
    ] as const)('drops invalid %s values supplied by any config source and warns', async (key) => {
        for (const invalid of ['latest', 'v1.2.3', '1.0.0-01', '1.2', '1.2.3\n']) {
            configState[key] = invalid;
            versionWarn.mockClear();
            try {
                const response = await def.handlers.GET!(event(), { surface: 'v1' });
                expect(response.status).toBe(200);
                expect(ServerInfoSchema.parse(await response.json())).toHaveProperty(
                    'minClientVersion',
                    null,
                );
                expect(versionWarn).toHaveBeenCalledWith(
                    expect.stringContaining('minimum client version'),
                    expect.objectContaining({ key }),
                );
            } finally {
                configState[key] = '';
            }
        }
    });
    it('retains valid platforms while dropping invalid ones', async () => {
        configState.MIN_CLIENT_VERSION_IOS = 'bad';
        configState.MIN_CLIENT_VERSION_TVOS = '2.0.0-rc.1+build.7';
        try {
            const response = await def.handlers.GET!(event(userPrincipal()), { surface: 'v1' });
            expect(response.status).toBe(200);
            expect(ServerInfoSchema.parse(await response.json())).toHaveProperty(
                'minClientVersion',
                { tvos: '2.0.0-rc.1+build.7' },
            );
        } finally {
            configState.MIN_CLIENT_VERSION_IOS = '';
            configState.MIN_CLIENT_VERSION_TVOS = '';
        }
    });
    it('advertises no minimum by default, and platform minimums before sign-in', async () => {
        expect(await buildServerInfo(event(), 'v1')).toHaveProperty('minClientVersion', null);
        configState.MIN_CLIENT_VERSION_IOS = '1.2.3';
        configState.MIN_CLIENT_VERSION_TVOS = '2.0.0-rc.1';
        try {
            const body = await buildServerInfo(event(), 'v1');
            expect(body).toHaveProperty('minClientVersion', { ios: '1.2.3', tvos: '2.0.0-rc.1' });
            expect(ServerInfoSchema.parse(body)).toEqual(body);
        } finally {
            configState.MIN_CLIENT_VERSION_IOS = '';
            configState.MIN_CLIENT_VERSION_TVOS = '';
        }
    });
    it('recursively limits anonymous keys and rejects additional keys', async () => {
        const body = await buildServerInfo(event(), 'v1');
        const allowed: Record<string, string[]> = {
            '': [
                'id',
                'name',
                'release',
                'apiVersions',
                'minClientVersion',
                'branding',
                'auth',
                'links',
                'caller',
            ],
            branding: ['appName', 'appDescription'],
            auth: ['deviceFlow', 'passwordLogin'],
            'auth.deviceFlow': ['enabled', 'deviceAuthorizationHref', 'tokenHref'],
            'auth.passwordLogin': ['enabled'],
            links: ['self'],
        };
        function inspect(value: unknown, path = ''): void {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return;
            for (const [key, child] of Object.entries(value)) {
                expect(allowed[path], `${path}.${key}`).toContain(key);
                inspect(child, path ? `${path}.${key}` : key);
            }
        }
        inspect(body);
        expect(AnonymousServerInfoSchema.parse(body)).toEqual(body);
        expect(AnonymousServerInfoSchema.safeParse({ ...body, build: 'secret' }).success).toBe(
            false,
        );
        expect(JSON.stringify(body)).not.toContain('abc1234');
    });
    it.each([false, true])('caller reports credential admin authority %s', async (admin) => {
        const principal = buildPrincipal({
            kind: 'pat',
            userId: toUserId('22222222-2222-4222-8222-222222222222'),
            username: 'test',
            userGroups: [],
            ownerIsAdmin: true,
            tokenScopes: admin ? ['admin'] : ['read'],
        });
        const body = await buildServerInfo(event(principal), 'v1');
        expect(body.caller?.isAdmin).toBe(admin);
        const { buildServerCapabilities } = await import('./capabilities.js');
        expect(buildServerCapabilities).toHaveBeenLastCalledWith('v1', admin);
        expect(body.caller?.id).toBe(principal.userId);
        expect(body.caller?.permissions.canRequest).toBe(true);
    });
    it.each([
        ['hasRequestPermission', 'canRequest'],
        ['hasReviewPermission', 'canReview'],
        ['hasMediaAnnotationPermission', 'canAnnotateMedia'],
        ['hasLiveTvPermission', 'canWatchLiveTv'],
        ['hasWatchPermission', 'canSeeAllPlayback'],
    ] as const)('config.user.%s maps to caller.permissions.%s', async (oldKey, newKey) => {
        const principal = buildPrincipal({
            kind: 'session',
            userId: toUserId('22222222-2222-4222-8222-222222222222'),
            username: 'test',
            userGroups: [],
        });
        const request = event(principal);
        request.locals.user = { [oldKey]: true } as unknown as App.Locals['user'];
        const body = await buildServerInfo(request, 'v1');
        expect(body.caller?.permissions[newKey]).toBe(true);
        expect(Object.values(body.caller!.permissions).filter(Boolean)).toHaveLength(1);
    });
    it('ETags separate tiers and track the actual caller and body', async () => {
        const anon = await buildServerInfo(event(), 'v1');
        expect(serverInfoEtag(anon)).toBe(serverInfoEtag(anon));
        expect(serverInfoEtag({ ...anon, name: 'Other' })).not.toBe(serverInfoEtag(anon));
        const principal = buildPrincipal({
            kind: 'session',
            userId: toUserId('22222222-2222-4222-8222-222222222222'),
            username: 'test',
            userGroups: [],
        });
        expect(serverInfoEtag(await buildServerInfo(event(principal), 'v1'))).not.toBe(
            serverInfoEtag(anon),
        );
    });
});
describe('release sanitizer', () => {
    it.each([
        ['v0.1.0', '0.1.0'],
        ['0.1.0-5-gabc1234', '0.1.0'],
        ['0.1.0+a1b2c3d', '0.1.0'],
        ['v0.1.0-rc.1-5-gabc1234-dirty', '0.1.0-rc.1'],
        ['abc1234', 'unknown'],
        ['branch-name', 'unknown'],
    ])('%s => %s', (input, expected) => {
        expect(sanitizeRelease(input)).toBe(expected);
    });
});

function userPrincipal(kind: 'pat' | 'session' | 'stream_token' | 'service_token' = 'pat') {
    const principal = buildPrincipal({
        kind,
        userId: toUserId('22222222-2222-4222-8222-222222222222'),
        username: 'alice',
        userGroups: [],
        tokenScopes: ['read'],
        sessionIsAdmin: false,
    });
    // Simulate an external identity resolver returning an opaque, non-UUID id.
    return { ...principal, userId: 'external-user-id' } as NonNullable<App.Locals['principal']>;
}

describe('bootstrap handler contract', () => {
    it.each(['v1', 'internal'] as const)(
        'validates authenticated body and links on %s',
        async (surface) => {
            const request = event(userPrincipal());
            (request.locals as Partial<App.Locals>).user = undefined;
            const response = await def.handlers.GET!(request, { surface });
            const body = ServerInfoSchema.parse(await response.json());
            const prefix = surface === 'v1' ? '/api/v1' : '/api';
            expect(body.links).toEqual({
                self: `${prefix}/server`,
                me: `${prefix}/me`,
                events: `${prefix}/events`,
                notice: `${prefix}/server/notice`,
            });
            expect(body).toHaveProperty('build', '0.1.0-5-gabc1234');
            expect(body.caller?.id).toBe('external-user-id');
            // Five permission flags, all false for this caller (canSeeAllPlayback included).
            expect(Object.values(body.caller!.permissions)).toEqual([
                false,
                false,
                false,
                false,
                false,
            ]);
            expect(body).toHaveProperty('capabilities.events.href', `${prefix}/events`);
        },
    );
    it.each(['stream_token', 'service_token'] as const)(
        '%s stays anonymous even with a user context',
        async (kind) => {
            const body = await buildServerInfo(event(userPrincipal(kind)), 'v1');
            expect(AnonymousServerInfoSchema.parse(body).caller).toBeNull();
        },
    );
    it('link-only user context without a principal stays anonymous', async () => {
        const body = await buildServerInfo(event(), 'internal');
        expect(AnonymousServerInfoSchema.parse(body).caller).toBeNull();
    });
    it('sets cache headers and keeps authenticated data out of anonymous replies', async () => {
        const response = await def.handlers.GET!(event(), { surface: 'v1' });
        expect(response.headers.get('cache-control')).toBe('private, no-cache');
        expect(response.headers.get('vary')).toBe('Authorization, Cookie');
        expect(response.headers.get('etag')).toContain(':anonymous:');
        expect(AnonymousServerInfoSchema.parse(await response.json()).links).toEqual({
            self: '/api/v1/server',
        });
    });
    it.each(['strong', 'weak', 'list', 'star'])(
        'returns 304 for %s If-None-Match',
        async (kind) => {
            const first = await def.handlers.GET!(event(), { surface: 'v1' });
            const etag = first.headers.get('etag')!;
            const request = event();
            const validators = {
                strong: etag,
                weak: `W/${etag}`,
                list: `"other", W/${etag}`,
                star: '*',
            };
            request.request.headers.set(
                'if-none-match',
                validators[kind as keyof typeof validators],
            );
            const response = await def.handlers.GET!(request, { surface: 'v1' });
            expect(response.status).toBe(304);
            expect(await response.text()).toBe('');
            expect(response.headers.get('etag')).toBe(etag);
            expect(response.headers.get('cache-control')).toBe('private, no-cache');
            expect(response.headers.get('vary')).toBe('Authorization, Cookie');
        },
    );
    it('returns 200 when a bearer caller replays an anonymous validator', async () => {
        const anonymous = await def.handlers.GET!(event(), { surface: 'v1' });
        const request = event(userPrincipal());
        request.request.headers.set('authorization', 'Bearer pat_valid');
        request.request.headers.set('if-none-match', anonymous.headers.get('etag')!);
        const response = await def.handlers.GET!(request, { surface: 'v1' });
        expect(response.status).toBe(200);
        expect(response.headers.get('etag')).toContain(':authenticated:');
        expect(ServerInfoSchema.parse(await response.json()).caller).not.toBeNull();
    });
    it('returns retryable problem+json when the persisted id is unavailable', async () => {
        getServerId.mockResolvedValueOnce(null);
        const response = await def.handlers.GET!(event(), { surface: 'v1' });
        expect(response.status).toBe(503);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(response.headers.get('retry-after')).toBe('5');
        expect(await response.json()).toMatchObject({ code: 'server_id_unavailable' });
    });
    it('returns the auth boundary 429 before invoking discovery', async () => {
        const { resolveOptionalServerCredential } =
            await import('$lib/server/middleware/server-bootstrap-auth.js');
        rateLimit.mockResolvedValueOnce({ allowed: false, resetAt: Date.now() / 1000 + 60 });
        getServerId.mockClear();
        const request = event();
        const response =
            (await resolveOptionalServerCredential(request, { bearer: vi.fn() })) ??
            (await def.handlers.GET!(request, { surface: 'v1' }));
        expect(response.status).toBe(429);
        expect(getServerId).not.toHaveBeenCalled();
    });
});

it.each([false, true])(
    'advertises Live TV to apps only when the caller is allowed (%s)',
    async (allowed) => {
        const principal = buildPrincipal({
            kind: 'session',
            userId: toUserId('22222222-2222-4222-8222-222222222222'),
            username: 'viewer',
            userGroups: [],
        });
        const request = event(principal);
        request.locals.user = {
            ...request.locals.user,
            hasLiveTvPermission: allowed,
        } as App.Locals['user'];
        const body = await buildServerInfo(request, 'v1');
        expect(body).toMatchObject({ capabilities: { liveTv: { available: allowed } } });
        expect(body.caller?.permissions.canWatchLiveTv).toBe(allowed);
    },
);
