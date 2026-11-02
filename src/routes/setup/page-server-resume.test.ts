// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /setup load for a RESUMED wizard (admin signed in, no library yet — a reload,
 * or the return from an OIDC sign-in). Step 3 must be hydrated from what an
 * earlier pass saved, or Save/Skip re-sends the defaults over those choices.
 * The client side (seeding + request bodies) is in setup-page.svelte.test.ts.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { envLocked } = vi.hoisted(() => ({ envLocked: new Set<string>() }));

vi.mock('$app/paths', () => ({ base: '/media' }));

vi.mock('./setup-environment.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./setup-environment.js')>()),
    buildSetupEnvironment: vi.fn(),
    buildSetupEnvironmentDetails: vi.fn(),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: async () => true,
    adminExistsIgnoringSetupLock: async () => true,
}));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getAllLibraryPaths: async () => [],
}));
vi.mock('$lib/server/database/queries/plugin-secrets.queries.js', () => ({
    listPluginSecretKeys: async () => [],
}));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({
    getEmbeddingDimension: async () => 1024,
}));
vi.mock('$lib/server/config/config.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config/config.service.js')>()),
    isEnvOverridden: (key: string) => envLocked.has(key),
}));

import { config } from '$lib/server/config.js';
import * as masterKey from '$lib/server/crypto/master-key.js';
import { load } from './+page.server.js';
import { buildSetupEnvironment, buildSetupEnvironmentDetails } from './setup-environment.js';

function resumedAdminEvent(
    opts: { peer?: string; headers?: Record<string, string>; isDataRequest?: boolean } = {},
): never {
    const url = new URL('http://localhost/setup');
    return {
        request: new Request(url, { headers: opts.headers }),
        url,
        locals: { user: { username: 'owner', ownerIsAdmin: true }, principal: { isAdmin: true } },
        getClientAddress: () => opts.peer ?? '10.9.8.7',
        depends: () => undefined,
        isDataRequest: opts.isDataRequest ?? false,
    } as never;
}

const build = vi.mocked(buildSetupEnvironment);
const buildDetails = vi.mocked(buildSetupEnvironmentDetails);
const ENVIRONMENT = { marker: 'environment' } as never;

beforeEach(() => {
    build.mockReset().mockResolvedValue(ENVIRONMENT);
    buildDetails.mockReset().mockResolvedValue({ ffmpeg: null });
});

afterEach(() => {
    vi.restoreAllMocks();
    envLocked.clear();
});

/**
 * The install overview's inputs come from the load, not the builder: the
 * trusted-context gate (node placement, paths, URLs) and the proxy/HTTPS view.
 * These pin what the load hands over, which the builder's own tests take as given.
 */
describe('/setup load — install overview inputs', () => {
    it('a remote visitor without forwarding headers: untrusted, direct, http', async () => {
        const data = (await load(resumedAdminEvent())) as Record<string, unknown>;

        expect(build).toHaveBeenCalledWith(
            expect.objectContaining({ trustedContext: false, proxy: 'direct', https: false }),
        );
        expect(buildDetails).toHaveBeenCalled();
        expect(data.environment).toBe(ENVIRONMENT);
    });

    it('a loopback visitor is the operator on this machine: trusted', async () => {
        await load(resumedAdminEvent({ peer: '127.0.0.1' }));

        expect(build).toHaveBeenCalledWith(expect.objectContaining({ trustedContext: true }));
    });

    it('loopback WITH forwarding headers is a proxy on this host, not the operator', async () => {
        await load(
            resumedAdminEvent({
                peer: '127.0.0.1',
                headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
            }),
        );

        expect(build).toHaveBeenCalledWith(
            expect.objectContaining({ trustedContext: false, https: true }),
        );
        expect(build.mock.calls[0][0].proxy).not.toBe('direct');
    });

    it('Recheck (a data request) asks for fresh probes; a page load does not', async () => {
        await load(resumedAdminEvent());
        expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ fresh: false }));
        await load(resumedAdminEvent({ isDataRequest: true }));
        expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ fresh: true }));
    });

    it('a failing overview hides the panel instead of breaking the wizard', async () => {
        build.mockRejectedValue(new Error('valkey exploded'));

        const data = (await load(resumedAdminEvent())) as Record<string, unknown>;

        expect(data.environment).toBeNull();
        expect(data.resume).toBe(true);
    });
});

describe('/setup load — resumed wizard', () => {
    it.each(['', 'https://public.example/custom/callback'])(
        'shows the same subpath-aware callback used by login (override: %s)',
        async (override) => {
            vi.spyOn(config, 'AUTH_OIDC_REDIRECT_URI', 'get').mockReturnValue(override);
            const data = (await load(resumedAdminEvent())) as Record<string, unknown>;
            expect(data.oidcCallbackUrl).toBe(
                override || 'http://localhost/media/auth/oidc/callback',
            );
        },
    );
    it('returns the saved step-3 values, use cases and env-locked fields', async () => {
        vi.spyOn(config, 'INSTANCE_USE_CASES', 'get').mockReturnValue(['music']);
        vi.spyOn(config, 'SOCIAL_DEFAULT_AUDIENCE', 'get').mockReturnValue('groups');
        vi.spyOn(config, 'METADATA_STORAGE_LOCATION', 'get').mockReturnValue('alongside');
        vi.spyOn(config, 'TRICKPLAY_ENABLED', 'get').mockReturnValue(true);
        vi.spyOn(config, 'GPU_ACCELERATION', 'get').mockReturnValue('vaapi');
        vi.spyOn(config, 'LICENSE_CHECK_IN_ENABLED', 'get').mockReturnValue(false);
        envLocked.add('TRICKPLAY_ENABLED');

        const data = (await load(resumedAdminEvent())) as Record<string, unknown>;

        expect(data.resume).toBe(true);
        expect(data.preferences).toMatchObject({
            useCases: ['music'],
            envLocked: ['trickplayEnabled'],
            values: {
                shareActivityBetweenUsers: false,
                metadataStorageLocation: 'alongside',
                trickplayEnabled: true,
                gpuAcceleration: 'vaapi',
                // Read through the real getter: a renamed getter would read
                // undefined, and `!== false` would show a saved OFF as ON.
                licenseCheckIn: false,
            },
        });
    });
});

describe('/setup load — backup key provenance', () => {
    it.each(['env', 'file', 'generated', 'none'] as const)(
        'passes the resolved %s source, even when process.env contains a key',
        async (source) => {
            // File resolution back-fills this variable too: it is not provenance.
            vi.stubEnv('LUMASTRA_MASTER_KEY', 'test-only-key-material');
            const resolve = vi
                .spyOn(masterKey, 'resolveMasterKey')
                .mockReturnValue('test-only-key-material');
            const provenance = vi.spyOn(masterKey, 'getMasterKeySource').mockReturnValue(source);
            try {
                const data = (await load(resumedAdminEvent())) as Record<string, unknown>;

                expect(data.masterKeySource).toBe(source);
                expect(resolve).toHaveBeenCalled();
                expect(provenance).toHaveBeenCalled();
                expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(
                    provenance.mock.invocationCallOrder[0],
                );
                expect(data.configDir).toBeNull();
                expect(JSON.stringify(data)).not.toContain('test-only-key-material');
            } finally {
                vi.unstubAllEnvs();
            }
        },
    );
});

describe('/setup load — environment-owned metadata language', () => {
    it('keeps the effective default-valued language instead of suggesting the UI locale', async () => {
        envLocked.add('TMDB_LANGUAGE');
        vi.spyOn(config, 'TMDB_LANGUAGE', 'get').mockReturnValue('en-US');
        const data = (await load(resumedAdminEvent())) as { metadataLanguage: unknown };
        expect(data.metadataLanguage).toMatchObject({
            tmdbLanguage: 'en-US',
            tmdbLanguageLocked: true,
        });
    });
});
