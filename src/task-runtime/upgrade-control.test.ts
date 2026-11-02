// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('$lib/server/utils/logger.js', () => {
    const record = (...args: unknown[]): void => {
        logged.lines.push(JSON.stringify(args));
    };
    return {
        Logger: { for: () => ({ info: record, warn: record, error: record, debug: record }) },
    };
});

import {
    getUpgradeState,
    parsePreparedTimeoutMs,
    requestUpgrade,
    startUpgradeControl,
} from './upgrade-control.js';

afterEach(() => {
    vi.useRealTimers();
    logged.lines.length = 0;
});

it('serves private operator receipts, coalesces prepares and restores explicitly', async () => {
    let finish: (result: { prepared: boolean }) => void = () => {};
    const prepare = vi.fn(
        () =>
            new Promise<{ prepared: boolean }>((resolve) => {
                finish = resolve;
            }),
    );
    const resume = vi.fn(async () => {});
    const server = await startUpgradeControl({ prepare, resume });
    try {
        expect((await stat(dirname(server.socketPath))).mode & 0o777).toBe(0o700);
        expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
        const first = requestUpgrade(server.socketPath, 'prepare');
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
        const second = requestUpgrade(server.socketPath, 'prepare');
        expect((await requestUpgrade(server.socketPath, 'status')).state).toBe('preparing');
        finish({ prepared: true });
        const receipt = await first;
        expect(receipt).toMatchObject({ pid: process.pid, state: 'prepared' });
        expect((await second).instance).toBe(receipt.instance);
        expect(prepare).toHaveBeenCalledOnce();
        expect((await requestUpgrade(server.socketPath, 'resume')).state).toBe('idle');
        expect(resume).toHaveBeenCalledOnce();
    } finally {
        await server.close();
    }
    await expect(stat(server.socketPath)).rejects.toThrow();
});

describe('operator failure outcomes', () => {
    it('returns postponed or UNKNOWN without certifying safe drain', async () => {
        const prepare = vi.fn(async () => ({ prepared: false }));
        const server = await startUpgradeControl({ prepare, resume: async () => {} });
        try {
            expect((await requestUpgrade(server.socketPath, 'prepare')).state).toBe('postponed');
            prepare.mockRejectedValueOnce(new Error('restore failed'));
            expect(await requestUpgrade(server.socketPath, 'prepare')).toMatchObject({
                state: 'unknown',
                error: 'restore failed',
            });
        } finally {
            await server.close();
        }
    });

    it('rejects oversized requests and closes clients while teardown proceeds', async () => {
        const server = await startUpgradeControl({
            prepare: async () => ({ prepared: true }),
            resume: async () => {},
        });
        const socket = createConnection(server.socketPath);
        socket.on('error', () => {});
        try {
            await new Promise<void>((resolve) => socket.once('connect', resolve));
            const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
            socket.write('x'.repeat(257));
            await closed;
            expect(server.status().state).toBe('idle');
        } finally {
            socket.destroy();
            await server.close();
        }
    });
});

it('stops only the live prepared instance named by the receipt', async () => {
    const stop = vi.fn();
    const server = await startUpgradeControl({
        prepare: async () => ({ prepared: true }),
        resume: async () => {},
        stop,
    });
    try {
        expect((await requestUpgrade(server.socketPath, 'stop', 'stale')).error).toContain(
            'current prepared',
        );
        const prepared = await requestUpgrade(server.socketPath, 'prepare');
        expect((await requestUpgrade(server.socketPath, 'stop', 'stale')).state).toBe('prepared');
        // The per-boot instance identifier no longer authorizes stop.
        expect((await requestUpgrade(server.socketPath, 'stop', prepared.instance)).state).toBe(
            'prepared',
        );
        expect(stop).not.toHaveBeenCalled();
        expect((await requestUpgrade(server.socketPath, 'stop', prepared.nonce)).state).toBe(
            'stopping',
        );
        expect(stop).toHaveBeenCalledOnce();
        expect((await requestUpgrade(server.socketPath, 'resume')).error).toContain('stopping');
    } finally {
        await server.close();
    }
});

it('invalidates prepared receipts during resume and retains UNKNOWN after partial failure', async () => {
    let finish: () => void = () => {};
    const resumed = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const resume = vi.fn(async () => {
        await resumed;
        throw new Error('partial resume failed');
    });
    const stop = vi.fn();
    const prepare = vi.fn(async () => ({ prepared: true }));
    const server = await startUpgradeControl({ prepare, resume, stop });
    try {
        const prepared = await requestUpgrade(server.socketPath, 'prepare');
        const resuming = requestUpgrade(server.socketPath, 'resume');
        await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
        expect(
            (await requestUpgrade(server.socketPath, 'stop', prepared.instance)).error,
        ).toContain('current prepared');
        const reprepare = requestUpgrade(server.socketPath, 'prepare');
        finish();
        expect(await resuming).toMatchObject({ state: 'unknown', error: 'partial resume failed' });
        expect((await reprepare).state).toBe('unknown');
        expect(prepare).toHaveBeenCalledOnce();
        expect((await requestUpgrade(server.socketPath, 'status')).state).toBe('unknown');
        expect(
            (await requestUpgrade(server.socketPath, 'stop', prepared.instance)).error,
        ).toContain('current prepared');
        expect(stop).not.toHaveBeenCalled();
    } finally {
        finish();
        await server.close();
    }
});

describe('stop nonce', () => {
    it('is returned only by prepare, never by status or logs, and dies with resume', async () => {
        const stop = vi.fn();
        const server = await startUpgradeControl({
            prepare: async () => ({ prepared: true }),
            resume: async () => {},
            stop,
        });
        try {
            expect(getUpgradeState()).toBe('idle');
            const prepared = await requestUpgrade(server.socketPath, 'prepare');
            const nonce = prepared.nonce ?? '';
            expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(getUpgradeState()).toBe('prepared');
            const status = await requestUpgrade(server.socketPath, 'status');
            expect(status.nonce).toBeUndefined();
            expect(JSON.stringify(status)).not.toContain(nonce);
            expect(JSON.stringify(server.status())).not.toContain(nonce);
            expect(logged.lines.join('\n')).not.toContain(nonce);
            // Wrong value, wrong length and non-string never stop.
            for (const wrong of ['x'.repeat(nonce.length), 'short', '']) {
                expect((await requestUpgrade(server.socketPath, 'stop', wrong)).state).toBe(
                    'prepared',
                );
            }
            expect(stop).not.toHaveBeenCalled();
            await requestUpgrade(server.socketPath, 'resume');
            expect((await requestUpgrade(server.socketPath, 'stop', nonce)).error).toContain(
                'current prepared',
            );
            // A new prepare issues a different nonce; the old one stays dead.
            const again = await requestUpgrade(server.socketPath, 'prepare');
            expect(again.nonce).not.toBe(nonce);
            expect((await requestUpgrade(server.socketPath, 'stop', nonce)).state).toBe('prepared');
            expect(stop).not.toHaveBeenCalled();
        } finally {
            await server.close();
        }
        expect(getUpgradeState()).toBe('idle');
    });

    it('refuses a second prepare while prepared and never reveals the nonce', async () => {
        const prepare = vi.fn(async () => ({ prepared: true }));
        const server = await startUpgradeControl({
            prepare,
            resume: async () => {},
            stop: vi.fn(),
            preparedTimeoutMs: 60_000,
        });
        try {
            const first = await requestUpgrade(server.socketPath, 'prepare');
            const second = await requestUpgrade(server.socketPath, 'prepare');
            expect(second.state).toBe('prepared');
            expect(second.error).toBe('already_prepared');
            expect(second.nonce).toBeUndefined();
            expect(prepare).toHaveBeenCalledOnce();
            expect((await requestUpgrade(server.socketPath, 'stop', first.nonce)).state).toBe(
                'stopping',
            );
        } finally {
            await server.close();
        }
    });

    it('does not re-arm the prepared timer on a refused prepare', async () => {
        const resume = vi.fn(async () => {});
        const server = await startUpgradeControl({
            prepare: async () => ({ prepared: true }),
            resume,
            preparedTimeoutMs: 300,
        });
        try {
            await requestUpgrade(server.socketPath, 'prepare');
            await new Promise<void>((r) => setTimeout(r, 200));
            await requestUpgrade(server.socketPath, 'prepare');
            await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce(), { timeout: 250 });
        } finally {
            await server.close();
        }
    });
});

describe('prepared timeout parsing', () => {
    it('clamps to the timer maximum and rejects invalid values', () => {
        expect(parsePreparedTimeoutMs('99999999999')).toBe(2_147_483_647);
        expect(parsePreparedTimeoutMs('5000')).toBe(5000);
        for (const bad of [undefined, '', '0', '-5', 'NaN', 'Infinity', 'abc'])
            expect(parsePreparedTimeoutMs(bad)).toBe(900_000);
    });
});

describe('private socket directory', () => {
    it('is a mode 0700 directory owned by this user under a random name', async () => {
        const first = await startUpgradeControl({
            prepare: async () => ({ prepared: true }),
            resume: async () => {},
        });
        const second = await startUpgradeControl({
            prepare: async () => ({ prepared: true }),
            resume: async () => {},
        });
        try {
            const info = await stat(dirname(first.socketPath));
            expect(info.mode & 0o777).toBe(0o700);
            if (typeof process.getuid === 'function') expect(info.uid).toBe(process.getuid());
            expect(dirname(first.socketPath)).not.toBe(dirname(second.socketPath));
        } finally {
            await second.close();
            await first.close();
        }
        await expect(stat(dirname(first.socketPath))).rejects.toThrow();
    });
});

describe('prepared timeout', () => {
    it('auto-resumes and invalidates the nonce when neither stop nor resume arrives', async () => {
        const resume = vi.fn(async () => {});
        const stop = vi.fn();
        const server = await startUpgradeControl({
            prepare: async () => ({ prepared: true }),
            resume,
            stop,
            preparedTimeoutMs: 200,
        });
        try {
            const prepared = await requestUpgrade(server.socketPath, 'prepare');
            expect(resume).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce(), { timeout: 3000 });
            await vi.waitFor(() => expect(server.status().state).toBe('idle'));
            expect(logged.lines.join('\n')).toContain('timed out');
            expect(
                (await requestUpgrade(server.socketPath, 'stop', prepared.nonce)).error,
            ).toContain('current prepared');
            expect(stop).not.toHaveBeenCalled();
        } finally {
            await server.close();
        }
    });

    it('does not fire after resume or stop', async () => {
        const resume = vi.fn(async () => {});
        const server = await startUpgradeControl({
            prepare: async () => ({ prepared: true }),
            resume,
            preparedTimeoutMs: 150,
        });
        try {
            await requestUpgrade(server.socketPath, 'prepare');
            await requestUpgrade(server.socketPath, 'resume');
            expect(resume).toHaveBeenCalledOnce();
            await new Promise<void>((resolve) => setTimeout(resolve, 400));
            expect(resume).toHaveBeenCalledOnce();
        } finally {
            await server.close();
        }
    });
});
