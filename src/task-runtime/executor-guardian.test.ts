// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownedExecutorDirectoryRefusal } from './executor-guardian.js';

const created: string[] = [];
afterEach(async () => {
    for (const entry of created.splice(0)) await rm(entry, { recursive: true, force: true });
});

describe('guardian directory cleanup guard', () => {
    it('accepts the private lx- directory the supervisor creates', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'lx-'));
        created.push(directory);
        await chmod(directory, 0o700);
        expect(await ownedExecutorDirectoryRefusal(directory, tmpdir())).toBeUndefined();
    });
    it('refuses directories that are not lx- children of tmpdir', async () => {
        const wrongName = await mkdtemp(path.join(tmpdir(), 'other-'));
        created.push(wrongName);
        await chmod(wrongName, 0o700);
        expect(await ownedExecutorDirectoryRefusal(wrongName, tmpdir())).toBeDefined();
        const parent = await mkdtemp(path.join(tmpdir(), 'lx-'));
        created.push(parent);
        const nested = path.join(parent, 'lx-nested');
        await mkdir(nested, { mode: 0o700 });
        expect(await ownedExecutorDirectoryRefusal(nested, tmpdir())).toBeDefined();
        expect(await ownedExecutorDirectoryRefusal('/', tmpdir())).toBeDefined();
        expect(
            await ownedExecutorDirectoryRefusal(path.join(tmpdir(), '..'), tmpdir()),
        ).toBeDefined();
    });
    it('refuses symlinks and loose permissions', async () => {
        const target = await mkdtemp(path.join(tmpdir(), 'target-'));
        created.push(target);
        const link = path.join(tmpdir(), `lx-link-${path.basename(target)}`);
        await symlink(target, link);
        created.push(link);
        expect(await ownedExecutorDirectoryRefusal(link, tmpdir())).toBeDefined();
        const loose = await mkdtemp(path.join(tmpdir(), 'lx-'));
        created.push(loose);
        await chmod(loose, 0o755);
        expect(await ownedExecutorDirectoryRefusal(loose, tmpdir())).toBeDefined();
    });
    it('compares against the supervisor-supplied base, not the guardian own tmpdir', async () => {
        const base = await mkdtemp(path.join(tmpdir(), 'custom-tmp-'));
        created.push(base);
        const directory = path.join(base, 'lx-abc');
        await mkdir(directory, { mode: 0o700 });
        expect(await ownedExecutorDirectoryRefusal(directory, base)).toBeUndefined();
        // The same directory is refused when the expected base is a different one.
        expect(await ownedExecutorDirectoryRefusal(directory, tmpdir())).toBeDefined();
        // Base must be absolute; a relative one is refused.
        expect(await ownedExecutorDirectoryRefusal(directory, 'relative/base')).toBeDefined();
        // A symlinked alias of the base still resolves to the same real location.
        const alias = path.join(tmpdir(), `alias-${path.basename(base)}`);
        await symlink(base, alias);
        created.push(alias);
        expect(await ownedExecutorDirectoryRefusal(directory, alias)).toBeUndefined();
    });
});
