// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * settings.json secret rotation + the loud reporting of values that cannot be
 * opened (security review 2026-09-12, C9).
 *
 * Before C9, `POST /api/admin/secrets/rotate` re-sealed only the plugin secret
 * tables. An operator who rotated and then swapped LUMASTRA_MASTER_KEY — the
 * sequence the UI told them to follow — lost every sensitive setting in this
 * file: `decryptLoadedConfig` dropped each one with a `console.warn` and the app
 * carried on serving the schema default for an API key the admin page still
 * showed as configured.
 *
 * The filesystem is faked in-memory, so these tests never touch a real
 * settings.json.
 *
 * Run: npx vitest run src/lib/server/config/config-secret-rotation.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveMasterKey, sealSecret, openSecret } from '$lib/server/crypto/secret-box.js';

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: (p: string) => files.has(String(p)) || actual.existsSync(p),
        readFileSync: (p: string, enc?: unknown) => {
            const hit = files.get(String(p));
            return hit !== undefined ? hit : actual.readFileSync(p, enc as never);
        },
    };
});

vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return {
        ...actual,
        writeFile: vi.fn(async (p: string, data: string) => {
            files.set(String(p), data);
        }),
        // settings.json is written to a temp file and renamed into place.
        rename: vi.fn(async (from: string, to: string) => {
            files.set(String(to), files.get(String(from)) ?? '');
            files.delete(String(from));
        }),
        mkdir: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('$lib/server/crypto/master-key.js', () => ({
    resolveMasterKey: () => 'a'.repeat(64),
}));

const KEY_A = deriveMasterKey('a'.repeat(64));
const KEY_B = deriveMasterKey('b'.repeat(64));

/**
 * The AAD context config.service binds a sealed setting to — its own key
 * (security review 2026-09-13, C19). Spelled out here rather than imported so
 * the test pins the ON-DISK contract: change the format and this fails, as it
 * should, because every existing settings.json would stop opening.
 */
function ctx(key: string): string {
    return `settings.json:${key}`;
}

const {
    initConfigServiceSync,
    getConfigFilePath,
    rotateConfigSecrets,
    saveConfig,
    getUndecryptableConfigKeys,
    getLegacyConfigEnvelopeKeys,
    __resetConfigMasterKeyCacheForTests,
} = await import('./config.service.js');

function writeSettings(values: Record<string, unknown>): string {
    // getConfigFilePath() consults existsSync, so seed the file first and read
    // the path back the way the service itself resolves it.
    const path = getConfigFilePath();
    files.set(path, JSON.stringify(values, null, 2) + '\n');
    return path;
}

function readSettings(path: string): Record<string, unknown> {
    return JSON.parse(files.get(path) ?? '{}') as Record<string, unknown>;
}

describe('rotateConfigSecrets', () => {
    beforeEach(() => {
        files.clear();
        initConfigServiceSync({});
    });

    it('re-seals a sensitive setting so it opens under the new key and not the old', async () => {
        const path = writeSettings({
            TMDB_API_KEY: sealSecret('tmdb-secret-value', KEY_A),
            SITE_NAME: 'Lumastra',
        });

        const result = await rotateConfigSecrets(KEY_A, KEY_B);

        expect(result).toEqual({ rotated: 1, skipped: 0, reasons: [], legacyUpgraded: 1 });
        const after = readSettings(path);
        const rotatedValue = after.TMDB_API_KEY as string;
        // Rotation is also the envelope upgrade path: the re-sealed value is
        // bound to its setting key and no longer opens as a bare envelope.
        expect(rotatedValue.startsWith('enc:v2:')).toBe(true);
        expect(openSecret(rotatedValue, KEY_B, ctx('TMDB_API_KEY'))).toBe('tmdb-secret-value');
        expect(() => openSecret(rotatedValue, KEY_B, ctx('OPENAI_API_KEY'))).toThrow();
        expect(() => openSecret(rotatedValue, KEY_A, ctx('TMDB_API_KEY'))).toThrow();
        // Plaintext settings are untouched.
        expect(after.SITE_NAME).toBe('Lumastra');
    });

    it('is safe to re-run: a value already under the new key is not rewritten', async () => {
        const path = writeSettings({
            TMDB_API_KEY: sealSecret('tmdb-secret-value', KEY_B, ctx('TMDB_API_KEY')),
        });
        const before = files.get(path);

        const result = await rotateConfigSecrets(KEY_A, KEY_B);

        expect(result.rotated).toBe(1);
        expect(result.skipped).toBe(0);
        expect(files.get(path)).toBe(before);
    });

    it('upgrades an unbound enc:v1: value that is ALREADY under the new key', async () => {
        // The state an install lands in after rotating once before C19 shipped:
        // the value is under the right key but carries no row binding, so it
        // could still be swapped into another setting. Rotation must rewrite it
        // even though the key does not change.
        const path = writeSettings({ TMDB_API_KEY: sealSecret('tmdb-secret-value', KEY_B) });

        const result = await rotateConfigSecrets(KEY_A, KEY_B);

        expect(result).toEqual({ rotated: 1, skipped: 0, reasons: [], legacyUpgraded: 1 });
        const upgraded = readSettings(path).TMDB_API_KEY as string;
        expect(upgraded.startsWith('enc:v2:')).toBe(true);
        expect(openSecret(upgraded, KEY_B, ctx('TMDB_API_KEY'))).toBe('tmdb-secret-value');
        expect(() => openSecret(upgraded, KEY_B, ctx('SOME_OTHER_KEY'))).toThrow();
    });

    it('a sealed value moved to another setting key is dropped, not decrypted', async () => {
        // The C19 attack, at the config layer: copy the envelope of one
        // sensitive setting into another and the loader hands the second
        // setting the first one's secret.
        const stolen = sealSecret('tmdb-secret-value', KEY_A, ctx('TMDB_API_KEY'));
        const path = writeSettings({ OPENAI_API_KEY: stolen });

        const result = await rotateConfigSecrets(KEY_A, KEY_B);

        expect(result.rotated).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.reasons[0]).toContain('OPENAI_API_KEY');
        expect(readSettings(path).OPENAI_API_KEY).toBe(stolen);
    });

    it('reports a value that opens under neither key and leaves the file alone', async () => {
        const KEY_C = deriveMasterKey('c'.repeat(64));
        const path = writeSettings({ TMDB_API_KEY: sealSecret('orphan', KEY_C) });
        const before = files.get(path);

        const result = await rotateConfigSecrets(KEY_A, KEY_B);

        expect(result.rotated).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.reasons[0]).toContain('TMDB_API_KEY');
        expect(files.get(path)).toBe(before);
    });
});

describe('undecryptable settings are reported, not silently dropped', () => {
    beforeEach(() => {
        files.clear();
        // rotateConfigSecrets above re-points the module's memoized key at
        // KEY_B by design (the replica that served the rotation self-heals).
        // Drop it so these tests start from the mocked LUMASTRA_MASTER_KEY.
        __resetConfigMasterKeyCacheForTests();
    });

    it('names every dropped key through getUndecryptableConfigKeys() and logs at error level', () => {
        const KEY_C = deriveMasterKey('c'.repeat(64));
        // Seed before init so the sync loader picks the file up.
        files.set(
            getConfigFilePath(),
            JSON.stringify(
                {
                    TMDB_API_KEY: sealSecret('orphan-one', KEY_C),
                    OPENAI_API_KEY: sealSecret('orphan-two', KEY_C),
                    SITE_NAME: 'Lumastra',
                },
                null,
                2,
            ) + '\n',
        );
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        initConfigServiceSync({});

        expect(getUndecryptableConfigKeys().sort()).toEqual(['OPENAI_API_KEY', 'TMDB_API_KEY']);
        // The summary line must NAME the keys — that is what makes the
        // condition actionable (and what a self-check rule reports).
        const summary = errorSpy.mock.calls
            .map((c) => String(c[0]))
            .find((m) => m.includes('could not be decrypted'));
        expect(summary).toBeDefined();
        expect(summary).toContain('TMDB_API_KEY');
        expect(summary).toContain('OPENAI_API_KEY');
        errorSpy.mockRestore();
    });

    it('clears only repaired settings after a save, without a restart or a config-change event', async () => {
        writeSettings({
            TMDB_API_KEY: sealSecret('orphan-one', KEY_B),
            OPENAI_API_KEY: sealSecret('orphan-two', KEY_B),
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            initConfigServiceSync({});
            expect(getUndecryptableConfigKeys()).toEqual(['TMDB_API_KEY', 'OPENAI_API_KEY']);
            await saveConfig({ APP_NAME: 'Restored server' });
            expect(getUndecryptableConfigKeys()).toEqual(['TMDB_API_KEY', 'OPENAI_API_KEY']);
            await saveConfig({ TMDB_API_KEY: '1'.repeat(32) });
            expect(getUndecryptableConfigKeys()).toEqual(['OPENAI_API_KEY']);
            // Re-running setup/saving the same credential is safe.
            await saveConfig({ TMDB_API_KEY: '1'.repeat(32) });
            expect(getUndecryptableConfigKeys()).toEqual(['OPENAI_API_KEY']);
            await saveConfig({ OPENAI_API_KEY: '' });
            expect(getUndecryptableConfigKeys()).toEqual([]);
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('reports nothing when every sealed value opens', () => {
        files.set(
            getConfigFilePath(),
            JSON.stringify({ TMDB_API_KEY: sealSecret('good', KEY_A) }, null, 2) + '\n',
        );

        initConfigServiceSync({});

        expect(getUndecryptableConfigKeys()).toEqual([]);
    });
});

// ── Un-upgraded envelopes are reportable (security review 2026-09-13, C19) ────
//
// settings.json is a FILE, so the security self-check cannot count its legacy
// envelopes with a query the way it counts every database store. It asks this
// module — which means this module has to keep the answer true across a load,
// a rotation and a save, not just at boot.

describe('getLegacyConfigEnvelopeKeys', () => {
    beforeEach(() => {
        files.clear();
        __resetConfigMasterKeyCacheForTests();
    });

    it('names the settings still sealed in the unbound enc:v1: form', () => {
        files.set(
            getConfigFilePath(),
            JSON.stringify(
                {
                    TMDB_API_KEY: sealSecret('legacy', KEY_A),
                    OPENAI_API_KEY: sealSecret('bound', KEY_A, ctx('OPENAI_API_KEY')),
                    SITE_NAME: 'Lumastra',
                },
                null,
                2,
            ) + '\n',
        );

        initConfigServiceSync({});

        expect(getLegacyConfigEnvelopeKeys()).toEqual(['TMDB_API_KEY']);
    });

    it('is empty when every sealed value is row-bound', () => {
        files.set(
            getConfigFilePath(),
            JSON.stringify(
                { TMDB_API_KEY: sealSecret('bound', KEY_A, ctx('TMDB_API_KEY')) },
                null,
                2,
            ) + '\n',
        );

        initConfigServiceSync({});

        expect(getLegacyConfigEnvelopeKeys()).toEqual([]);
    });

    it('goes empty after a rotation upgrades the file, without a restart', () => {
        // The stale-answer trap: the count is recorded at LOAD, and a rotation
        // rewrites the file underneath it. An operator who rotates and re-runs
        // the self-check must see the warning clear.
        files.set(
            getConfigFilePath(),
            JSON.stringify({ TMDB_API_KEY: sealSecret('legacy', KEY_A) }, null, 2) + '\n',
        );
        initConfigServiceSync({});
        expect(getLegacyConfigEnvelopeKeys()).toEqual(['TMDB_API_KEY']);

        return rotateConfigSecrets(KEY_A, KEY_B).then((result) => {
            expect(result.rotated).toBe(1);
            expect(getLegacyConfigEnvelopeKeys()).toEqual([]);
        });
    });
});
