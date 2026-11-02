// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    safeStat,
    safeStatBigInt,
    safeExists,
    safeReaddir,
    withFsGuard,
    FsTimeoutError,
    fsGuardStats,
    safeWriteFile,
    safeMkdir,
    safeRename,
    safeUnlink,
    safeRm,
    safeCp,
    safeAccess,
} from './safe-fs.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

describe('safe-fs', () => {
    it('stats an existing file and reports it', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'safefs-'));
        try {
            const f = join(dir, 'a.txt');
            await writeFile(f, 'hi');
            const st = await safeStat(f);
            expect(st.isFile()).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('returns precise bigint identity through the guard', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'safefs-identity-'));
        try {
            const file = join(dir, 'media');
            await writeFile(file, 'data');
            const identity = await safeStatBigInt(file);
            expect(typeof identity.ino).toBe('bigint');
            expect(typeof identity.mtimeNs).toBe('bigint');
            expect(identity.size).toBe(4n);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it('removes an aborted queued waiter without starting abandoned FS work', async () => {
        const { maxConcurrency } = fsGuardStats();
        const release: Array<() => void> = [];
        const holders = Array.from({ length: maxConcurrency }, () =>
            withFsGuard(
                () => new Promise<void>((resolve) => release.push(resolve)),
                'hold',
                '/hold',
                60_000,
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        const controller = new AbortController();
        let started = false;
        const queued = withFsGuard(
            async () => {
                started = true;
            },
            'queued',
            '/queued',
            60_000,
            controller.signal,
        );
        expect(fsGuardStats().waiting).toBe(1);
        controller.abort();
        await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
        expect(fsGuardStats().waiting).toBe(0);
        release.forEach((resolve) => resolve());
        await Promise.all(holders);
        expect(started).toBe(false);
    });

    it('safeExists returns true/false without throwing', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'safefs-'));
        try {
            const f = join(dir, 'present.txt');
            await writeFile(f, 'x');
            expect(await safeExists(f)).toBe(true);
            expect(await safeExists(join(dir, 'missing.txt'))).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('safeReaddir lists entries (withFileTypes)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'safefs-'));
        try {
            await writeFile(join(dir, 'one'), '1');
            await writeFile(join(dir, 'two'), '2');
            const entries = await safeReaddir(dir);
            expect(entries.map((e) => e.name).sort()).toEqual(['one', 'two']);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('rejects the caller on timeout but holds the permit until the slow op settles', async () => {
        let resolveSlow: () => void = () => {};
        const slow = new Promise<void>((r) => {
            resolveSlow = r;
        });
        const before = fsGuardStats().inFlight;
        const guarded = withFsGuard(() => slow, 'test', '/slow/path', 20);

        // Caller fails fast with a timeout...
        await expect(guarded).rejects.toBeInstanceOf(FsTimeoutError);
        // ...but the permit is STILL held — the underlying op hasn't returned, so
        // its threadpool thread is still occupied and must stay counted.
        expect(fsGuardStats().inFlight).toBe(before + 1);

        // When the real op finally settles, the permit is released.
        resolveSlow();
        await slow;
        await Promise.resolve(); // let the release microtask run
        expect(fsGuardStats().inFlight).toBe(before);
    });

    it('releases the permit when the factory throws synchronously', async () => {
        const before = fsGuardStats().inFlight;
        await expect(
            withFsGuard<never>(
                () => {
                    throw new Error('boom');
                },
                'test',
                '/x',
                1000,
            ),
        ).rejects.toThrow('boom');
        expect(fsGuardStats().inFlight).toBe(before);
    });

    it('times out a caller waiting on a saturated pool instead of hanging forever', async () => {
        const { maxConcurrency } = fsGuardStats();
        const releasers: Array<() => void> = [];
        // Saturate every permit with ops that never settle on their own.
        const hung = Array.from({ length: maxConcurrency }, () => {
            const p = new Promise<void>((r) => releasers.push(r));
            // long timeout so these don't reject during the test window
            return withFsGuard(() => p, 'hung', '/hung', 60_000).catch(() => {});
        });
        try {
            // A further caller cannot acquire a permit — it must time out, not wedge.
            await expect(
                withFsGuard(() => Promise.resolve(1), 'queued', '/q', 30),
            ).rejects.toBeInstanceOf(FsTimeoutError);
        } finally {
            releasers.forEach((r) => r());
            await Promise.all(hung);
        }
    });

    it('caps in-flight ops at maxConcurrency and parks the overflow (F1 threadpool-starvation guard)', async () => {
        // The core invariant behind the fs-wedge fix: no matter how many guarded
        // ops are launched at once, at most `maxConcurrency` occupy a libuv
        // threadpool slot; the rest wait in JS. That reservation is what keeps
        // getaddrinfo (DNS) + Postgres/Valkey connects alive on a dead NFS mount
        // instead of starving into CONNECT_TIMEOUT. This asserts it directly.
        const { maxConcurrency } = fsGuardStats();
        const releasers: Array<() => void> = [];
        const overflow = 5;
        const ops = Array.from({ length: maxConcurrency + overflow }, () => {
            const p = new Promise<void>((r) => releasers.push(r));
            return withFsGuard(() => p, 'hung', '/hung', 60_000).catch(() => {});
        });
        try {
            // Let the semaphore grant every permit it can before sampling.
            await new Promise((r) => setTimeout(r, 5));
            const stats = fsGuardStats();
            expect(stats.inFlight).toBe(maxConcurrency);
            expect(stats.waiting).toBe(overflow);
        } finally {
            releasers.forEach((r) => r());
            await Promise.all(ops);
        }
    });

    it('exposes guard stats and returns to fully-available at rest', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'safefs-'));
        try {
            await writeFile(join(dir, 'f'), 'x');
            await safeStat(join(dir, 'f'));
            // After the op settles the permit is released — in-flight returns to 0.
            const stats = fsGuardStats();
            expect(stats.inFlight).toBe(0);
            expect(stats.maxConcurrency).toBeGreaterThanOrEqual(1);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('write→rename→unlink→mkdir round-trip on a temp dir (write-side primitives)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'safefs-'));
        try {
            const original = join(dir, 'original.txt');
            const renamed = join(dir, 'renamed.txt');
            const subdir = join(dir, 'nested', 'child');

            await safeWriteFile(original, 'hello world');
            expect((await readFile(original, 'utf8')).toString()).toBe('hello world');

            await safeRename(original, renamed);
            expect((await readFile(renamed, 'utf8')).toString()).toBe('hello world');
            await expect(safeStat(original)).rejects.toThrow();

            await safeUnlink(renamed);
            await expect(safeStat(renamed)).rejects.toThrow();

            const created = await safeMkdir(subdir, { recursive: true });
            expect(typeof created === 'string' || created === undefined).toBe(true);
            const st = await safeStat(subdir);
            expect(st.isDirectory()).toBe(true);

            // safeCp + safeAccess + safeRm round out the write-side surface.
            const copySrc = join(dir, 'copy-src.txt');
            const copyDest = join(dir, 'copy-dest.txt');
            await safeWriteFile(copySrc, 'copy me');
            await safeCp(copySrc, copyDest);
            expect((await readFile(copyDest, 'utf8')).toString()).toBe('copy me');
            await expect(safeAccess(copyDest, fsConstants.F_OK)).resolves.toBeUndefined();

            await safeRm(subdir, { recursive: true, force: true });
            await expect(safeStat(subdir)).rejects.toThrow();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('a write op consumes a permit and rejects with FsTimeoutError, holding the permit until the underlying op settles', async () => {
        // Mirrors the read-side "holds the permit until the slow op settles" test
        // above: drive withFsGuard directly with a fake slow factory (op label
        // 'writeFile') rather than mocking node:fs/promises — safeWriteFile always
        // wires the real fsWriteFile, so injecting a controllable slow write means
        // exercising the shared guard the same way the existing test does.
        let resolveSlow: () => void = () => {};
        const slow = new Promise<void>((r) => {
            resolveSlow = r;
        });
        const before = fsGuardStats().inFlight;
        const guarded = withFsGuard(() => slow, 'writeFile', '/slow/write-path', 20);

        await expect(guarded).rejects.toBeInstanceOf(FsTimeoutError);
        // The permit is still held — the underlying write hasn't settled.
        expect(fsGuardStats().inFlight).toBe(before + 1);

        resolveSlow();
        await slow;
        await Promise.resolve();
        expect(fsGuardStats().inFlight).toBe(before);
    });
});
