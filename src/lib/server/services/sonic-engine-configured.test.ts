// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `isSonicEngineConfigured()` decides whether the sonic-embedding-backfill stage
 * applies to this install at all. A false negative tombstones a library that
 * could be embedded; a false positive brings back the stall it exists to stop
 * (every Docker install without the sidecar, since the app image ships neither
 * Python nor embed.py). Probed against real files, not mocks of `node:fs`.
 */

import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cfg = vi.hoisted(() => ({
    SONIC_EMBEDDER_URL: '',
    SONIC_EMBEDDER_PYTHON: 'python3',
    SONIC_EMBEDDER_SCRIPT: 'embed.py',
}));
vi.mock('$lib/server/config.js', () => ({ config: cfg }));

/**
 * The interpreter-side torch/msclap check (execFileSync); `modules.calls`
 * counts the spawns.
 */
const modules = vi.hoisted(() => ({ importable: true, calls: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        execFileSync: () => {
            modules.calls++;
            if (!modules.importable) throw new Error('Command failed: exit code 3');
            return Buffer.from('');
        },
    };
});
vi.mock('$lib/server/cache/valkey.js', () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }));

import {
    isSonicEngineConfigured,
    resetSonicEngineProbeForTests,
} from './sonic-embedding.service.js';

const dir = mkdtempSync(join(tmpdir(), 'sonic-engine-'));
const script = join(dir, 'embed.py');
writeFileSync(script, '# stub\n');

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    resetSonicEngineProbeForTests();
    modules.importable = true;
    modules.calls = 0;
    cfg.SONIC_EMBEDDER_URL = '';
    cfg.SONIC_EMBEDDER_PYTHON = process.execPath;
    cfg.SONIC_EMBEDDER_SCRIPT = script;
});

describe('isSonicEngineConfigured', () => {
    it('a sidecar URL is enough, even with no subprocess fallback installed', () => {
        cfg.SONIC_EMBEDDER_URL = 'http://sonic:8000';
        cfg.SONIC_EMBEDDER_SCRIPT = join(dir, 'missing.py');
        expect(isSonicEngineConfigured()).toBe(true);
    });

    it('no URL: true when the interpreter, the script and the packages are there', () => {
        expect(isSonicEngineConfigured()).toBe(true);
    });

    it('no URL, no script (the app image): false', () => {
        cfg.SONIC_EMBEDDER_SCRIPT = join(dir, 'missing.py');
        expect(isSonicEngineConfigured()).toBe(false);
    });

    it('no URL, interpreter not found: false', () => {
        cfg.SONIC_EMBEDDER_PYTHON = join(dir, 'no-such-python');
        expect(isSonicEngineConfigured()).toBe(false);
    });

    it('a bare interpreter name is looked up on PATH', () => {
        cfg.SONIC_EMBEDDER_PYTHON = 'definitely-not-a-binary-on-path-7f3a';
        expect(isSonicEngineConfigured()).toBe(false);
    });

    it('a bare interpreter name found on PATH counts', () => {
        const bin = join(dir, 'fake-python');
        writeFileSync(bin, '#!/bin/sh\n');
        chmodSync(bin, 0o755);
        const savedPath = process.env.PATH;
        process.env.PATH = `/nonexistent-dir:${dir}`;
        try {
            cfg.SONIC_EMBEDDER_PYTHON = 'fake-python';
            expect(isSonicEngineConfigured()).toBe(true);
        } finally {
            process.env.PATH = savedPath;
        }
    });

    it('a non-executable file is not an interpreter', () => {
        cfg.SONIC_EMBEDDER_PYTHON = script; // exists, mode 0644
        expect(isSonicEngineConfigured()).toBe(false);
    });

    it('re-probes when the configured paths change (live settings)', () => {
        cfg.SONIC_EMBEDDER_SCRIPT = join(dir, 'later.py');
        expect(isSonicEngineConfigured()).toBe(false);
        cfg.SONIC_EMBEDDER_SCRIPT = script;
        expect(isSonicEngineConfigured()).toBe(true);
    });

    it('an unreadable script is not installed', () => {
        const locked = join(dir, 'locked.py');
        writeFileSync(locked, '# stub\n');
        chmodSync(locked, 0o000);
        cfg.SONIC_EMBEDDER_SCRIPT = locked;
        // root reads anything, so only assert where permissions apply.
        expect(isSonicEngineConfigured()).toBe(process.getuid?.() === 0);
    });

    describe('answer reuse', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('a script installed under a running process is noticed after the TTL', () => {
            vi.useFakeTimers();
            const later = join(dir, 'installed-later.py');
            cfg.SONIC_EMBEDDER_SCRIPT = later;
            expect(isSonicEngineConfigured()).toBe(false);

            writeFileSync(later, '# stub\n');
            // Reused within the window: the sweep calls this every tick.
            expect(isSonicEngineConfigured()).toBe(false);
            vi.advanceTimersByTime(61_000);
            expect(isSonicEngineConfigured()).toBe(true);
        });

        it('a removed script is noticed after the TTL', () => {
            vi.useFakeTimers();
            const removed = join(dir, 'removed-later.py');
            writeFileSync(removed, '# stub\n');
            cfg.SONIC_EMBEDDER_SCRIPT = removed;
            expect(isSonicEngineConfigured()).toBe(true);

            rmSync(removed);
            vi.advanceTimersByTime(61_000);
            expect(isSonicEngineConfigured()).toBe(false);
        });
    });

    describe('torch/msclap importable by the interpreter', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('files present but the packages missing (a bare python3): false', () => {
            modules.importable = false;
            expect(isSonicEngineConfigured()).toBe(false);
        });

        it('checked once per setting, not on every sweep tick', () => {
            expect(isSonicEngineConfigured()).toBe(true);
            expect(isSonicEngineConfigured()).toBe(true);
            expect(modules.calls).toBe(1);
        });

        it('a failed check is retried after ten minutes (packages installed later)', () => {
            vi.useFakeTimers();
            modules.importable = false;
            expect(isSonicEngineConfigured()).toBe(false);

            modules.importable = true;
            vi.advanceTimersByTime(5 * 60_000);
            expect(isSonicEngineConfigured()).toBe(false);
            vi.advanceTimersByTime(5 * 60_000 + 1_000);
            expect(isSonicEngineConfigured()).toBe(true);
        });

        it('never spawned when a sidecar URL is set', () => {
            cfg.SONIC_EMBEDDER_URL = 'http://sonic:8000';
            expect(isSonicEngineConfigured()).toBe(true);
            expect(modules.calls).toBe(0);
        });
    });

    it('setting a URL later is seen immediately', () => {
        cfg.SONIC_EMBEDDER_SCRIPT = join(dir, 'missing.py');
        expect(isSonicEngineConfigured()).toBe(false);
        cfg.SONIC_EMBEDDER_URL = 'http://sonic:8000';
        expect(isSonicEngineConfigured()).toBe(true);
    });
});
