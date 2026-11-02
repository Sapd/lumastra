// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string | undefined;
afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
});

it('recognizes a secret sealed before backup tracking was installed when config opens it', async () => {
    vi.resetModules();
    dir = mkdtempSync(join(tmpdir(), 'master-key-backup-upgrade-'));
    vi.stubEnv('CONFIG_DIR', dir);
    vi.stubEnv('CONFIG_PATH', '');
    vi.stubEnv('LUMASTRA_MASTER_KEY', '');
    const key = 'b'.repeat(64);
    writeFileSync(join(dir, 'master.key'), key + '\n');
    const crypto = await import('./secret-box.js');
    // This ciphertext predates the resolver's observer, like an existing install.
    const sealed = crypto.sealSecret(
        'stored credential',
        crypto.deriveMasterKey(key),
        'settings.json:TMDB_API_KEY',
    );
    const mk = await import('./master-key.js');
    mk.resolveMasterKey();
    crypto.openSecret(sealed, crypto.deriveMasterKey(key), 'settings.json:TMDB_API_KEY');
    expect(mk.getMasterKeyBackupState()?.hasSealedSecrets).toBe(true);
});
