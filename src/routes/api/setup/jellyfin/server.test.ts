// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    fetch: vi.fn(),
    save: vi.fn(),
    sql: vi.fn(),
    status: vi.fn(),
    hasItems: vi.fn(),
    startRun: vi.fn(),
    enabled: true,
}));
vi.mock('$lib/server/config.js', () => ({
    features: {
        get jellyfinSync() {
            return h.enabled;
        },
    },
}));
vi.mock('$lib/server/services/database.service.js', () => ({ aiDbService: { getSql: h.sql } }));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({
    getSetupJellyfinStatus: h.status,
    hasSetupJellyfinItems: h.hasItems,
}));
vi.mock('$lib/server/services/jellyfin-setup-sync.service.js', () => ({
    requestJellyfinSetupInventory: async (_sql: unknown, source: string) => {
        try {
            await h.startRun(
                'jellyfin-file-inventory',
                { kickPull: true },
                {
                    trigger: { kind: 'in-process', sourceRoute: source },
                    idempotencyKey: `jellyfin-setup-inventory-${Math.floor(Date.now() / 600_000)}`,
                },
            );
            return true;
        } catch {
            return false;
        }
    },
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { startRun: h.startRun } }));
vi.mock('$lib/server/middleware/auth.js', () => ({ requireAdmin: (fn: unknown) => fn }));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: unknown) => fn,
}));
vi.mock('$lib/server/config/config.service.js', () => ({ saveConfig: h.save }));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({ fetchWithTimeout: h.fetch }));

import { GET, POST } from './+server';

function connect(apiKey = 'new-key'): Promise<Response> | Response {
    return POST({
        request: new Request('http://lumastra.test/api/setup/jellyfin', {
            method: 'POST',
            body: JSON.stringify({ url: 'http://jellyfin.test:8096/', apiKey }),
        }),
        locals: { user: { username: 'admin' } },
    } as Parameters<typeof POST>[0]);
}

beforeEach(() => {
    h.fetch.mockReset();
    h.save.mockReset();
    h.sql.mockResolvedValue({});
    h.startRun.mockReset().mockResolvedValue({ runId: 'inventory', deduped: false });
    h.enabled = true;
    h.hasItems.mockReset().mockResolvedValue(true);
    h.status.mockReset().mockResolvedValue({ paired: 7, waiting: 3, syncing: true, failed: false });
});

describe('setup Jellyfin connection', () => {
    it('starts inventory after saving when an earlier library scan already produced items', async () => {
        h.fetch.mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json([]));
        h.status.mockResolvedValue({ paired: 0, waiting: 5, syncing: false, failed: false });
        expect((await connect()).status).toBe(200);
        expect(h.startRun).toHaveBeenCalledWith(
            'jellyfin-file-inventory',
            { kickPull: true },
            {
                trigger: { kind: 'in-process', sourceRoute: '/api/setup/jellyfin' },
                idempotencyKey: expect.stringMatching(/^jellyfin-setup-inventory-\d+$/),
            },
        );
        expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(
            h.startRun.mock.invocationCallOrder[0],
        );
    });

    it('does not enqueue on an empty fresh install', async () => {
        h.hasItems.mockResolvedValue(false);
        h.status.mockResolvedValue({ paired: 0, waiting: 0, syncing: false, failed: false });
        h.fetch.mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json([]));
        await connect();
        expect(h.startRun).not.toHaveBeenCalled();
    });

    it('does not enqueue when watch sync is disabled', async () => {
        h.enabled = false;
        h.fetch.mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json([]));
        await connect();
        expect(h.startRun).not.toHaveBeenCalled();
    });

    it('preserves the saved connection and username warning when sync could not start', async () => {
        h.fetch
            .mockResolvedValueOnce(Response.json({}))
            .mockResolvedValueOnce(Response.json([{ Name: 'someone-else' }]));
        h.status.mockResolvedValue({ paired: 0, waiting: 5, syncing: false, failed: false });
        h.startRun.mockRejectedValue(new Error('new-key http://user:password@jellyfin.test'));
        const response = await connect();
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result).toMatchObject({
            connected: true,
            syncStarted: false,
            adminMatched: false,
            adminUsername: 'admin',
        });
        expect(result.warning).toMatch(/saved.*save.*again/i);
        expect(JSON.stringify(result)).not.toMatch(/new-key|password|user:/);
    });
    it('authenticates both the system probe and user enumeration using the entered key', async () => {
        h.fetch.mockResolvedValueOnce(Response.json({ ServerName: 'test', Version: '12.4.0' }));
        h.fetch.mockResolvedValueOnce(Response.json([{ Name: 'admin' }]));
        expect(await (await connect()).json()).toMatchObject({
            connected: true,
            version: '12.4.0',
            adminMatched: true,
        });
        expect(h.fetch.mock.calls.map((c) => c[0])).toEqual([
            'http://jellyfin.test:8096/System/Info',
            'http://jellyfin.test:8096/Users',
        ]);
        for (const [, init] of h.fetch.mock.calls) {
            expect(init.headers).toEqual({
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="new-key"$/,
                ),
            });
        }
        expect(h.save).toHaveBeenCalledWith({
            JELLYFINURL: 'http://jellyfin.test:8096',
            JELLYFINAPIKEY: 'new-key',
        });
    });

    it('explains 401 and never persists rejected credentials', async () => {
        h.fetch.mockResolvedValue(new Response(null, { status: 401 }));
        const result = await (await connect()).json();
        expect(result.connected).toBe(false);
        expect(result.error).toMatch(
            /401.*API key.*Jellyfin Dashboard > API Keys.*reverse proxy.*Authorization/,
        );
        expect(result.error).not.toContain('new-key');
        expect(h.save).not.toHaveBeenCalled();
    });

    it('returns connected:false when the auth helper throws Invalid Jellyfin token', async () => {
        const response = await connect('malformed"key');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            connected: false,
            error: 'The API key contains characters that are not allowed. Copy it again from Jellyfin (Dashboard > API Keys).',
        });
        expect(h.fetch).not.toHaveBeenCalled();
        expect(h.save).not.toHaveBeenCalled();
    });

    it('says where it tried to connect and why, without the API key', async () => {
        h.fetch.mockRejectedValueOnce(
            new TypeError('fetch failed', {
                cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
            }),
        );
        const result = await (await connect('new-key')).json();
        expect(result).toEqual({
            connected: false,
            error: 'Could not reach Jellyfin at http://jellyfin.test:8096 (connection refused). Check the address and that Jellyfin is running.',
        });
        expect(JSON.stringify(result)).not.toContain('new-key');
        expect(h.save).not.toHaveBeenCalled();
    });

    it('retains the upstream status for non-authentication failures', async () => {
        h.fetch.mockResolvedValue(new Response(null, { status: 503 }));
        expect(await (await connect()).json()).toMatchObject({
            connected: false,
            error: 'Jellyfin returned HTTP 503',
        });
        expect(h.save).not.toHaveBeenCalled();
    });
});

describe('setup Jellyfin status', () => {
    it('caches concurrent and repeated polls for a few seconds', async () => {
        const time = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(time);
        try {
            await Promise.all([GET({} as never), GET({} as never), GET({} as never)]);
            await GET({} as never);
            expect(h.status).toHaveBeenCalledTimes(1);
            clock.mockReturnValue(time + 6000);
            h.status.mockResolvedValue({ paired: 8, waiting: 2, syncing: false, failed: false });
            expect(await (await GET({} as never)).json()).toMatchObject({ paired: 8, waiting: 2 });
            expect(h.status).toHaveBeenCalledTimes(2);
        } finally {
            clock.mockRestore();
        }
    });
    it('returns local pairing counts and task activity without making a Jellyfin request', async () => {
        const response = await GET({} as never);
        expect(await response.json()).toEqual({
            configured: true,
            paired: 7,
            waiting: 3,
            syncing: true,
            failed: false,
        });
        expect(h.fetch).not.toHaveBeenCalled();
        expect(h.startRun).not.toHaveBeenCalled();
    });

    it('does not query status when Jellyfin sync is not configured', async () => {
        h.enabled = false;
        expect(await (await GET({} as never)).json()).toEqual({ configured: false });
        expect(h.status).not.toHaveBeenCalled();
    });

    it('does not expose internal errors or credentials when status is unavailable', async () => {
        h.status.mockRejectedValue(new Error('new-key http://user:password@jellyfin.test'));
        const response = await GET({} as never);
        expect(response.status).toBe(503);
        const text = await response.text();
        expect(text).toMatch(/status unavailable/i);
        expect(text).not.toMatch(/new-key|password|user:/);
    });
});
