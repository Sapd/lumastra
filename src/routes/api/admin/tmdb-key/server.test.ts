// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const { fetch, saveConfig, isEnvOverridden } = vi.hoisted(() => ({
    fetch: vi.fn(),
    saveConfig: vi.fn(),
    isEnvOverridden: vi.fn(() => false),
}));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({ fetchWithTimeout: fetch }));
vi.mock('$lib/server/config/config.service.js', () => ({ saveConfig, isEnvOverridden }));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    auditActor: () => ({ username: 'admin' }),
}));
vi.mock('$lib/server/middleware/auth.js', () => ({ requireAdmin: (handler: unknown) => handler }));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));
import { POST } from './+server';
const localeState = vi.hoisted(() => ({ current: 'en' }));
vi.mock('$lib/paraglide/runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/paraglide/runtime')>()),
    getLocale: () => localeState.current,
}));

async function save(key = 'rejected'): Promise<Response> {
    const url = new URL('http://localhost/api/admin/tmdb-key');
    return POST!({
        request: new Request(url, { method: 'POST', body: JSON.stringify({ key }) }),
        url,
        params: {},
        locals: {
            principal: {
                userId: 'u1',
                username: 'admin',
                userGroups: [],
                isAdmin: true,
                scopes: ['admin'],
            },
        },
    } as never);
}

describe('TMDB key save', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isEnvOverridden.mockReturnValue(false);
        localeState.current = 'en';
    });
    it.each(['en', 'de'] as const)(
        'blocks an invalid key before persistence in %s',
        async (locale) => {
            localeState.current = locale;
            fetch.mockResolvedValue(new Response(null, { status: 401 }));
            const response = await save();
            expect(response.status).toBe(422);
            const body = await response.json();
            expect(body.error).toMatch(locale === 'de' ? /TMDB.*abgelehnt/ : /TMDB.*rejected/);
            expect(saveConfig).not.toHaveBeenCalled();
        },
    );
    it('saves a verified v3 key', async () => {
        fetch.mockResolvedValue(new Response(null, { status: 200 }));
        const response = await save('valid-key');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ saved: true });
        expect(fetch.mock.calls[0][0]).toBe(
            'https://api.themoviedb.org/3/configuration?api_key=valid-key',
        );
        expect(saveConfig).toHaveBeenCalledWith({ TMDB_API_KEY: 'valid-key' });
    });
    it.each(['network', 'rate limit', 'server error'])(
        'saves with a retry warning for %s',
        async (kind) => {
            if (kind === 'network') fetch.mockRejectedValue(new TypeError('secret-key'));
            else
                fetch.mockResolvedValue(
                    new Response(null, { status: kind === 'rate limit' ? 429 : 503 }),
                );
            const response = await save('secret-key');
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                saved: true,
                warning: expect.stringMatching(/could not be verified.*retry automatically/),
            });
            expect(saveConfig).toHaveBeenCalledWith({ TMDB_API_KEY: 'secret-key' });
        },
    );
    it('keeps the environment lock without probing or saving the ignored key', async () => {
        isEnvOverridden.mockReturnValue(true);
        expect((await save()).status).toBe(409);
        expect(fetch).not.toHaveBeenCalled();
        expect(saveConfig).not.toHaveBeenCalled();
    });
});
