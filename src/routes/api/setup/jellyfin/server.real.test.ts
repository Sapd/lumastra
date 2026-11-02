// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Opt-in transport check against an isolated, bootstrapped Jellyfin fixture. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';

const h = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('$lib/server/middleware/auth.js', () => ({ requireAdmin: (fn: unknown) => fn }));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: unknown) => fn,
}));
vi.mock('$lib/server/config/config.service.js', () => ({ saveConfig: h.save }));
import { POST } from './+server';

const fixtureFile = process.env.JF12_FIXTURE_FILE;
describe('real Jellyfin 12.4', () => {
    it.skipIf(!fixtureFile)(
        'connects through the fixed setup handler with a fresh API key',
        async () => {
            const fixture = JSON.parse(readFileSync(fixtureFile!, 'utf8')) as {
                url: string;
                apiKey: string;
                userToken: string;
                username: string;
            };
            const comparisons: Array<Record<string, unknown>> = [];
            for (const [credential, token] of [
                ['API key', fixture.apiKey],
                ['user token', fixture.userToken],
            ]) {
                for (const modern of [false, true]) {
                    const headers = modern
                        ? buildJellyfinAuthHeaders({ token })
                        : { 'X-Emby-Token': token };
                    const res = await fetchWithTimeout(
                        `${fixture.url}/System/Info`,
                        { headers },
                        10000,
                    );
                    const body: unknown = await res.json().catch(() => null);
                    comparisons.push({
                        credential,
                        header: modern
                            ? 'Authorization: MediaBrowser (shared helper)'
                            : 'X-Emby-Token (before)',
                        status: res.status,
                        body: modern ? body : null,
                    });
                    expect(res.status).toBe(modern ? 200 : 401);
                }
            }
            const response = await POST({
                request: new Request('http://lumastra.test/api/setup/jellyfin', {
                    method: 'POST',
                    body: JSON.stringify({ url: fixture.url, apiKey: fixture.apiKey }),
                }),
                locals: { user: { username: fixture.username } },
            } as Parameters<typeof POST>[0]);
            const result = (await response.json()) as Record<string, unknown>;
            const evidence = {
                time: new Date().toISOString(),
                comparisons,
                setup: { status: response.status, body: result },
                header: buildJellyfinAuthHeaders({ token: '<redacted>' }).Authorization,
                saveConfigCalled: h.save.mock.calls.length,
            };
            if (process.env.JF12_EVIDENCE_FILE) {
                mkdirSync(dirname(process.env.JF12_EVIDENCE_FILE), { recursive: true });
                writeFileSync(process.env.JF12_EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
            }
            expect(result).toMatchObject({
                connected: true,
                version: '12.4.0',
                adminMatched: true,
            });
            expect(h.save).toHaveBeenCalledExactlyOnceWith({
                JELLYFINURL: fixture.url,
                JELLYFINAPIKEY: fixture.apiKey,
            });
        },
    );
});
