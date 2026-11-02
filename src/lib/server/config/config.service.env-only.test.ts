// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `envOnlyEnforced` settings (FORWARD_AUTH_ENABLED): the environment is the
 * only source. A settings.json value is ignored with one warning, the admin
 * save path refuses to change it, and it is never written to settings.json.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '$lib/config/schema';

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
vi.mock('$env/dynamic/private', () => {
    throw new Error('not in SvelteKit');
});

import {
    __resetIgnoredEnvOnlyLogForTests,
    get,
    initConfigServiceSync,
    reloadConfig,
    saveConfig,
} from './config.service.js';

const KEY = 'FORWARD_AUTH_ENABLED';

function ignoredWarnings(warn: ReturnType<typeof vi.spyOn>): string[] {
    return warn.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((msg: string) => msg.includes(`settings.json sets ${KEY}=`));
}

beforeEach(() => {
    __resetIgnoredEnvOnlyLogForTests();
    delete process.env[KEY];
});

afterEach(() => {
    vi.restoreAllMocks();
    delete process.env[KEY];
});

describe('schema', () => {
    it('marks FORWARD_AUTH_ENABLED env-only and read-only in the UI', () => {
        const setting = configSchema.find((s) => s.key === KEY);
        expect(setting?.envOnlyEnforced).toBe(true);
        expect(setting?.uiHints?.envOnly).toBe(true);
    });

    it('enforces env-only on AUTH_OIDC_ALLOW_INSECURE (it disables TLS checks for the IdP)', () => {
        expect(
            configSchema.find((s) => s.key === 'AUTH_OIDC_ALLOW_INSECURE')?.envOnlyEnforced,
        ).toBe(true);
    });

    it('every envOnlyEnforced setting also disables its input (uiHints.envOnly)', () => {
        for (const s of configSchema.filter((x) => x.envOnlyEnforced)) {
            expect(s.uiHints?.envOnly, s.key).toBe(true);
        }
    });
});

describe('settings.json value for an env-only key', () => {
    it('settings.json true with no env var: ignored, forward auth stays off, one warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        files.json = { [KEY]: true };
        initConfigServiceSync({});
        expect(get(KEY)).toBe(false);

        // A reload (every save on another replica broadcasts one) does not log again.
        await reloadConfig();
        expect(get(KEY)).toBe(false);

        const msgs = ignoredWarnings(warn);
        expect(msgs).toHaveLength(1);
        expect(msgs[0]).toContain('In effect: false from the default');
    });

    it('settings.json false with the env var true: the env var wins and the file value is reported', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        files.json = { [KEY]: false };
        initConfigServiceSync({ [KEY]: 'true' });
        expect(get(KEY)).toBe(true);
        expect(ignoredWarnings(warn)[0]).toContain('In effect: true from the environment');
    });

    it('no settings.json value: no warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        files.json = {};
        initConfigServiceSync({ [KEY]: 'true' });
        expect(get(KEY)).toBe(true);
        expect(ignoredWarnings(warn)).toEqual([]);
    });
});

describe('saving an env-only key', () => {
    it('refuses a change', async () => {
        files.json = {};
        initConfigServiceSync({});
        await expect(saveConfig({ [KEY]: true })).rejects.toThrow(
            `${KEY} can only be set as an environment variable`,
        );
        expect(get(KEY)).toBe(false);
    });

    it('accepts the value in effect (the settings page posts it back) and never writes it', async () => {
        const { writeFile } = await import('fs/promises');
        files.json = {};
        initConfigServiceSync({});
        await saveConfig({ [KEY]: false, TMDB_LANGUAGE: 'de-DE' });
        const written = JSON.parse(String(vi.mocked(writeFile).mock.calls.at(-1)?.[1] ?? '{}'));
        expect(written).not.toHaveProperty(KEY);
        expect(written.TMDB_LANGUAGE).toBe('de-DE');
    });

    it('persistEnvOverridden does not copy it to settings.json either', async () => {
        const { writeFile } = await import('fs/promises');
        files.json = {};
        process.env[KEY] = 'true';
        initConfigServiceSync({ [KEY]: 'true' });
        await saveConfig({ [KEY]: true }, { persistEnvOverridden: true });
        const written = JSON.parse(String(vi.mocked(writeFile).mock.calls.at(-1)?.[1] ?? '{}'));
        expect(written).not.toHaveProperty(KEY);
    });
});
