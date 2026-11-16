// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const valkey = vi.hoisted(() => ({
    client: null as null | { customCommand: ReturnType<typeof vi.fn> },
}));
vi.mock('$lib/server/cache/valkey.js', () => ({ getCoordinationClient: () => valkey.client }));
vi.mock('$lib/server/tasks/lua/loader.js', () => ({
    isNoScriptError: (e: unknown) => String(e).includes('NOSCRIPT'),
}));

import {
    PREP_PER_USER_MAX,
    PREP_SERVER_MAX,
    acquirePreparation,
    resetDownloadPreparationForTests,
} from './download-preparation';

beforeEach(() => {
    valkey.client = null;
    resetDownloadPreparationForTests();
});

describe('preparation admission (process-local fallback)', () => {
    it('admits one preparation per user, a second is refused with a Retry-After', async () => {
        expect(PREP_PER_USER_MAX).toBe(1);
        const a = await acquirePreparation('u1');
        expect(a.ok).toBe(true);
        const b = await acquirePreparation('u1');
        expect(b.ok).toBe(false);
        if (!b.ok) expect(b.retryAfterSec).toBeGreaterThan(0);
        expect((await acquirePreparation('u2')).ok).toBe(true);
        if (a.ok) await a.release();
        expect((await acquirePreparation('u1')).ok).toBe(true);
    });

    it('admits at most 4 across the server', async () => {
        expect(PREP_SERVER_MAX).toBe(4);
        for (let i = 0; i < 4; i++) expect((await acquirePreparation(`u${i}`)).ok).toBe(true);
        expect((await acquirePreparation('u9')).ok).toBe(false);
    });

    it('release is idempotent and an entry expires on its own', async () => {
        vi.useFakeTimers();
        try {
            const a = await acquirePreparation('u1');
            if (!a.ok) throw new Error('expected ok');
            await a.release();
            await a.release();
            const b = await acquirePreparation('u1');
            expect(b.ok).toBe(true);
            await vi.advanceTimersByTimeAsync(91_000); // beyond the entry TTL, never released
            expect((await acquirePreparation('u1')).ok).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('preparation admission (Valkey)', () => {
    it('asks one Lua script with the per-user and server keys, and releases with another', async () => {
        const calls: string[][] = [];
        valkey.client = {
            customCommand: vi.fn(async (cmd: string[]) => {
                calls.push(cmd);
                return 1;
            }),
        };
        const a = await acquirePreparation('u1');
        expect(a.ok).toBe(true);
        const first = calls[0]!;
        expect(first[0]).toBe('EVAL');
        expect(first).toContain('dl:v2:prep:all');
        expect(first).toContain('dl:v2:prep:user:u1');
        if (a.ok) await a.release();
        expect(calls.at(-1)).toContain('dl:v2:prep:user:u1');
        expect(calls.length).toBe(2);
    });

    it('a refusal from Valkey (0) is a 429, not a fallback', async () => {
        valkey.client = { customCommand: vi.fn(async () => 0) };
        const r = await acquirePreparation('u1');
        expect(r.ok).toBe(false);
    });

    it('a failing Valkey falls back to the process-local limits', async () => {
        valkey.client = {
            customCommand: vi.fn(async () => {
                throw new Error('down');
            }),
        };
        expect((await acquirePreparation('u1')).ok).toBe(true);
        expect((await acquirePreparation('u1')).ok).toBe(false);
    });
});
