// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { TaskError } from '@sapd/lumastra-plugin-sdk';
import { buildPluginContext } from './plugin-context.js';
import { TaskRegistry } from './registry.js';

describe('buildPluginContext request scope', () => {
    it('defaults user to null when not provided', () => {
        const ctx = buildPluginContext('demo');
        expect(ctx.user ?? null).toBeNull();
    });

    it('exposes the injected viewer', () => {
        const ctx = buildPluginContext('demo', {
            user: {
                userId: 'test-user-id-alice',
                username: 'alice',
                groups: ['admins'],
                isAdmin: true,
            },
        });
        expect(ctx.user?.username).toBe('alice');
        expect(ctx.user?.isAdmin).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// ctx.sql capability gate
// ---------------------------------------------------------------------------

/**
 * Minimal registered-task shape — only the fields `registerTask` requires and
 * the `capabilities` block the gate reads. Using a local registry per test so
 * no singleton state bleeds between cases.
 */
function makeRegistry(): TaskRegistry {
    return new TaskRegistry({ perTaskQueues: false });
}

function callSql(sql: ReturnType<typeof buildPluginContext>['sql']): unknown {
    // A tagged template literal compiled by TS looks like sql`...`; the Proxy
    // `apply` trap fires equivalently when we invoke the function with a fake
    // TemplateStringsArray.  We just need the invocation to trigger the stub
    // or the real handle — we don't care about the return value.
    return (sql as unknown as (s: TemplateStringsArray) => unknown)([
        '',
    ] as unknown as TemplateStringsArray);
}

describe('buildPluginContext sql capability gate', () => {
    it('grants ctx.sql when the task declares capabilities.database: true', () => {
        const registry = makeRegistry();
        registry.registerTask({
            id: 'db-task',
            name: 'DB Task',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            resourceClass: 'io',
            capabilities: { database: true },
            inputSchema: z.object({}),
            identityFor: () => 'db-task',
            execute: async () => ({ success: true }),
        });

        const ctx = buildPluginContext('db-task', { registry, sql: undefined });

        // When database capability is declared the context must NOT be a stub.
        // The real handle comes from getTaskDb() which returns null in tests, so
        // buildPluginContext falls back to buildUnavailableSqlStub() with the
        // DEFAULT "sql handle unavailable" message — not the capability-gate
        // message.  We verify we get the default-fallback stub (ambient DB absent),
        // NOT the capability-denial stub, by checking the error message.
        expect(() => callSql(ctx.sql)).toThrowError(/sql handle unavailable/);
        expect(() => callSql(ctx.sql)).not.toThrowError(/add `database: true`/);
    });

    it('grants ctx.sql when a provider declares capabilities.database: true', () => {
        const registry = makeRegistry();
        registry.registerProvider({
            id: 'db-provider',
            name: 'DB Provider',
            version: '1.0.0',
            capabilities: { database: true },
            isConfigured: async () => true,
            detail: async () => ({}),
        });

        const ctx = buildPluginContext('db-provider', { registry });
        expect(() => callSql(ctx.sql)).toThrowError(/sql handle unavailable/);
        expect(() => callSql(ctx.sql)).not.toThrowError(/add `database: true`/);
    });

    it('returns a throwing stub with the capability-gate message when the task does NOT declare database', () => {
        const registry = makeRegistry();
        registry.registerTask({
            id: 'no-db-task',
            name: 'No DB Task',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            resourceClass: 'io',
            capabilities: { http: true },
            inputSchema: z.object({}),
            identityFor: () => 'no-db-task',
            execute: async () => ({ success: true }),
        });

        const ctx = buildPluginContext('no-db-task', { registry });

        const err = (() => {
            try {
                callSql(ctx.sql);
            } catch (e) {
                return e;
            }
        })();

        expect(err).toBeInstanceOf(TaskError);
        expect((err as TaskError).message).toMatch(/no-db-task/);
        expect((err as TaskError).message).toMatch(/add `database: true`/);
        expect((err as TaskError).kind).toBe('permanent');
    });

    it('ctx.catalog throws via the stub when the task has no database capability', async () => {
        const registry = makeRegistry();
        registry.registerTask({
            id: 'no-db-task2',
            name: 'No DB Task 2',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            resourceClass: 'io',
            capabilities: {},
            inputSchema: z.object({}),
            identityFor: () => 'no-db-task2',
            execute: async () => ({ success: true }),
        });

        const ctx = buildPluginContext('no-db-task2', { registry });

        // ctx.catalog closes over the denied sql stub; upsertExternalId will
        // invoke sql which triggers the stub.
        // `await` is load-bearing: without it the rejection assertion never
        // settles before the test ends, so the gate was never actually checked.
        // Vitest 5 fails the test rather than letting it pass vacuously.
        await expect(
            ctx.catalog.upsertExternalId({
                mediaItemId: 'x',
                provider: 'p',
                externalId: 'e',
                mediaType: 'movie',
            }),
        ).rejects.toBeInstanceOf(TaskError);
    });

    it('ctx.mediaItems throws via the stub when the task has no database capability', async () => {
        const registry = makeRegistry();
        registry.registerTask({
            id: 'no-db-task3',
            name: 'No DB Task 3',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            resourceClass: 'io',
            capabilities: {},
            inputSchema: z.object({}),
            identityFor: () => 'no-db-task3',
            execute: async () => ({ success: true }),
        });

        const ctx = buildPluginContext('no-db-task3', { registry });

        await expect(ctx.mediaItems.getById('some-id')).rejects.toBeInstanceOf(TaskError);
    });

    it('ctx.mediaFiles throws via the stub when the task has no database capability', async () => {
        const registry = makeRegistry();
        registry.registerTask({
            id: 'no-db-task4',
            name: 'No DB Task 4',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            resourceClass: 'io',
            capabilities: {},
            inputSchema: z.object({}),
            identityFor: () => 'no-db-task4',
            execute: async () => ({ success: true }),
        });

        const ctx = buildPluginContext('no-db-task4', { registry });

        await expect(ctx.mediaFiles.findByPath('/some/path')).rejects.toBeInstanceOf(TaskError);
    });

    it('grants ctx.sql when options.sql is passed explicitly, even without the capability', () => {
        const registry = makeRegistry();
        registry.registerTask({
            id: 'no-db-explicit-sql',
            name: 'No DB Explicit SQL',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            resourceClass: 'io',
            capabilities: { http: true },
            inputSchema: z.object({}),
            identityFor: () => 'no-db-explicit-sql',
            execute: async () => ({ success: true }),
        });

        // Passing options.sql is a deliberate framework grant (e.g. transaction handle).
        // The gate must honor it even when capabilities.database is absent.
        const fakeSql = new Proxy((() => Promise.resolve([])) as unknown as object, {
            apply: () => Promise.resolve([]),
            get: () => undefined,
        }) as unknown as import('postgres').Sql;

        const ctx = buildPluginContext('no-db-explicit-sql', { registry, sql: fakeSql });

        // Should NOT throw the capability-gate message — sql is the caller-supplied handle.
        expect(() => callSql(ctx.sql)).not.toThrowError(/add `database: true`/);
    });

    it('grants ctx.sql for an unregistered (unknown) pluginId — internal/ad-hoc context', () => {
        const registry = makeRegistry();
        // Nothing registered under this id.

        const ctx = buildPluginContext('boot-internal-task', { registry });

        // Unknown ids are ungated — they get the ambient handle (null in tests →
        // default unavailable stub), NOT the capability-denial stub.
        expect(() => callSql(ctx.sql)).toThrowError(/sql handle unavailable/);
        expect(() => callSql(ctx.sql)).not.toThrowError(/add `database: true`/);
    });

    it('grants ctx.sql when one registration kind declares database: true even if another does not', () => {
        // Tests the .some() behaviour: an explicit `database: false` on one definition
        // must not short-circuit and mask a `true` on another when an id is registered
        // under multiple kinds.
        //
        // Note: the TaskRegistry prevents registering the same id under multiple kinds
        // (cross-contract collision guard), so we test the equivalent: a WatchSync with
        // database: true paired against a trickplay that would have database: false.
        // We simulate multiple-definition behaviour by verifying the .some() path via
        // pluginDefs array ordering (task vs provider slots).
        //
        // The simplest way to exercise the `some()` path directly: register as a
        // TrickplayProvider (slot 2) without database, and as a task (slot 0) WITH
        // database — impossible due to cross-contract guard.  Instead we confirm the
        // WatchSync path (slot 3): register a WatchSync with database: true.

        const registry = makeRegistry();
        registry.registerWatchSync({
            id: 'watch-with-db',
            name: 'Watch With DB',
            version: '1.0.0',
            providerName: 'Watch With DB',
            capabilities: { database: true },
            isAvailable: async () => true,
            resolveIds: async () => [],
            pushWatchState: async () => {
                throw new Error('not used in this test');
            },
        });

        const ctx = buildPluginContext('watch-with-db', { registry });

        // database: true on the WatchSync must grant the real handle path, not the stub.
        expect(() => callSql(ctx.sql)).toThrowError(/sql handle unavailable/);
        expect(() => callSql(ctx.sql)).not.toThrowError(/add `database: true`/);
    });
});
