// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the folder-picker's pure core, `listBrowseEntries`. Runs
 * against REAL temp directories (no DB, no mocking of fs) so the
 * realpath-confinement logic — the security-relevant part — is exercised
 * exactly as it runs in production. `allowedRoots` is passed in directly
 * rather than resolved from `LIBRARY_MOUNT_ROOTS`/the database, which is what
 * lets this test point at a tmp directory instead of `/data`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBrowseEntries } from './library-browse.service.js';

let root: string;
let outside: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lumastra-browse-root-'));
    outside = await mkdtemp(join(tmpdir(), 'lumastra-browse-outside-'));

    // Names deliberately don't describe a media type — this is security logic,
    // not classification logic, and must not be exercised through anything
    // that looks like a real library layout.
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, 'zulu'));
    await writeFile(join(root, 'a-file.txt'), 'not a directory');
    await mkdir(join(outside, 'escaped'));
    await symlink(outside, join(root, 'link-out'));
    await symlink(join(root, 'alpha'), join(root, 'link-in'));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
});

describe('listBrowseEntries', () => {
    it('lists only subdirectories, never files', async () => {
        const result = await listBrowseEntries(root, [root]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const names = result.entries.map((e) => e.name).sort();
        expect(names).not.toContain('a-file.txt');
        expect(names).toContain('alpha');
        expect(names).toContain('zulu');
    });

    it('lists the allowed roots that exist when path is omitted', async () => {
        const result = await listBrowseEntries(undefined, [root, join(outside, 'nope')]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.path).toBeNull();
        expect(result.entries.map((e) => e.path)).toEqual([root]);
    });

    it('rejects a relative path with 400', async () => {
        const result = await listBrowseEntries('relative/path', [root]);
        expect(result).toEqual({
            ok: false,
            status: 400,
            message: expect.any(String),
        });
    });

    it('answers a MISSING path outside the roots exactly like an existing one (403)', async () => {
        // Otherwise 400-vs-403 turns the picker into an existence probe for any path.
        const missing = await listBrowseEntries(join(outside, 'does-not-exist'), [root]);
        const existing = await listBrowseEntries(outside, [root]);
        expect(missing).toEqual(existing);
        expect(missing).toMatchObject({ ok: false, status: 403 });
    });

    it('rejects a path outside every allowed root with 403', async () => {
        const result = await listBrowseEntries(outside, [root]);
        expect(result).toEqual({
            ok: false,
            status: 403,
            message: expect.any(String),
        });
    });

    it('rejects a `..` escape once resolved outside the root with 403', async () => {
        const escapeAttempt = join(root, '..', '..');
        const result = await listBrowseEntries(escapeAttempt, [root]);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        // Either it resolves somewhere real (403, outside every root) or fails
        // to resolve at all (400) — both are safe; a 200 would not be.
        expect([400, 403]).toContain(result.status);
    });

    it('rejects a symlink that escapes the allowed root', async () => {
        const result = await listBrowseEntries(root, [root]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.entries.map((e) => e.name)).not.toContain('link-out');
    });

    it('includes a symlink whose target stays under an allowed root', async () => {
        const result = await listBrowseEntries(root, [root]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.entries.map((e) => e.name)).toContain('link-in');
    });

    it('rejects a file path (not a directory) with 400', async () => {
        const result = await listBrowseEntries(join(root, 'a-file.txt'), [root]);
        expect(result).toEqual({
            ok: false,
            status: 400,
            message: expect.any(String),
        });
    });

    it('rejects a nonexistent path with 400, not a leaked existence check', async () => {
        const result = await listBrowseEntries(join(root, 'does-not-exist'), [root]);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.status).toBe(400);
    });
});
