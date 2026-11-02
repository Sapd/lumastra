// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * config.ts inside a plugin-isolation worker (B1 follow-up, 2026-09-27).
 *
 * config.ts reads `config.JWT_SECRET` in its own startup check while the module
 * loads. With JWT_SECRET unset that getter derived the default from the master
 * key, and resolveMasterKey() throws in an isolation worker — so every isolated
 * task (intro analyzer, music analysis, trickplay, media-item tasks) died at
 * import with "The master key … is not available inside a plugin-isolation
 * worker". In a worker the derived default must be '' (consumers fail closed),
 * without ever asking for the master key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    worker: true,
    resolveMasterKey: vi.fn((): string => {
        throw new Error('resolveMasterKey must not be called in an isolation worker');
    }),
}));

vi.mock('./tasks/isolation/isolation-context.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./tasks/isolation/isolation-context.js')>();
    return { ...actual, isIsolationWorker: () => h.worker };
});
vi.mock('./crypto/master-key.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./crypto/master-key.js')>();
    return { ...actual, resolveMasterKey: h.resolveMasterKey };
});

const savedJwt = process.env.JWT_SECRET;

async function loadConfig() {
    vi.resetModules();
    return import('./config.js');
}

beforeEach(() => {
    delete process.env.JWT_SECRET;
    h.worker = true;
    h.resolveMasterKey.mockClear();
});

afterEach(() => {
    if (savedJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedJwt;
});

describe('config.ts in a plugin-isolation worker', () => {
    it('loads without asking for the master key; the derived JWT_SECRET is empty', async () => {
        const { config } = await loadConfig();

        expect(config.JWT_SECRET).toBe('');
        expect(h.resolveMasterKey).not.toHaveBeenCalled();
    });

    it('still returns an operator-set JWT_SECRET from the env', async () => {
        process.env.JWT_SECRET = 'x'.repeat(40);
        const { config } = await loadConfig();

        expect(config.JWT_SECRET).toBe('x'.repeat(40));
        expect(h.resolveMasterKey).not.toHaveBeenCalled();
    });

    it('control: on the main thread the default is derived from the master key', async () => {
        h.worker = false;
        h.resolveMasterKey.mockImplementation(() => 'a'.repeat(64));
        const { config } = await loadConfig();

        expect(config.JWT_SECRET).toMatch(/^[0-9a-f]{32,}$/);
        expect(h.resolveMasterKey).toHaveBeenCalled();
    });
});
