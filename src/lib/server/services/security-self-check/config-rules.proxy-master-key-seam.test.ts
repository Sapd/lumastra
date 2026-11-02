// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C25 — seam test: `checkProxyMasterKeyEnv()` must still warn AFTER
 * `resolveMasterKey()` has already run and back-filled
 * `process.env.LUMASTRA_MASTER_KEY` (crypto/master-key.ts:137,153,162).
 *
 * `config-rules.test.ts` mocks the whole rule surface, including (as of C25)
 * `crypto/master-key.js`'s `getMasterKeySource()` — good for proving the
 * rule's own branching, but it can't catch a regression where the real
 * `master-key.ts` and the real rule disagree. This file exercises BOTH real
 * modules together against a real temp `CONFIG_DIR`, per the task-11 brief's
 * prescribed reproduction: "point CONFIG_DIR at a temp dir, call
 * resolveMasterKey() first, then assert checkProxyMasterKeyEnv still warns."
 *
 * Before the C25 fix this was RED: the rule read `process.env` directly, and
 * `resolveMasterKey()`'s env back-fill made an auto-generated key
 * indistinguishable from an operator-set one.
 *
 * `master-key.ts` caches its result (and, since C25, its source) for the
 * "process lifetime" by design — module-level `_cached`/`_source` variables.
 * Each test below gets a FRESH module instance (`vi.resetModules()` + a
 * dynamic import) so that cache can't leak between the "generated" and "env"
 * scenarios, or between test runs in this file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockConfig: Record<string, unknown> = {
    LIVETV_SOURCE: 'standalone',
    STREAM_PROXY_URL: 'http://lumastra-proxy:3000',
};

// Only $lib/server/config and its two small dependents need mocking here —
// crypto/master-key.js is deliberately left REAL for this file; that's the
// whole point of the seam.
vi.mock('$lib/server/config', () => ({
    config: mockConfig,
    devFeaturesEnabled: false,
    features: {},
}));
vi.mock('$lib/server/config/config.service', () => ({
    getUndecryptableConfigKeys: () => [],
    get: () => undefined,
}));
vi.mock('$lib/server/utils/client-ip', () => ({
    forwardAuthTrustPosture: vi.fn(() => 'allowlist' as const),
}));

let tempDir: string;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'master-key-seam-'));
    process.env.CONFIG_DIR = tempDir;
    delete process.env.CONFIG_PATH;
    delete process.env.LUMASTRA_MASTER_KEY;
    mockConfig.LIVETV_SOURCE = 'standalone';
    mockConfig.STREAM_PROXY_URL = 'http://lumastra-proxy:3000';
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
});

describe('checkProxyMasterKeyEnv + resolveMasterKey (C25 seam)', () => {
    it('still warns after resolveMasterKey() auto-generates and back-fills the env var', async () => {
        const { resolveMasterKey } = await import('$lib/server/crypto/master-key.js');
        const { checkProxyMasterKeyEnv } = await import('./config-rules');

        // No LUMASTRA_MASTER_KEY and no existing master.key file in the fresh
        // temp CONFIG_DIR — this forces the "generate a new key" branch,
        // which is exactly what back-fills process.env.LUMASTRA_MASTER_KEY.
        const key = resolveMasterKey();
        expect(key).toHaveLength(64); // 32 random bytes as hex
        expect(process.env.LUMASTRA_MASTER_KEY).toBe(key); // the back-fill fired

        const result = checkProxyMasterKeyEnv();
        expect(result.id).toBe('proxy.master-key-not-explicit');
        expect(result.status).toBe('warn');
    });

    it('still warns after resolveMasterKey() reads a pre-existing key FILE (peer-generated)', async () => {
        const { resolveMasterKey, getMasterKeyFilePath } =
            await import('$lib/server/crypto/master-key.js');
        const { writeFileSync } = await import('node:fs');
        writeFileSync(getMasterKeyFilePath(), `${'b'.repeat(64)}\n`, { mode: 0o600 });

        resolveMasterKey();
        expect(process.env.LUMASTRA_MASTER_KEY).toBe('b'.repeat(64));

        const { checkProxyMasterKeyEnv } = await import('./config-rules');
        const result = checkProxyMasterKeyEnv();
        expect(result.status).toBe('warn');
    });

    it('passes when LUMASTRA_MASTER_KEY really was set by the operator before resolution', async () => {
        process.env.LUMASTRA_MASTER_KEY = 'a'.repeat(64);
        const { resolveMasterKey } = await import('$lib/server/crypto/master-key.js');
        const { checkProxyMasterKeyEnv } = await import('./config-rules');

        resolveMasterKey();

        const result = checkProxyMasterKeyEnv();
        expect(result.status).toBe('pass');
    });
});
