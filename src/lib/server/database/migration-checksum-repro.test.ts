// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F18 — Migration checksums stored but never validated.
 *
 * Finding: applyMigration inserts checksum into schema_migrations, but when a
 * migration is already applied, the runner skips it without comparing stored
 * checksum to the current object's checksum. A developer can silently edit an
 * already-applied migration and nothing detects the drift.
 *
 * Citations: src/lib/server/database/migration-system.ts:24,97-180
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type postgres from 'postgres';

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

describe('F18 — Migration checksum drift must be detected', () => {
    let mockSql: postgres.Sql;
    // Raw mock handle for queuing query results. `postgres.Sql` is a deeply
    // generic callable; running `vi.mocked()` over it trips TS2589, so we keep
    // a simply-typed reference to the underlying tagged-template mock instead.
    let mockSqlFn: Mock<(...args: unknown[]) => Promise<unknown>>;

    beforeEach(() => {
        vi.clearAllMocks();
        const fn = vi.fn().mockResolvedValue([]) as Mock<(...args: unknown[]) => Promise<unknown>>;
        (fn as unknown as Record<string, unknown>).begin = vi
            .fn()
            .mockImplementation(async (cb: (tx: postgres.Sql) => Promise<void>) => {
                await cb(fn as unknown as postgres.Sql);
            });
        mockSqlFn = fn;
        mockSql = fn as unknown as postgres.Sql;
    });

    it('throws when an already-applied migration has a different checksum', async () => {
        const { MigrationSystem } = await import('$lib/server/database/migration-system.js');

        const system = new MigrationSystem();
        // @ts-expect-error — replacing private field for test
        system.sql = mockSql;

        // Simulate that migration v1.0.0 is already applied with checksum "original"
        mockSqlFn.mockResolvedValueOnce([{ version: '1.0.0', checksum: 'original' }]);

        const migration = {
            version: '1.0.0',
            name: 'test-migration',
            description: 'test',
            checksum: 'modified-after-deployment', // developer edited the file!
            up: vi.fn().mockResolvedValue(undefined),
        };

        // CORRECT behavior: Should detect checksum mismatch and throw/warn.
        // BUG: The migration is silently skipped without comparing checksums.
        await expect(system.applyMigration(migration)).rejects.toThrow();
    });

    it('emits a warning when checksums mismatch for an already-applied migration', async () => {
        const { MigrationSystem } = await import('$lib/server/database/migration-system.js');

        const system = new MigrationSystem();
        // @ts-expect-error — replacing private field for test
        system.sql = mockSql;

        mockSqlFn.mockResolvedValueOnce([{ version: '2.0.0', checksum: 'abc123' }]);

        const migration = {
            version: '2.0.0',
            name: 'important-fix',
            description: 'security patch',
            checksum: 'tampered', // completely different!
            up: vi.fn().mockResolvedValue(undefined),
        };

        // CORRECT behavior: Should warn about checksum mismatch.
        // BUG: No warning or error about checksum mismatch is emitted.
        await expect(system.applyMigration(migration)).rejects.toThrow();

        const warnCalls = mockLogger.warn.mock.calls;
        const checksumWarning = warnCalls.find(
            (c) => typeof c[0] === 'string' && c[0].toLowerCase().includes('checksum'),
        );
        expect(checksumWarning).toBeDefined();
    });
});
