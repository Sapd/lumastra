// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * config.service — METADATA_ADDITIONAL_LANGUAGES settings-save hook tests.
 *
 * Final-review CRITICAL finding (multilingual-media-metadata): the hook that
 * fires `metadata-translations-seed` on a newly-added language used to gate
 * on `Array.isArray(updates['METADATA_ADDITIONAL_LANGUAGES'])` on BOTH sides
 * of its diff. The admin UI's `ArrayInput.svelte` always submits array-type
 * settings as a single COMMA-SEPARATED STRING — parsing only happens at
 * config-READ time via `getConfig('array')` → `parseList` — so both diff
 * sides were always `[]` for a real UI save and the seed task never fired.
 *
 * These tests exercise `saveConfig` with the REAL string shape the admin UI
 * sends, proving:
 *   - a language add via a string value enqueues the seed task with
 *     `{ reEnroll: true }`
 *   - a same-set re-save (string → same string) does NOT re-enqueue
 *   - a casing-only change (`pt-br` → `pt-BR`) does NOT re-enqueue
 *   - a `deduped: true` resolution from the fired run is surfaced via a
 *     console warning (the accepted cross-replica race becoming observable)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStartRun } = vi.hoisted(() => ({
    mockStartRun: vi.fn(),
}));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: mockStartRun },
}));

// doSaveConfig touches the filesystem (existsSync/readFileSync from 'fs',
// writeFile/mkdir from 'fs/promises') to seed-from/persist settings.json.
// Force "no existing file" so every save starts from an empty jsonContent —
// these tests only care about the hook's added-language diffing, not file
// persistence.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn(actual.readFileSync),
    };
});
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return {
        ...actual,
        writeFile: vi.fn().mockResolvedValue(undefined),
        // settings.json is written to a temp file and renamed into place.
        rename: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
    };
});

import { existsSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { ConfigConflictError } from './config-conflict.js';
import { configSchema, validateSettingValue } from '$lib/config/schema.js';
import {
    get,
    getAll,
    initConfigServiceSync,
    isEnvOverridden,
    saveConfig,
    withRenamedKeys,
} from './config.service.js';

/**
 * Wait for the fire-and-forget dynamic-import + `.then()/.catch()` chain in
 * doSaveConfig to settle. A dynamic `import()` plus several chained `.then()`
 * calls span more ticks than a fixed number of `Promise.resolve()` awaits
 * reliably covers, so park behind a macrotask boundary instead — guaranteed
 * to run after every already-queued microtask.
 */
async function flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('config.service — METADATA_ADDITIONAL_LANGUAGES settings-save hook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStartRun.mockResolvedValue({ runId: 'run-1' });
        initConfigServiceSync({});
    });

    it('enqueues metadata-translations-seed with {reEnroll:true} when the UI saves a comma-separated STRING adding a language', async () => {
        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de' });
        await flushMicrotasks();

        expect(mockStartRun).toHaveBeenCalledWith(
            'metadata-translations-seed',
            { reEnroll: true },
            { trigger: { kind: 'in-process', sourceRoute: 'config.service' } },
        );
    });

    it('does NOT enqueue on a same-set re-save (string, unchanged language set)', async () => {
        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de' });
        await flushMicrotasks();
        mockStartRun.mockClear();

        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de' });
        await flushMicrotasks();

        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('does NOT enqueue on a casing-only change (pt-br -> pt-BR)', async () => {
        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'pt-br' });
        await flushMicrotasks();
        mockStartRun.mockClear();

        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'pt-BR' });
        await flushMicrotasks();

        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('DOES enqueue when a language is appended to an existing string list', async () => {
        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de' });
        await flushMicrotasks();
        mockStartRun.mockClear();

        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de, ja' });
        await flushMicrotasks();

        expect(mockStartRun).toHaveBeenCalledTimes(1);
        expect(mockStartRun).toHaveBeenCalledWith(
            'metadata-translations-seed',
            { reEnroll: true },
            { trigger: { kind: 'in-process', sourceRoute: 'config.service' } },
        );
    });

    it('warns (without throwing) when the fired run resolves deduped:true', async () => {
        mockStartRun.mockResolvedValue({ runId: 'run-1', deduped: true, existingRunId: 'run-0' });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de' });
        await flushMicrotasks();

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('deduped'),
            expect.objectContaining({ existingRunId: 'run-0' }),
        );
        warnSpy.mockRestore();
    });

    it('does NOT enqueue when removing a language (no addition)', async () => {
        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de, ja' });
        await flushMicrotasks();
        mockStartRun.mockClear();

        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de' });
        await flushMicrotasks();

        expect(mockStartRun).not.toHaveBeenCalled();
    });

    // Primary-exclusion symmetry with the runtime getter: an entry equal to
    // the primary TMDB_LANGUAGE (bare or full tag) is dropped by
    // `config.METADATA_ADDITIONAL_LANGUAGES`, so the effective set never
    // gains it — the save-hook diff must not count it as "added" and fire a
    // whole-catalog re-enroll + TMDB re-fetch for nothing. TMDB_LANGUAGE's
    // schema default is 'en-US' (seeded into configState by
    // initConfigServiceSync), which is the primary in effect here.
    it('does NOT enqueue when the only "added" entry equals the primary language (bare tag)', async () => {
        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de' });
        await flushMicrotasks();
        mockStartRun.mockClear();

        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de, en' });
        await flushMicrotasks();

        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when the only "added" entry equals the primary language (full tag)', async () => {
        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de' });
        await flushMicrotasks();
        mockStartRun.mockClear();

        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de, en-US' });
        await flushMicrotasks();

        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('DOES still enqueue when a real language is added alongside a primary-equal entry', async () => {
        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de' });
        await flushMicrotasks();
        mockStartRun.mockClear();

        await saveConfig({ METADATA_ADDITIONAL_LANGUAGES: 'de, en, ja' });
        await flushMicrotasks();

        expect(mockStartRun).toHaveBeenCalledTimes(1);
    });
});

describe('config.service — env-sourced numbers honour the schema bounds', () => {
    const RETENTION = 'CLIENT_DIAGNOSTICS_RETENTION_DAYS'; // min 1, max 365, integer
    const BYTES = 'CLIENT_DIAGNOSTICS_DAILY_BYTES_PER_USER'; // min 1 MiB, max 1 GiB, integer
    const RATIO = 'FORYOU_SIMILAR_AVAILABLE_RATIO'; // fractional, min 0, max 1

    function defaultOf(key: string): unknown {
        return configSchema.find((s) => s.key === key)?.defaultValue;
    }

    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('applies an in-range integer from the environment', () => {
        initConfigServiceSync({ [RETENTION]: '7' });
        expect(get(RETENTION)).toBe(7);
        expect(isEnvOverridden(RETENTION)).toBe(true);
    });

    it.each([
        ['zero', '0'],
        ['negative', '-5'],
        ['fraction for an integer key', '1.5'],
        ['Infinity', 'Infinity'],
        ['over max', '366'],
    ])('ignores %s (%s) and keeps the default', (_label, raw) => {
        initConfigServiceSync({ [RETENTION]: raw });
        expect(get(RETENTION)).toBe(defaultOf(RETENTION));
        expect(isEnvOverridden(RETENTION)).toBe(false);
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining(`Ignoring invalid environment value for ${RETENTION}`),
        );
    });

    it('ignores a non-numeric value (NaN) and keeps the default', () => {
        initConfigServiceSync({ [RETENTION]: 'abc' });
        expect(get(RETENTION)).toBe(defaultOf(RETENTION));
        expect(isEnvOverridden(RETENTION)).toBe(false);
    });

    it.each([
        ['under min', '1024'],
        ['over max', String(2 * 1_073_741_824)],
        ['-Infinity', '-Infinity'],
    ])('ignores %s for the daily byte budget', (_label, raw) => {
        initConfigServiceSync({ [BYTES]: raw });
        expect(get(BYTES)).toBe(defaultOf(BYTES));
        expect(isEnvOverridden(BYTES)).toBe(false);
    });

    it('still accepts a fraction for a non-integer key', () => {
        initConfigServiceSync({ [RATIO]: '0.25' });
        expect(get(RATIO)).toBe(0.25);
        expect(isEnvOverridden(RATIO)).toBe(true);
    });

    it('rejects an out-of-range fractional key from the environment', () => {
        initConfigServiceSync({ [RATIO]: '1.5' });
        expect(get(RATIO)).toBe(defaultOf(RATIO));
        expect(isEnvOverridden(RATIO)).toBe(false);
    });

    it('validateSettingValue rejects non-finite numbers and fractions for integer keys', () => {
        const retention = configSchema.find((s) => s.key === RETENTION);
        const ratio = configSchema.find((s) => s.key === RATIO);
        if (!retention || !ratio) throw new Error('schema keys missing');
        expect(validateSettingValue(retention, Number.NaN).valid).toBe(false);
        expect(validateSettingValue(retention, Number.POSITIVE_INFINITY).valid).toBe(false);
        expect(validateSettingValue(retention, 2.5).valid).toBe(false);
        expect(validateSettingValue(retention, 30).valid).toBe(true);
        expect(validateSettingValue(ratio, 0.5).valid).toBe(true);
    });
});

describe('config.service — save-time colour/URL format rules', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a CHANGED malformed colour and a relative-without-slash URL', async () => {
        initConfigServiceSync({});
        await expect(saveConfig({ APP_THEME_COLOR: '#7c3aedx' })).rejects.toThrow(
            /APP_THEME_COLOR/,
        );
        await expect(saveConfig({ APP_LOGO_SMALL: 'custom/logo.webp' })).rejects.toThrow(
            /APP_LOGO_SMALL/,
        );
    });

    it('accepts the documented root-relative branding path', async () => {
        initConfigServiceSync({});
        await expect(
            saveConfig({ APP_LOGO_SMALL: '/custom/site-button.webp' }),
        ).resolves.not.toThrow();
    });

    it('does not let an UNCHANGED legacy value block saving another setting', async () => {
        // The settings page posts every value it loaded, including one that
        // predates the format rule.
        initConfigServiceSync({ APP_THEME_COLOR: 'purple' });
        await expect(
            saveConfig({ APP_THEME_COLOR: 'purple', APP_BACKGROUND_COLOR: '#0f172a' }),
        ).resolves.not.toThrow();
    });
});

describe('config.service — keys renamed before v0.1 (Jellyseerr → Seerr)', () => {
    it('reads the old environment variable names when the new ones are unset', () => {
        initConfigServiceSync({ JELLYSEERRURL: 'http://seerr:5055', JELLYSEERRAPIKEY: 'old-key' });
        expect(get('SEERRURL')).toBe('http://seerr:5055');
        expect(get('SEERRAPIKEY')).toBe('old-key');
    });

    it('prefers the new name when both are set', () => {
        initConfigServiceSync({ JELLYSEERRURL: 'http://old:5055', SEERRURL: 'http://new:5055' });
        expect(get('SEERRURL')).toBe('http://new:5055');
    });

    it('maps old settings.json keys the same way, without overriding a set new key', () => {
        expect(
            withRenamedKeys({
                JELLYSEERRURL: 'http://old',
                SEERRAPIKEY: 'new-key',
                JELLYSEERRAPIKEY: 'old-key',
            }),
        ).toMatchObject({
            SEERRURL: 'http://old',
            SEERRAPIKEY: 'new-key',
        });
        expect(withRenamedKeys({ JELLYSEERRURL: '' })).not.toHaveProperty('SEERRURL');
    });
});

describe('config.service — keys of removed integrations', () => {
    it('ignores an env key that is no longer in the schema', () => {
        expect(() =>
            initConfigServiceSync({
                REMOVED_INTEGRATIONURL: 'http://old:8080',
                REMOVED_INTEGRATIONAPIKEY: 'k',
            }),
        ).not.toThrow();
        expect(getAll()).not.toHaveProperty('REMOVED_INTEGRATIONURL');
        expect(getAll()).not.toHaveProperty('REMOVED_INTEGRATIONAPIKEY');
        expect(configSchema.some((s) => s.key === 'REMOVED_INTEGRATIONURL')).toBe(false);
    });

    it('ignores a settings.json key that is no longer in the schema', () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(
            JSON.stringify({
                REMOVED_INTEGRATIONURL: 'http://old:8080',
                SONARRURL: 'http://s:8989',
            }),
        );
        try {
            expect(() => initConfigServiceSync({})).not.toThrow();
            expect(getAll()).not.toHaveProperty('REMOVED_INTEGRATIONURL');
            expect(get('SONARRURL')).toBe('http://s:8989');
        } finally {
            vi.mocked(existsSync).mockReturnValue(false);
            vi.mocked(readFileSync).mockRestore();
        }
    });
});

describe('config.service — pinKeys keeps an explicit default-equal choice', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        initConfigServiceSync({});
    });

    function lastWrittenFile(): Record<string, unknown> {
        const calls = vi.mocked(writeFile).mock.calls;
        return JSON.parse(String(calls[calls.length - 1]![1])) as Record<string, unknown>;
    }

    it('drops a default-equal value without pinKeys (it follows the default)', async () => {
        const def = configSchema.find((s) => s.key === 'FEATURE_CALENDAR')!.defaultValue;
        await saveConfig({ FEATURE_CALENDAR: def as boolean });
        expect(lastWrittenFile()).not.toHaveProperty('FEATURE_CALENDAR');
    });

    it('persists a default-equal value named in pinKeys, and only that one', async () => {
        const cal = configSchema.find((s) => s.key === 'FEATURE_CALENDAR')!.defaultValue;
        const live = configSchema.find((s) => s.key === 'FEATURE_LIVETV')!.defaultValue;
        await saveConfig(
            { FEATURE_CALENDAR: cal as boolean, FEATURE_LIVETV: live as boolean },
            { pinKeys: ['FEATURE_CALENDAR'] },
        );
        const file = lastWrittenFile();
        expect(file.FEATURE_CALENDAR).toBe(cal);
        expect(file).not.toHaveProperty('FEATURE_LIVETV');
    });
});

describe('config.service — expect (compare-and-swap against settings.json)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        initConfigServiceSync({});
    });

    it('refuses the save when the file value fails the test, and writes nothing', async () => {
        await expect(
            saveConfig(
                { FEATURE_LIVETV: true },
                { expect: { key: 'INSTANCE_PROFILE_APPLIED', test: (v) => v === 'rev-2' } },
            ),
        ).rejects.toBeInstanceOf(ConfigConflictError);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it('saves when the file value passes the test', async () => {
        // No settings.json yet: the key reads as undefined.
        await saveConfig(
            { FEATURE_LIVETV: true },
            { expect: { key: 'INSTANCE_PROFILE_APPLIED', test: (v) => v === undefined } },
        );
        expect(writeFile).toHaveBeenCalled();
    });
});

it('applies the saved Live TV private-network opt-in immediately and can be re-run', async () => {
    initConfigServiceSync({});
    const { config } = await import('../config.js');
    expect(config.LIVETV_ALLOW_PRIVATE_URLS).toBe(false);
    await saveConfig({ LIVETV_ALLOW_PRIVATE_URLS: true });
    expect(config.LIVETV_ALLOW_PRIVATE_URLS).toBe(true);
    await saveConfig({ LIVETV_ALLOW_PRIVATE_URLS: true });
    expect(config.LIVETV_ALLOW_PRIVATE_URLS).toBe(true);
    await saveConfig({ LIVETV_ALLOW_PRIVATE_URLS: false });
    expect(config.LIVETV_ALLOW_PRIVATE_URLS).toBe(false);
});

describe('config.service — primary metadata language validation', () => {
    it('rejects a changed invalid language when saving Settings', async () => {
        initConfigServiceSync({});
        await expect(saveConfig({ TMDB_LANGUAGE: 'german' })).rejects.toThrow(/language code/i);
    });
    it.each(['es-419', 'zh-Hans', 'en-001', 'zh-Hant-TW'])(
        'accepts %s in Settings',
        async (value) => {
            initConfigServiceSync({});
            await expect(saveConfig({ TMDB_LANGUAGE: value })).resolves.not.toThrow();
        },
    );
    it('does not reject other settings because the language is environment-owned', async () => {
        initConfigServiceSync({ TMDB_LANGUAGE: 'legacy-language' });
        await expect(
            saveConfig({ TMDB_LANGUAGE: 'german', FEATURE_GRAVATAR: true }),
        ).resolves.not.toThrow();
        expect(get('TMDB_LANGUAGE')).toBe('legacy-language');
        expect(get('FEATURE_GRAVATAR')).toBe(true);
    });
});

it('preserves an unchanged file-stored legacy primary language while saving another setting', async () => {
    const previousRead = vi.mocked(readFileSync).getMockImplementation();
    const previousExists = vi.mocked(existsSync).getMockImplementation();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ TMDB_LANGUAGE: 'legacy-language' }));
    try {
        initConfigServiceSync({});
        expect(get('TMDB_LANGUAGE')).toBe('legacy-language');
        expect(isEnvOverridden('TMDB_LANGUAGE')).toBe(false);
        await expect(
            saveConfig({ TMDB_LANGUAGE: 'legacy-language', FEATURE_GRAVATAR: true }),
        ).resolves.not.toThrow();
        expect(get('TMDB_LANGUAGE')).toBe('legacy-language');
        expect(get('FEATURE_GRAVATAR')).toBe(true);
    } finally {
        vi.mocked(existsSync).mockReset();
        vi.mocked(readFileSync).mockReset();
        if (previousExists) vi.mocked(existsSync).mockImplementation(previousExists);
        if (previousRead) vi.mocked(readFileSync).mockImplementation(previousRead);
    }
});
