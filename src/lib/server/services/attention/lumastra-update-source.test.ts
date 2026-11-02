// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `lumastra-update:` source end to end from the stored plugin_settings
 * rows: opt-out, the running build, and the failing streak all have to reach
 * the adapter. The adapter's own test hands it its arguments directly, so a
 * dropped argument here would go unnoticed there.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cfg } = vi.hoisted(() => ({
    cfg: {
        UPDATE_CHECK_ENABLED: true,
        buildInfo: { version: 'v0.1.0', buildTime: '', commit: '', commitShort: '', branch: '' },
    },
}));
vi.mock('$lib/server/config.js', async (orig) => {
    const real = await orig<typeof import('$lib/server/config.js')>();
    return {
        ...real,
        config: new Proxy(real.config, {
            get: (t, k) => (k in cfg ? cfg[k as keyof typeof cfg] : Reflect.get(t, k)),
        }),
    };
});

let stored: Record<string, unknown> = {};
vi.mock('$lib/server/database/queries/task-settings.queries.js', () => ({
    getTaskSettings: vi.fn(async () => ({ ...stored })),
    upsertTaskSettings: vi.fn(),
    addToTaskSettingList: vi.fn(),
    removeFromTaskSettingList: vi.fn(),
}));

import { deriveLumastraUpdateAlerts } from './attention-service.js';
import { LUMASTRA_SECURITY_UPDATE_ATTENTION_ID } from '$lib/shared/attention-persistent.js';

const NOW = Date.parse('2026-11-10T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 24 * 3600_000).toISOString();
const sql = {} as never;

function seed(over: Record<string, unknown> = {}, reviewed?: string[]): void {
    stored = {
        state: {
            checkedAt: daysAgo(5),
            releases: [
                {
                    version: '0.1.1',
                    url: 'https://github.com/Sapd/lumastra/releases/tag/v0.1.1',
                    publishedAt: daysAgo(6),
                    security: true,
                    prerelease: false,
                },
            ],
            ...over,
        },
        ...(reviewed ? { 'reviewed-security': reviewed } : {}),
    };
}

beforeEach(() => {
    cfg.UPDATE_CHECK_ENABLED = true;
    cfg.buildInfo.version = 'v0.1.0';
    stored = {};
});

describe('deriveLumastraUpdateAlerts', () => {
    it('reads the stored list against the running build', async () => {
        seed();
        const ids = (await deriveLumastraUpdateAlerts(sql, NOW)).map((a) => a.id);
        expect(ids).toEqual([LUMASTRA_SECURITY_UPDATE_ATTENTION_ID]);
        cfg.buildInfo.version = 'v0.1.1';
        expect(await deriveLumastraUpdateAlerts(sql, NOW)).toEqual([]);
    });

    it('passes the failing streak through', async () => {
        seed({ failingSince: daysAgo(4), lastAttemptAt: daysAgo(0.2) });
        const ids = (await deriveLumastraUpdateAlerts(sql, NOW)).map((a) => a.id);
        expect(ids).toContain('lumastra-update:check-failing');
    });

    it('honours a review stored under its own key', async () => {
        seed({}, ['0.1.1']);
        const alerts = await deriveLumastraUpdateAlerts(sql, NOW);
        expect(alerts.map((a) => [a.id, a.severity])).toEqual([
            ['lumastra-update:release', 'info'],
        ]);
    });

    it('shows nothing when the admin turned the check off', async () => {
        seed({ failingSince: daysAgo(4), lastAttemptAt: daysAgo(0.2) });
        cfg.UPDATE_CHECK_ENABLED = false;
        expect(await deriveLumastraUpdateAlerts(sql, NOW)).toEqual([]);
    });
});
