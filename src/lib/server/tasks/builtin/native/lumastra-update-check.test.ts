// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The task wrapper: the admin switch stops every request, a manual run checks
 * at once, and a remote failure never fails the run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cfg, pinnedFetch } = vi.hoisted(() => ({
    cfg: {
        UPDATE_CHECK_ENABLED: true,
        LICENSE_SERVER_CONTACT_ENABLED: false,
        buildInfo: { version: 'v0.1.0', buildTime: '', commit: '', commitShort: '', branch: '' },
    },
    pinnedFetch: vi.fn<(safe: { url: URL }, init: RequestInit) => Promise<Response>>(),
}));
vi.mock('$lib/server/config.js', () => ({ config: cfg }));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));

let stored: Record<string, unknown> = {};
vi.mock('$lib/server/database/queries/task-settings.queries.js', () => ({
    getTaskSettings: vi.fn(async () => ({ ...stored })),
    upsertTaskSettings: vi.fn(async (_sql: unknown, _id: string, s: Record<string, unknown>) => {
        stored = { ...stored, ...s };
    }),
}));

vi.mock('$lib/server/services/lumastra-update/claim.queries.js', () => ({
    claimUpdateCheck: vi.fn(async () => true),
}));

vi.mock('$lib/server/utils/ssrf-guard.js', () => ({
    assertNotPrivateUrl: vi.fn(async () => undefined),
    resolveSafePublicUrl: vi.fn(async (url: URL) => ({ url, resolvedIp: '140.82.121.6' })),
    pinnedFetch: (safe: { url: URL }, init: RequestInit) => pinnedFetch(safe, init),
}));

vi.mock('../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));

import { lumastraUpdateCheckTask } from './lumastra-update-check.js';

function ctx(mode: string = 'manual') {
    return {
        mode,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: new AbortController().signal,
    } as never;
}

beforeEach(() => {
    stored = {};
    cfg.UPDATE_CHECK_ENABLED = true;
    cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
    pinnedFetch.mockReset();
});

describe('lumastra-update-check task', () => {
    it('makes no request when the admin turned it off', async () => {
        cfg.UPDATE_CHECK_ENABLED = false;
        const out = await lumastraUpdateCheckTask.execute(ctx());
        expect(out.success).toBe(true);
        expect(out.result?.status).toBe('disabled');
        expect(pinnedFetch).not.toHaveBeenCalled();
    });

    it('a manual run checks and reports the newer version', async () => {
        pinnedFetch.mockResolvedValue(
            new Response(
                JSON.stringify([
                    {
                        tag_name: 'v0.1.1',
                        html_url: 'https://github.com/Sapd/lumastra/releases/tag/v0.1.1',
                        published_at: '2026-10-20T00:00:00Z',
                        body: 'Security: yes',
                    },
                ]),
                { status: 200 },
            ),
        );
        const out = await lumastraUpdateCheckTask.execute(ctx());
        expect(pinnedFetch).toHaveBeenCalledTimes(1);
        expect(out.result).toMatchObject({
            status: 'checked',
            latestVersion: '0.1.1',
            securityFixedIn: '0.1.1',
        });
    });

    it('a network failure is a successful run with a message', async () => {
        pinnedFetch.mockRejectedValue(new TypeError('fetch failed'));
        const out = await lumastraUpdateCheckTask.execute(ctx());
        expect(out.success).toBe(true);
        expect(out.result?.status).toBe('failed');
        expect(out.result?.message).toContain('fetch failed');
    });

    describe('anonymous check through lumastra.org', () => {
        const ORG = {
            releases: [
                {
                    version: '0.1.1',
                    url: 'https://github.com/Sapd/lumastra/releases/tag/v0.1.1',
                    publishedAt: '2026-10-20T00:00:00Z',
                    security: true,
                    prerelease: false,
                },
            ],
            complete: true,
        };
        const GITHUB = [
            {
                tag_name: 'v0.1.1',
                html_url: 'https://github.com/Sapd/lumastra/releases/tag/v0.1.1',
                published_at: '2026-10-20T00:00:00Z',
                body: 'Security: yes',
            },
        ];

        beforeEach(() => {
            pinnedFetch.mockReset();
            // The mocked transport receives (safe, init); record host + URL.
            pinnedFetch.mockImplementation((async (safe: { url: URL }) => {
                calls.push(safe.url.href);
                if (safe.url.hostname === 'lumastra.org') {
                    return orgAnswer();
                }
                return new Response(JSON.stringify(GITHUB), { status: 200 });
            }) as never);
            calls.length = 0;
            orgAnswer = () => new Response(JSON.stringify(ORG), { status: 200 });
        });
        const calls: string[] = [];
        let orgAnswer: () => Response = () => new Response('', { status: 500 });

        it('contact on: one request to lumastra.org with the version, and the security flag arrives', async () => {
            cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
            const out = await lumastraUpdateCheckTask.execute(ctx());
            expect(calls).toEqual(['https://lumastra.org/api/update-check?v=v0.1.0']);
            expect(out.result).toMatchObject({
                status: 'checked',
                latestVersion: '0.1.1',
                securityFixedIn: '0.1.1',
            });
        });

        it('contact off (the stored opt-out): GitHub as before, lumastra.org never contacted', async () => {
            cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
            const out = await lumastraUpdateCheckTask.execute(ctx());
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatch(
                /^https:\/\/api\.github\.com\/repos\/Sapd\/lumastra\/releases/,
            );
            expect(calls.join(' ')).not.toContain('lumastra.org');
            expect(out.result?.securityFixedIn).toBe('0.1.1');
        });

        it('contact on, lumastra.org down: falls back to GitHub in the same run', async () => {
            cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
            orgAnswer = () => new Response('down', { status: 503 });
            const out = await lumastraUpdateCheckTask.execute(ctx());
            expect(calls.map((u) => new URL(u).hostname)).toEqual([
                'lumastra.org',
                'api.github.com',
            ]);
            expect(out.result).toMatchObject({ status: 'checked', securityFixedIn: '0.1.1' });
        });

        it('both down: one try each, no retry storm, a failed result without throwing', async () => {
            cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
            pinnedFetch.mockImplementation((async (safe: { url: URL }) => {
                calls.push(safe.url.href);
                throw new TypeError('fetch failed');
            }) as never);
            const out = await lumastraUpdateCheckTask.execute(ctx());
            expect(calls).toHaveLength(2);
            expect(out.success).toBe(true);
            expect(out.result?.status).toBe('failed');
        });

        it('UPDATE_CHECK_ENABLED off beats contact on: nothing is sent anywhere', async () => {
            cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
            cfg.UPDATE_CHECK_ENABLED = false;
            await lumastraUpdateCheckTask.execute(ctx());
            expect(calls).toEqual([]);
        });
    });
});
