// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashLocalArtworkFile } from './local-artwork-content-hash.js';
import { ContainmentError, DEFAULT_CONTAINED_READ_MAX_BYTES } from './contained-fs.js';

vi.mock('../database/connection.js', () => ({ getDb: () => null }));

let root: string;
let outside: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'artwork-hash-'));
    outside = await mkdtemp(join(tmpdir(), 'artwork-hash-outside-'));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
});

describe('hashLocalArtworkFile', () => {
    it('fingerprints exact binary bytes and notices replacement at the same path', async () => {
        const file = join(root, 'poster.png');
        await writeFile(file, Buffer.from([0, 255, 128, 195, 40, 0, 10]));
        expect(await hashLocalArtworkFile(file)).toBe(
            'e8105ca40704be81eb1f0eb3d20809295801c9ff4f8fe7994e22e5201969baba',
        );
        await writeFile(file, Buffer.from([255, 0, 129, 195, 40, 0, 10]));
        expect(await hashLocalArtworkFile(file)).toBe(
            'd902d2245ae5f6ae59f898abd0a215a85ee78568d301582a06ce86b5687d1bea',
        );
    });

    it('accepts the existing 32 MiB boundary and refuses a file one byte larger', async () => {
        expect(DEFAULT_CONTAINED_READ_MAX_BYTES).toBe(32 * 1024 * 1024);
        const file = join(root, 'large.png');
        const handle = await open(file, 'w');
        try {
            await handle.truncate(DEFAULT_CONTAINED_READ_MAX_BYTES);
            expect(await hashLocalArtworkFile(file)).toMatch(/^[0-9a-f]{64}$/);
            await handle.truncate(DEFAULT_CONTAINED_READ_MAX_BYTES + 1);
            await expect(hashLocalArtworkFile(file)).rejects.toMatchObject({
                code: 'ECONTAINMENT',
                kind: 'too_large',
            });
        } finally {
            await handle.close();
        }
    });

    it('forwards allowed roots for local links and refuses an escaping link', async () => {
        const file = join(root, 'poster.png');
        const bytes = Buffer.from([0, 255, 128, 195, 40, 0, 10]);
        await writeFile(file, bytes);
        const allowed = join(root, 'allowed.png');
        await symlink(file, allowed);
        expect(await hashLocalArtworkFile(allowed, [root])).toBe(await hashLocalArtworkFile(file));
        const secret = join(outside, 'secret.png');
        await writeFile(secret, bytes);
        const escaped = join(root, 'escaped.png');
        await symlink(secret, escaped);
        await expect(hashLocalArtworkFile(escaped, [root])).rejects.toBeInstanceOf(
            ContainmentError,
        );
    });

    it('propagates missing-file errors to the scanner unmeasured fallback', async () => {
        await expect(hashLocalArtworkFile(join(root, 'missing.png'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });
});
