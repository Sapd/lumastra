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
        buildInfo: { version: 'v0.1.0', buildTime: '', commit: '', commitShort: '', branch: '' },
    },
    pinnedFetch: vi.fn<() => Promise<Response>>(),
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

vi.mock('$lib/server/utils/ssrf-guard.js', () => ({
    assertNotPrivateUrl: vi.fn(async () => undefined),
    resolveSafePublicUrl: vi.fn(async (url: URL) => ({ url, resolvedIp: '140.82.121.6' })),
    pinnedFetch: () => pinnedFetch(),
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
});
