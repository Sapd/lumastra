// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * settings.json that cannot be parsed (cut-off write, hand-edit typo) must
 * never cost the operator their saved settings:
 * - a save used to write ONLY its own keys over the unreadable file, wiping
 *   every other setting and sealed secret in it;
 * - a reload (admin "Reload from disk", or the cross-replica config-changed
 *   event) used to install bare schema defaults and report success.
 * And the file is now replaced by temp file + rename, so a crash mid-write no
 * longer leaves a cut-off file behind in the first place.
 *
 * Real filesystem in a throwaway directory (CONFIG_PATH).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('$env/dynamic/private', () => {
    throw new Error('not in SvelteKit');
});
vi.mock('$lib/server/crypto/master-key.js', () => ({
    resolveMasterKey: () => 'a'.repeat(64),
}));

const dir = mkdtempSync(join(tmpdir(), 'lumastra-config-unreadable-'));
const filePath = join(dir, 'settings.json');
const previousConfigPath = process.env.CONFIG_PATH;
process.env.CONFIG_PATH = filePath;

const { initConfigServiceSync, saveConfig, reloadConfig, getAll, ConfigFileUnreadableError } =
    await import('./config.service.js');

afterAll(() => {
    if (previousConfigPath === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = previousConfigPath;
    rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true });
    writeFileSync(filePath, JSON.stringify({ APP_NAME: 'Saved Name' }, null, 2) + '\n');
    initConfigServiceSync({});
});

describe('settings.json that cannot be parsed', () => {
    it('refuses a save instead of overwriting the file with only the new keys', async () => {
        const corrupt = '{"APP_NAME": "Saved Name", "TMDB_API_KEY": "enc:v2:';
        writeFileSync(filePath, corrupt);

        await expect(saveConfig({ TMDB_LANGUAGE: 'de-DE' })).rejects.toBeInstanceOf(
            ConfigFileUnreadableError,
        );
        expect(readFileSync(filePath, 'utf-8')).toBe(corrupt);
    });

    it('keeps the loaded settings when a reload hits it, and reports the failure', async () => {
        expect(getAll().APP_NAME).toBe('Saved Name');
        writeFileSync(filePath, '{ not json');

        await expect(reloadConfig()).rejects.toBeInstanceOf(ConfigFileUnreadableError);
        expect(getAll().APP_NAME).toBe('Saved Name');
    });
});

describe('saving settings.json', () => {
    it('keeps the other saved keys and leaves no temp file behind', async () => {
        await saveConfig({ TMDB_LANGUAGE: 'de-DE' });

        const written = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
        expect(written).toMatchObject({ APP_NAME: 'Saved Name', TMDB_LANGUAGE: 'de-DE' });
        expect(readdirSync(dir)).toEqual(['settings.json']);
    });
});

describe('the stored-secret placeholder', () => {
    it('is never saved as the value of a secret', async () => {
        const { SECRET_CONFIGURED_SENTINEL } = await import('$lib/shared/secret-sentinel');
        await expect(saveConfig({ TMDB_API_KEY: SECRET_CONFIGURED_SENTINEL })).rejects.toThrow(
            /placeholder/,
        );
        expect(JSON.parse(readFileSync(filePath, 'utf-8'))).not.toHaveProperty('TMDB_API_KEY');
    });
});
