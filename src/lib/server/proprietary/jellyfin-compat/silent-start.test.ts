// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sweeper's claim script is cached by SHA after the first EVAL. A Valkey
 * restart / SCRIPT FLUSH drops it: EVALSHA then answers NOSCRIPT and the claim
 * must fall back to EVAL (and keep claiming), not fail the sweep.
 */
import type postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    customCommand: vi.fn(),
}));

vi.mock('$lib/server/cache/valkey', () => ({
    getCoordinationClient: () => ({ customCommand: h.customCommand }),
}));
vi.mock('$lib/server/database/queries/client-diagnostics.queries', () => ({
    insertClientDiagnostics: vi.fn(),
}));
vi.mock('$lib/server/services/client-diagnostics/ingest.service', () => ({
    deterministicUuidFrom: () => '00000000-0000-4000-8000-000000000000',
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { sweepSilentStarts } = await import('./silent-start');

const sql = {} as postgres.Sql;
const verbs = (): string[] => h.customCommand.mock.calls.map((c) => (c[0] as string[])[0]);

describe('silent-start claim — EVALSHA → NOSCRIPT → EVAL fallback', () => {
    it('loads with EVAL, then uses EVALSHA, and falls back to EVAL on NOSCRIPT', async () => {
        // HGETALL of a claimed member that already expired → handleMiss returns early.
        h.customCommand.mockImplementation(async (args: string[]) =>
            args[0] === 'EVAL' || args[0] === 'EVALSHA' ? ['ps-x'] : null,
        );

        expect(await sweepSilentStarts(sql, 1)).toBe(1);
        expect(verbs()[0]).toBe('EVAL');

        h.customCommand.mockClear();
        expect(await sweepSilentStarts(sql, 1)).toBe(1);
        expect(verbs()[0]).toBe('EVALSHA');

        h.customCommand.mockClear();
        h.customCommand.mockImplementationOnce(async () => {
            throw new Error('NOSCRIPT No matching script. Please use EVAL.');
        });
        expect(await sweepSilentStarts(sql, 1)).toBe(1);
        expect(verbs().slice(0, 2)).toEqual(['EVALSHA', 'EVAL']);

        // Re-loaded: the next sweep is back on EVALSHA.
        h.customCommand.mockClear();
        await sweepSilentStarts(sql, 1);
        expect(verbs()[0]).toBe('EVALSHA');
    });

    it('any other EVALSHA error is not swallowed', async () => {
        h.customCommand.mockReset();
        h.customCommand.mockImplementationOnce(async () => {
            throw new Error('READONLY replica');
        });
        await expect(sweepSilentStarts(sql, 1)).rejects.toThrow('READONLY');
    });
});
