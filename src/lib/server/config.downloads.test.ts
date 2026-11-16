// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Download permission and limit settings. These are admin UI settings
 * (section 'downloads'), read through getters on `config` at use time. They
 * are not in .env.example.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configSchema } from '$lib/config/schema.js';

const DOWNLOAD_KEYS = [
    'DOWNLOADS_ALLOWED_BY_DEFAULT',
    'DOWNLOAD_USER_BANDWIDTH_KBPS',
    'DOWNLOAD_TOTAL_BANDWIDTH_KBPS',
    'DOWNLOAD_MAX_PARALLEL_PER_USER',
    'DOWNLOAD_LOG_RETENTION_DAYS',
    'DOWNLOAD_GROUPS',
    'DOWNLOAD_ALLOWED_MOUNT_ROOTS',
    'DOWNLOAD_MIN_SPEED_KBPS',
] as const;

type DownloadConfig = {
    DOWNLOADS_ALLOWED_BY_DEFAULT: boolean;
    DOWNLOAD_USER_BANDWIDTH_KBPS: number;
    DOWNLOAD_TOTAL_BANDWIDTH_KBPS: number;
    DOWNLOAD_MAX_PARALLEL_PER_USER: number;
    DOWNLOAD_LOG_RETENTION_DAYS: number;
    DOWNLOAD_GROUPS: string[];
    DOWNLOAD_ALLOWED_MOUNT_ROOTS: string[];
    DOWNLOAD_MIN_SPEED_KBPS: number;
};

/**
 * Load a fresh config module with the given env overrides. config.ts snapshots
 * process.env at import time, so the variables must be set before the import.
 */
async function loadConfig(env: Partial<Record<(typeof DOWNLOAD_KEYS)[number], string>> = {}) {
    for (const key of DOWNLOAD_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    vi.resetModules();
    const mod = (await import('./config.js')) as unknown as { config: DownloadConfig };
    return mod.config;
}

beforeEach(() => {
    vi.resetModules();
});

describe('download settings: defaults', () => {
    it('uses the documented defaults when no env is set', async () => {
        const config = await loadConfig();
        expect(config.DOWNLOADS_ALLOWED_BY_DEFAULT).toBe(true);
        expect(config.DOWNLOAD_USER_BANDWIDTH_KBPS).toBe(0);
        expect(config.DOWNLOAD_TOTAL_BANDWIDTH_KBPS).toBe(0);
        expect(config.DOWNLOAD_MAX_PARALLEL_PER_USER).toBe(3);
        expect(config.DOWNLOAD_LOG_RETENTION_DAYS).toBe(90);
        expect(config.DOWNLOAD_GROUPS).toEqual([]);
        expect(config.DOWNLOAD_MIN_SPEED_KBPS).toBe(1);
    });
});

describe('DOWNLOAD_GROUPS', () => {
    it('parses a comma list', async () => {
        const config = await loadConfig({ DOWNLOAD_GROUPS: 'family, admin' });
        expect(config.DOWNLOAD_GROUPS).toEqual(['family', 'admin']);
    });

    it('treats an explicitly empty value as not used', async () => {
        const config = await loadConfig({ DOWNLOAD_GROUPS: '' });
        expect(config.DOWNLOAD_GROUPS).toEqual([]);
    });

    it('is a groups-section array setting with an empty default', () => {
        const def = configSchema.find((d) => d.key === 'DOWNLOAD_GROUPS');
        expect(def).toMatchObject({ type: 'array', defaultValue: '', section: 'groups' });
    });
});

describe('DOWNLOAD_ALLOWED_MOUNT_ROOTS', () => {
    it('defaults to no extra folders', async () => {
        expect((await loadConfig()).DOWNLOAD_ALLOWED_MOUNT_ROOTS).toEqual([]);
    });

    it('parses a comma list and drops empty or whitespace entries', async () => {
        const config = await loadConfig({
            DOWNLOAD_ALLOWED_MOUNT_ROOTS: '/mnt/debrid, ,/mnt/rclone/,',
        });
        expect(config.DOWNLOAD_ALLOWED_MOUNT_ROOTS).toEqual(['/mnt/debrid', '/mnt/rclone/']);
    });

    it('is a downloads-section array setting with the agreed label and description', () => {
        const def = configSchema.find((d) => d.key === 'DOWNLOAD_ALLOWED_MOUNT_ROOTS');
        expect(def).toMatchObject({
            type: 'array',
            defaultValue: '',
            section: 'downloads',
            label: 'Extra download folders (debrid/rclone mounts)',
        });
        expect(def?.description).toContain(
            'Downloads only follow symlinks into the library folders.',
        );
        expect(def?.requiresRestart).not.toBe(true);
    });
});

describe('DOWNLOAD_MIN_SPEED_KBPS', () => {
    it('reads an env override, 0 included (off)', async () => {
        expect((await loadConfig({ DOWNLOAD_MIN_SPEED_KBPS: '5' })).DOWNLOAD_MIN_SPEED_KBPS).toBe(
            5,
        );
        expect((await loadConfig({ DOWNLOAD_MIN_SPEED_KBPS: '0' })).DOWNLOAD_MIN_SPEED_KBPS).toBe(
            0,
        );
    });

    it('is a downloads-section number setting with the agreed label, description and default 1', () => {
        const def = configSchema.find((d) => d.key === 'DOWNLOAD_MIN_SPEED_KBPS');
        expect(def).toMatchObject({
            type: 'number',
            defaultValue: 1,
            section: 'downloads',
            label: 'Minimum download speed (KB/s)',
        });
        expect(def?.description).toContain(
            'Downloads slower than this over 10 minutes are stopped',
        );
        expect(def?.description).toContain('0 turns this off.');
        expect(def?.requiresRestart).not.toBe(true);
    });
});

describe('download settings: env overrides', () => {
    it('passes an env value through the getter', async () => {
        const config = await loadConfig({ DOWNLOAD_MAX_PARALLEL_PER_USER: '5' });
        expect(config.DOWNLOAD_MAX_PARALLEL_PER_USER).toBe(5);
    });

    it('reads the boolean default switch from env', async () => {
        const config = await loadConfig({ DOWNLOADS_ALLOWED_BY_DEFAULT: 'false' });
        expect(config.DOWNLOADS_ALLOWED_BY_DEFAULT).toBe(false);
    });
});

describe('download settings: schema entries', () => {
    const schemaByKey = new Map(configSchema.map((s) => [s.key, s]));

    it.each([
        ['DOWNLOADS_ALLOWED_BY_DEFAULT', 'Allow downloads by default', 'boolean', true],
        [
            'DOWNLOAD_USER_BANDWIDTH_KBPS',
            'Download speed per user (KB/s, all downloads together)',
            'number',
            0,
        ],
        [
            'DOWNLOAD_TOTAL_BANDWIDTH_KBPS',
            'Total download speed (KB/s, all users together)',
            'number',
            0,
        ],
        ['DOWNLOAD_MAX_PARALLEL_PER_USER', 'Parallel downloads per user', 'number', 3],
        ['DOWNLOAD_LOG_RETENTION_DAYS', 'Download log retention (days)', 'number', 90],
    ] as const)(
        '%s is registered in the downloads section with its label',
        (key, label, type, defaultValue) => {
            const setting = schemaByKey.get(key);
            expect(setting).toBeDefined();
            expect(setting).toMatchObject({ label, type, defaultValue, section: 'downloads' });
            expect(setting?.requiresRestart).not.toBe(true);
        },
    );

    it('relabels the per-download throttle and says the lower limit applies', () => {
        const setting = schemaByKey.get('DOWNLOAD_THROTTLE_KBPS');
        expect(setting?.label).toBe('Download speed per download (KB/s)');
        expect(setting?.description).toContain('lower');
        expect(setting?.description).toContain('per-user');
    });
});
