// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fault = vi.hoisted(() => ({ code: '', sealed: false }));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>): void => {
            const path = String(args[0]);
            if (
                fault.code &&
                path.includes('master.key.backup-') &&
                path.endsWith('.sealed') === fault.sealed
            ) {
                throw Object.assign(new Error(`Cannot write ${path}`), { code: fault.code });
            }
            actual.writeFileSync(...args);
        },
    };
});
vi.mock('$env/dynamic/private', () => {
    throw new Error('not in SvelteKit');
});
vi.mock('$lib/server/cache/valkey.js', () => ({ getCoordinationClient: () => null }));

let dir: string | undefined;

afterEach(() => {
    fault.code = '';
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe.each(['ENOENT', 'EACCES'])('unavailable master-key backup metadata (%s)', (code) => {
    it.each([false, true])(
        'keeps settings load/reload/save working when the sealed marker is %s',
        async (sealed) => {
            vi.resetModules();
            dir = mkdtempSync(join(tmpdir(), 'config-backup-failure-'));
            const file = join(dir, 'settings.json');
            vi.stubEnv('CONFIG_PATH', file);
            vi.stubEnv('LUMASTRA_MASTER_KEY', '');
            // Preserve process.env values that config mirrors during this test.
            vi.stubEnv('APP_NAME', process.env.APP_NAME);
            vi.stubEnv('TMDB_API_KEY', process.env.TMDB_API_KEY);
            const key = 'b'.repeat(64);
            writeFileSync(join(dir, 'master.key'), key + '\n');
            const crypto = await import('../crypto/secret-box.js');
            const credential = '1'.repeat(32);
            writeFileSync(
                file,
                JSON.stringify({
                    APP_NAME: 'Saved Name',
                    TMDB_API_KEY: crypto.sealSecret(
                        credential,
                        crypto.deriveMasterKey(key),
                        'settings.json:TMDB_API_KEY',
                    ),
                }),
            );
            fault.code = code;
            fault.sealed = sealed;
            const error = vi.spyOn(console, 'error').mockImplementation(() => {});
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const config = await import('./config.service.js');
            const mk = await import('../crypto/master-key.js');

            config.initConfigServiceSync({});
            expect(config.get('APP_NAME')).toBe('Saved Name');
            expect(config.get('TMDB_API_KEY')).toBe(credential);
            expect(mk.getMasterKeySource()).toBe('file');
            await config.reloadConfig();
            expect(config.get('TMDB_API_KEY')).toBe(credential);

            const replacement = '2'.repeat(32);
            await config.saveConfig({ APP_NAME: 'Updated Name', TMDB_API_KEY: replacement });
            const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
            expect(stored.APP_NAME).toBe('Updated Name');
            expect(stored.TMDB_API_KEY).toMatch(/^enc:v2:/);
            expect(
                crypto.openSecret(
                    stored.TMDB_API_KEY,
                    crypto.deriveMasterKey(key),
                    'settings.json:TMDB_API_KEY',
                ),
            ).toBe(replacement);
            await config.reloadConfig();
            expect(config.get('APP_NAME')).toBe('Updated Name');
            expect(config.get('TMDB_API_KEY')).toBe(replacement);
            expect(config.getUndecryptableConfigKeys()).toEqual([]);
            expect(error).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('master.key.backup-'));

            if (sealed) {
                expect(mk.getMasterKeyBackupState()?.hasSealedSecrets).toBe(false);
                // A failed metadata write must remain retryable after recovery.
                fault.code = '';
                await config.saveConfig({ TMDB_API_KEY: credential });
                expect(mk.getMasterKeyBackupState()?.hasSealedSecrets).toBe(true);
            }
        },
    );
});
