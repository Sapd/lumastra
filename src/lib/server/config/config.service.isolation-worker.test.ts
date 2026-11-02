// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The config service inside a plugin-isolation worker (Windows new-user e2e
 * 2026-09-27, B1). The worker holds no master key, so:
 *   - loading settings.json must not ask for one (that used to GENERATE a second
 *     key into <config>/master.key) and must drop sealed values quietly — they
 *     are unreadable by design there, not a fault;
 *   - saving a sensitive setting must be refused outright — neither sealed under
 *     a worker key nor written as plaintext.
 *
 * The filesystem is faked in-memory (same pattern as
 * config-secret-rotation.test.ts), so no real settings.json is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveMasterKey, sealSecret } from '$lib/server/crypto/secret-box.js';
import { IsolationWorkerKeyAccessError } from '$lib/server/tasks/isolation/isolation-context.js';

const { files, resolveMasterKey } = vi.hoisted(() => ({
    files: new Map<string, string>(),
    resolveMasterKey: vi.fn(() => 'a'.repeat(64)),
}));

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

vi.mock('$lib/server/crypto/master-key.js', () => ({ resolveMasterKey }));

vi.mock('$lib/server/tasks/isolation/isolation-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/tasks/isolation/isolation-context.js')>();
    return { ...actual, isIsolationWorker: () => true };
});

const KEY_A = deriveMasterKey('a'.repeat(64));

const { initConfigServiceSync, getConfigFilePath, getUndecryptableConfigKeys, saveConfig, get } =
    await import('./config.service.js');

describe('config service inside a plugin-isolation worker', () => {
    beforeEach(() => {
        files.clear();
        resolveMasterKey.mockClear();
    });

    it('loads settings without resolving a master key, dropping sealed values quietly', () => {
        files.set(
            getConfigFilePath(),
            JSON.stringify({
                TMDB_API_KEY: sealSecret('tmdb-secret', KEY_A, 'settings.json:TMDB_API_KEY'),
            }) + '\n',
        );
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        initConfigServiceSync({});

        expect(resolveMasterKey).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(getUndecryptableConfigKeys()).toEqual([]);
        // The sealed value is NOT opened in the worker (the key never enters it).
        expect(get('TMDB_API_KEY')).not.toBe('tmdb-secret');
        errorSpy.mockRestore();
    });

    it('still sees a secret the main thread hands it through the env', () => {
        files.set(
            getConfigFilePath(),
            JSON.stringify({
                TMDB_API_KEY: sealSecret('tmdb-secret', KEY_A, 'settings.json:TMDB_API_KEY'),
            }) + '\n',
        );

        initConfigServiceSync({ TMDB_API_KEY: 'mirrored-by-main' });

        expect(get('TMDB_API_KEY')).toBe('mirrored-by-main');
        expect(resolveMasterKey).not.toHaveBeenCalled();
    });

    it('refuses to save a sensitive setting and leaves settings.json untouched', async () => {
        const path = getConfigFilePath();
        const before = JSON.stringify({ SITE_NAME: 'Lumastra' }) + '\n';
        files.set(path, before);
        initConfigServiceSync({});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(saveConfig({ TMDB_API_KEY: 'new-secret' })).rejects.toBeInstanceOf(
            IsolationWorkerKeyAccessError,
        );

        expect(files.get(path)).toBe(before);
        expect(resolveMasterKey).not.toHaveBeenCalled();
        // No "Storing … in plaintext" fallback either.
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('plaintext'));
        warnSpy.mockRestore();
    });
});
