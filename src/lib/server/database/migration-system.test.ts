// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runner-level tests for MigrationSystem.runMigrations — the real boot path.
 *
 * These cover the three guards that live in (or around) the skip loop, which
 * the F18 repro test (migration-checksum-repro.test.ts) cannot reach because it
 * calls applyMigration directly:
 *
 * 1. Checksum drift on an already-applied migration is detected even though
 *    the version watermark would otherwise skip it before applyMigration runs.
 * 2. An out-of-order migration (version at/below the watermark, never applied
 *    on this database) fails the boot instead of being silently skipped.
 * 3. Failing to acquire the advisory lock throws instead of proceeding
 *    unlocked alongside another migrator.
 * 4. An existing database below the squashed base schema fails the boot: the
 *    migrations that would bring it up were folded into the base and deleted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { MigrationSystem, type Migration } from '$lib/server/database/migration-system.js';

interface MockDbState {
    lockGranted: boolean;
    /** Rows returned for getCurrentVersion (success=true versions). */
    versionRows: Array<{ version: string }>;
    /** Rows returned for getAppliedMigrations (success=true, with checksums). */
    appliedRows: Array<{ version: string; checksum: string | null }>;
    freshDatabase: boolean;
}

/**
 * Content-routed tagged-template mock: inspects the SQL text of each query and
 * returns the fixture rows for the query shapes runMigrations issues. Order of
 * calls doesn't matter, so the mock survives refactors that add/remove queries.
 */
function createSqlMock(state: MockDbState): postgres.Sql {
    const route = (text: string): unknown[] => {
        if (text.includes('pg_try_advisory_lock')) return [{ ok: state.lockGranted }];
        if (text.includes('pg_advisory_unlock')) return [{}];
        // getAppliedMigrations / getAppliedMigrationChecksum both select
        // version + checksum; match those before the plain version select.
        if (text.includes('SELECT version, name, description, checksum')) return state.appliedRows;
        if (text.includes('SELECT version, checksum FROM schema_migrations')) {
            // applyMigration's already-applied probe: parameter values aren't
            // reconstructable from the joined text, so return no match — these
            // tests only apply migrations that have no prior row.
            return [];
        }
        if (text.includes('SELECT version FROM schema_migrations')) return state.versionRows;
        if (text.includes('information_schema.tables')) return [{ exists: !state.freshDatabase }];
        return [];
    };

    const fn = vi.fn(async (strings: TemplateStringsArray | string, ..._values: unknown[]) => {
        const text = typeof strings === 'string' ? strings : strings.join(' $ ');
        return route(text);
    }) as unknown as Record<string, unknown>;

    fn.begin = vi.fn(async (cb: (tx: postgres.Sql) => Promise<void>) => {
        await cb(fn as unknown as postgres.Sql);
    });
    fn.unsafe = vi.fn(async () => []);
    fn.release = vi.fn();
    fn.reserve = vi.fn(async () => fn);

    return fn as unknown as postgres.Sql;
}

function makeMigration(overrides: Partial<Migration>): Migration {
    return {
        version: '16.126.0',
        name: 'test-migration',
        description: 'test',
        checksum: 'checksum-a',
        up: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('MigrationSystem.runMigrations guards', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('detects checksum drift on an already-applied migration the watermark would skip', async () => {
        const sql = createSqlMock({
            lockGranted: true,
            versionRows: [{ version: '16.126.0' }, { version: '16.127.0' }],
            appliedRows: [
                { version: '16.126.0', checksum: 'original' },
                { version: '16.127.0', checksum: 'checksum-b' },
            ],
            freshDatabase: false,
        });
        const system = new MigrationSystem(sql);

        const edited = makeMigration({ version: '16.126.0', checksum: 'edited-after-deploy' });
        const intact = makeMigration({ version: '16.127.0', checksum: 'checksum-b' });

        await expect(system.runMigrations([edited, intact])).rejects.toThrow(/checksum drift/i);
        expect(edited.up).not.toHaveBeenCalled();
    });

    it('passes when all applied migrations match their stored checksums', async () => {
        const sql = createSqlMock({
            lockGranted: true,
            versionRows: [{ version: '16.126.0' }, { version: '16.127.0' }],
            appliedRows: [
                { version: '16.126.0', checksum: 'checksum-a' },
                { version: '16.127.0', checksum: 'checksum-b' },
            ],
            freshDatabase: false,
        });
        const system = new MigrationSystem(sql);

        const a = makeMigration({ version: '16.126.0', checksum: 'checksum-a' });
        const b = makeMigration({ version: '16.127.0', checksum: 'checksum-b' });

        await expect(system.runMigrations([a, b])).resolves.toBeUndefined();
        expect(a.up).not.toHaveBeenCalled();
        expect(b.up).not.toHaveBeenCalled();
    });

    it('skips drift check for rows with no stored checksum or the superseded sentinel', async () => {
        const sql = createSqlMock({
            lockGranted: true,
            versionRows: [{ version: '16.126.0' }, { version: '16.127.0' }],
            appliedRows: [
                { version: '16.126.0', checksum: null },
                { version: '16.127.0', checksum: 'superseded' },
            ],
            freshDatabase: false,
        });
        const system = new MigrationSystem(sql);

        const a = makeMigration({ version: '16.126.0', checksum: 'anything' });
        const b = makeMigration({ version: '16.127.0', checksum: 'anything-else' });

        await expect(system.runMigrations([a, b])).resolves.toBeUndefined();
    });

    it('throws on an out-of-order migration at/below the watermark that never ran here', async () => {
        const sql = createSqlMock({
            lockGranted: true,
            versionRows: [{ version: '16.127.0' }],
            appliedRows: [{ version: '16.127.0', checksum: 'checksum-b' }],
            freshDatabase: false,
        });
        const system = new MigrationSystem(sql);

        const backport = makeMigration({ version: '16.126.5', name: 'late-backport' });
        const applied = makeMigration({ version: '16.127.0', checksum: 'checksum-b' });

        await expect(system.runMigrations([backport, applied])).rejects.toThrow(/never\s+applied/i);
        expect(backport.up).not.toHaveBeenCalled();
    });

    it('still applies migrations above the watermark', async () => {
        const sql = createSqlMock({
            lockGranted: true,
            versionRows: [{ version: '16.126.0' }],
            appliedRows: [{ version: '16.126.0', checksum: 'checksum-a' }],
            freshDatabase: false,
        });
        const system = new MigrationSystem(sql);

        const applied = makeMigration({ version: '16.126.0', checksum: 'checksum-a' });
        const pending = makeMigration({ version: '16.127.0', name: 'new-one' });

        await expect(system.runMigrations([applied, pending])).resolves.toBeUndefined();
        expect(pending.up).toHaveBeenCalledTimes(1);
    });

    it('throws instead of running unlocked when the advisory lock cannot be acquired', async () => {
        const sql = createSqlMock({
            lockGranted: false,
            versionRows: [],
            appliedRows: [],
            freshDatabase: false,
        });
        const system = new MigrationSystem(sql);

        const migration = makeMigration({ version: '16.126.0' });

        await expect(system.runMigrations([migration], { lockTimeoutMs: 0 })).rejects.toThrow(
            /advisory lock/i,
        );
        expect(migration.up).not.toHaveBeenCalled();
        // Must not attempt to release a lock it never held.
        const calls = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
            [TemplateStringsArray | string]
        >;
        const unlockCalls = calls.filter(([strings]) => {
            const text = typeof strings === 'string' ? strings : strings.join(' ');
            return text.includes('pg_advisory_unlock');
        });
        expect(unlockCalls).toHaveLength(0);
    });

    describe('squashed base schema version gate', () => {
        const base = makeMigration({ version: '16.300.0', name: 'base_schema' });

        it('refuses an existing database below the base version', async () => {
            const sql = createSqlMock({
                lockGranted: true,
                versionRows: [{ version: '9.0.0' }, { version: '16.250.0' }],
                appliedRows: [{ version: '16.250.0', checksum: 'x' }],
                freshDatabase: false,
            });
            const system = new MigrationSystem(sql);

            await expect(system.runMigrations([], { baseSchemaMigration: base })).rejects.toThrow(
                /16\.250\.0 is below the squashed base schema 16\.300\.0/,
            );
            expect(base.up).not.toHaveBeenCalled();
        });

        it('is a no-op for an existing database already at the base version', async () => {
            const sql = createSqlMock({
                lockGranted: true,
                // Lexically larger legacy rows (9.0.0) must not shadow the semver max.
                versionRows: [{ version: '9.0.0' }, { version: '16.300.0' }],
                appliedRows: [{ version: '16.300.0', checksum: 'x' }],
                freshDatabase: false,
            });
            const system = new MigrationSystem(sql);

            await expect(
                system.runMigrations([], { baseSchemaMigration: base }),
            ).resolves.toBeUndefined();
            expect(base.up).not.toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringMatching(/up to date/));
        });

        it('applies the base on a fresh database regardless of the watermark', async () => {
            const sql = createSqlMock({
                lockGranted: true,
                versionRows: [],
                appliedRows: [],
                freshDatabase: true,
            });
            const system = new MigrationSystem(sql);

            await expect(
                system.runMigrations([], { baseSchemaMigration: base }),
            ).resolves.toBeUndefined();
            expect(base.up).toHaveBeenCalledTimes(1);
        });
    });
});

describe('resumable data migration phase', () => {
    function database(): postgres.Sql {
        return createSqlMock({
            lockGranted: true,
            versionRows: [],
            appliedRows: [],
            freshDatabase: false,
        });
    }
    it('runs data work before the transaction that records migration completion', async () => {
        const sql = database();
        const begin = vi.mocked(sql.begin);
        const data = vi.fn(async (handle: postgres.Sql): Promise<void> => {
            expect(handle).toBe(sql);
            expect(begin).not.toHaveBeenCalled();
        });
        const up = vi.fn(async (): Promise<void> => {
            expect(data).toHaveBeenCalledOnce();
        });
        await new MigrationSystem(sql).applyMigration(
            makeMigration({ nonTransactionalUp: data, up }),
        );
        expect(up).toHaveBeenCalledOnce();
        expect(begin).toHaveBeenCalledOnce();
    });
    it('does not record successful completion when resumable data work fails, and retries it', async () => {
        const sql = database();
        const data = vi
            .fn()
            .mockRejectedValueOnce(new Error('retry data'))
            .mockResolvedValueOnce(undefined);
        const up = vi.fn().mockResolvedValue(undefined);
        const migration = makeMigration({ nonTransactionalUp: data, up });
        const system = new MigrationSystem(sql);
        await expect(system.applyMigration(migration)).rejects.toThrow('retry data');
        expect(sql.begin).not.toHaveBeenCalled();
        expect(up).not.toHaveBeenCalled();
        await system.applyMigration(migration);
        expect(data).toHaveBeenCalledTimes(2);
        expect(up).toHaveBeenCalledOnce();
    });
});
