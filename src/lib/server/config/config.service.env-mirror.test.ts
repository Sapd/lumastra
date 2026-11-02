// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The config service mirrors settings into process.env for plugins. A reload
 * (every save broadcasts one) reads the environment again and used to take
 * those mirrored copies for operator variables: the setting turned "ENV"
 * (locked in the admin UI, skipped by saveConfig) and the stale copy beat the
 * settings.json value it was copied from.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ json: {} as Record<string, unknown> }));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() => JSON.stringify(files.json)),
    };
});
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return {
        ...actual,
        readFile: vi.fn(async () => JSON.stringify(files.json)),
        writeFile: vi.fn().mockResolvedValue(undefined),
        // settings.json is written to a temp file and renamed into place.
        rename: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
    };
});
// No SvelteKit runtime here: getEnvVariables() falls back to process.env —
// the path the worker process takes.
vi.mock('$env/dynamic/private', () => {
    throw new Error('not in SvelteKit');
});

import { get, initConfigServiceSync, isEnvOverridden, reloadConfig } from './config.service.js';

afterEach(() => {
    delete process.env.METADATA_PROVIDERS;
    delete process.env.TMDB_LANGUAGE;
});

describe('config reload vs. the process.env mirror', () => {
    it('does not treat its own mirrored values as operator env vars', async () => {
        files.json = { METADATA_PROVIDERS: 'tmdb,mdblist' };
        initConfigServiceSync({});
        expect(process.env.METADATA_PROVIDERS).toBe('tmdb,mdblist'); // mirrored

        // Another replica saves a new order; this one reloads.
        files.json = { METADATA_PROVIDERS: 'mdblist,tmdb' };
        await reloadConfig();

        expect(isEnvOverridden('METADATA_PROVIDERS')).toBe(false);
        expect(get('METADATA_PROVIDERS')).toBe('mdblist,tmdb');
    });

    it('still honours a real operator env var across reloads', async () => {
        files.json = { TMDB_LANGUAGE: 'de-DE' };
        initConfigServiceSync({ TMDB_LANGUAGE: 'fr-FR' });
        process.env.TMDB_LANGUAGE = 'fr-FR';

        await reloadConfig();

        expect(isEnvOverridden('TMDB_LANGUAGE')).toBe(true);
        expect(get('TMDB_LANGUAGE')).toBe('fr-FR');
    });
});

describe('"Save to config" for an ENV-owned key', () => {
    it('writes the value to settings.json only when asked to, and the env var keeps winning', async () => {
        const { writeFile } = await import('fs/promises');
        const { saveConfig } = await import('./config.service.js');
        files.json = {};
        process.env.TMDB_LANGUAGE = 'fr-FR';
        initConfigServiceSync({ TMDB_LANGUAGE: 'fr-FR' });
        const written = (): string => String(vi.mocked(writeFile).mock.calls.at(-1)?.[1] ?? '');

        await saveConfig({ TMDB_LANGUAGE: 'fr-FR' });
        expect(written()).not.toContain('TMDB_LANGUAGE');

        await saveConfig({ TMDB_LANGUAGE: 'fr-FR' }, { persistEnvOverridden: true });
        expect(written()).toContain('"TMDB_LANGUAGE": "fr-FR"');
        expect(isEnvOverridden('TMDB_LANGUAGE')).toBe(true);
        expect(get('TMDB_LANGUAGE')).toBe('fr-FR');
    });
});

describe('public URL normalization', () => {
    it('normalizes on save and applies immediately, including after a reload and repeat save', async () => {
        const { saveConfig } = await import('./config.service.js');
        files.json = {};
        initConfigServiceSync({});
        await saveConfig({ PUBLIC_BASE_URL: 'https://example.com/media/' });
        expect(get('PUBLIC_BASE_URL')).toBe('https://example.com/media');
        files.json = { PUBLIC_BASE_URL: get('PUBLIC_BASE_URL') };
        await reloadConfig();
        await saveConfig({ PUBLIC_BASE_URL: 'https://example.com/media/' });
        expect(get('PUBLIC_BASE_URL')).toBe('https://example.com/media');
    });
});

it('warns once at startup for an invalid saved PUBLIC_BASE_URL, without exposing its credentials', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        files.json = { PUBLIC_BASE_URL: 'https://user:never-log-this@example.com/media' };
        initConfigServiceSync({});
        await reloadConfig();
        const warnings = warn.mock.calls.filter(([message]) =>
            String(message).includes('PUBLIC_BASE_URL'),
        );
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0][0])).toContain('re-save');
        expect(JSON.stringify(warn.mock.calls)).not.toContain('never-log-this');
    } finally {
        warn.mockRestore();
        delete process.env.PUBLIC_BASE_URL;
    }
});
