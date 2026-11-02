// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Master-key resolution vs the plugin-isolation boundary (Windows new-user e2e
 * 2026-09-27, B1): inside an isolation worker `resolveMasterKey()` must throw —
 * never read `<config>/master.key`, never generate one — and the main process
 * must name an env-key / file-key conflict at startup.
 *
 * Each test re-imports master-key.ts (vi.resetModules) because it memoizes the
 * resolved key for the process lifetime.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isolation = vi.hoisted(() => ({ worker: false }));

vi.mock('../tasks/isolation/isolation-context.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../tasks/isolation/isolation-context.js')>();
    return { ...actual, isIsolationWorker: () => isolation.worker };
});

const ENV_KEY = 'a'.repeat(64);
const FILE_KEY = 'b'.repeat(64);

let dir: string;
const savedEnv = {
    LUMASTRA_MASTER_KEY: process.env.LUMASTRA_MASTER_KEY,
    CONFIG_DIR: process.env.CONFIG_DIR,
    CONFIG_PATH: process.env.CONFIG_PATH,
};

async function loadMasterKey() {
    vi.resetModules();
    return import('./master-key.js');
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'master-key-test-'));
    delete process.env.CONFIG_PATH;
    process.env.CONFIG_DIR = dir;
    delete process.env.LUMASTRA_MASTER_KEY;
    isolation.worker = false;
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

describe('resolveMasterKey inside a plugin-isolation worker', () => {
    it('throws and does NOT generate master.key when neither env nor file exists', async () => {
        isolation.worker = true;
        const mk = await loadMasterKey();
        const { IsolationWorkerKeyAccessError } =
            await import('../tasks/isolation/isolation-context.js');

        expect(() => mk.resolveMasterKey()).toThrow(IsolationWorkerKeyAccessError);
        expect(existsSync(join(dir, 'master.key'))).toBe(false);
        expect(process.env.LUMASTRA_MASTER_KEY).toBeUndefined();
    });

    it('throws instead of reading an existing master.key (boundary on file-key installs)', async () => {
        writeFileSync(join(dir, 'master.key'), FILE_KEY + '\n');
        isolation.worker = true;
        const mk = await loadMasterKey();

        expect(() => mk.resolveMasterKey()).toThrow(/isolation worker/);
        expect(process.env.LUMASTRA_MASTER_KEY).toBeUndefined();
    });

    it('throws even when an env key is somehow present in the worker', async () => {
        process.env.LUMASTRA_MASTER_KEY = ENV_KEY;
        isolation.worker = true;
        const mk = await loadMasterKey();

        expect(() => mk.resolveMasterKey()).toThrow(/isolation worker/);
    });

    it('control: the main thread still generates master.key on first use', async () => {
        const mk = await loadMasterKey();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const key = mk.resolveMasterKey();

        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(readFileSync(join(dir, 'master.key'), 'utf8').trim()).toBe(key);
        expect(mk.getMasterKeySource()).toBe('generated');
        warn.mockRestore();
    });
});

describe('warnIfMasterKeyFileConflicts (startup check)', () => {
    it('warns once when the env key and master.key differ, naming digests but no key material', async () => {
        writeFileSync(join(dir, 'master.key'), FILE_KEY + '\n');
        process.env.LUMASTRA_MASTER_KEY = ENV_KEY;
        const mk = await loadMasterKey();
        const warn = vi.fn();

        const conflict = mk.warnIfMasterKeyFileConflicts(warn);

        expect(conflict).not.toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        const msg = String(warn.mock.calls[0][0]);
        expect(msg).toContain(join(dir, 'master.key'));
        expect(msg).toContain('ENVIRONMENT key is in effect');
        expect(msg).toContain(conflict!.envDigest);
        expect(msg).toContain(conflict!.fileDigest);
        expect(conflict!.envDigest).not.toBe(conflict!.fileDigest);
        expect(msg).not.toContain(ENV_KEY);
        expect(msg).not.toContain(FILE_KEY);
        // Never auto-deletes or rewrites the file.
        expect(readFileSync(join(dir, 'master.key'), 'utf8')).toBe(FILE_KEY + '\n');
    });

    it('stays silent when both hold the same key', async () => {
        writeFileSync(join(dir, 'master.key'), ENV_KEY + '\n');
        process.env.LUMASTRA_MASTER_KEY = ENV_KEY;
        const mk = await loadMasterKey();
        const warn = vi.fn();

        expect(mk.warnIfMasterKeyFileConflicts(warn)).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });

    it('stays silent without an env key, or without a file', async () => {
        const warn = vi.fn();

        writeFileSync(join(dir, 'master.key'), FILE_KEY + '\n');
        let mk = await loadMasterKey();
        expect(mk.warnIfMasterKeyFileConflicts(warn)).toBeNull();

        rmSync(join(dir, 'master.key'));
        process.env.LUMASTRA_MASTER_KEY = ENV_KEY;
        mk = await loadMasterKey();
        expect(mk.warnIfMasterKeyFileConflicts(warn)).toBeNull();

        expect(warn).not.toHaveBeenCalled();
    });

    it('does not read the file inside an isolation worker', async () => {
        writeFileSync(join(dir, 'master.key'), FILE_KEY + '\n');
        process.env.LUMASTRA_MASTER_KEY = ENV_KEY;
        isolation.worker = true;
        const mk = await loadMasterKey();
        const warn = vi.fn();

        expect(mk.warnIfMasterKeyFileConflicts(warn)).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('durable master-key backup state', () => {
    it('survives a restart and another replica resolving the key from its environment', async () => {
        let mk = await loadMasterKey();
        const key = mk.resolveMasterKey();
        const fingerprint = mk.getMasterKeyFingerprint();
        expect(mk.getMasterKeyBackupState()).toEqual({ fingerprint, hasSealedSecrets: false });
        const marker = join(dir, `master.key.backup-${fingerprint}`);
        expect(readFileSync(marker, 'utf8')).not.toContain(key);
        delete process.env.LUMASTRA_MASTER_KEY;
        mk = await loadMasterKey();
        mk.resolveMasterKey();
        expect(mk.getMasterKeySource()).toBe('file');
        expect(mk.getMasterKeyBackupState()).toEqual({ fingerprint, hasSealedSecrets: false });
        // Like a worker inheriting the main process's back-filled environment.
        mk = await loadMasterKey();
        mk.resolveMasterKey();
        expect(mk.getMasterKeySource()).toBe('env');
        expect(mk.getMasterKeyBackupState()).toEqual({ fingerprint, hasSealedSecrets: false });
    });

    it.each(['envelope', 'blob'] as const)(
        'persists first use through %s sealing, only for this key',
        async (kind) => {
            let mk = await loadMasterKey();
            const key = mk.resolveMasterKey();
            const crypto = await import('./secret-box.js');
            const seal = kind === 'envelope' ? crypto.sealSecret : crypto.encrypt;
            seal('unrelated credential', crypto.deriveMasterKey(FILE_KEY), 'test:other');
            expect(mk.getMasterKeyBackupState()?.hasSealedSecrets).toBe(false);
            seal('stored credential', crypto.deriveMasterKey(key), 'test:credential');
            expect(mk.getMasterKeyBackupState()?.hasSealedSecrets).toBe(true);
            delete process.env.LUMASTRA_MASTER_KEY;
            mk = await loadMasterKey();
            expect(mk.getMasterKeyBackupState()?.hasSealedSecrets).toBe(true);
        },
    );

    it('starts a new unused generation if the key is lost, ignoring the old usage marker', async () => {
        let mk = await loadMasterKey();
        const oldKey = mk.resolveMasterKey();
        const crypto = await import('./secret-box.js');
        crypto.sealSecret('credential', crypto.deriveMasterKey(oldKey), 'test:credential');
        const oldState = mk.getMasterKeyBackupState();
        rmSync(join(dir, 'master.key'));
        delete process.env.LUMASTRA_MASTER_KEY;
        mk = await loadMasterKey();
        expect(mk.getMasterKeyBackupState()).toMatchObject({ hasSealedSecrets: false });
        expect(mk.getMasterKeyBackupState()?.fingerprint).not.toBe(oldState?.fingerprint);
    });

    it('does not create backup metadata for an explicit environment key or an isolation worker', async () => {
        process.env.LUMASTRA_MASTER_KEY = ENV_KEY;
        let mk = await loadMasterKey();
        expect(mk.getMasterKeyBackupState()).toBeNull();
        isolation.worker = true;
        mk = await loadMasterKey();
        expect(mk.getMasterKeyBackupState()).toBeNull();
        expect(existsSync(join(dir, 'master.key'))).toBe(false);
    });
});
