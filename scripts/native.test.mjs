// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('native build explains a missing Rust toolchain and exits 1', () => {
    const result = spawnSync(process.execPath, ['scripts/native.mjs', 'build', 'watcher'], {
        cwd: root,
        env: { ...process.env, PATH: '' },
        encoding: 'utf8',
        timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(
        result.stderr.trim(),
        'Rust toolchain required: install rustup, then the pinned toolchain (see native/rust-toolchain.toml)',
    );
});
