// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
    defineTask,
    defineTaskFromSchema,
    defineProvider,
    defineTrickplayProvider,
    defineWatchSync,
    defineFeature,
    defineIntegration,
    defineExternalService,
    defineMediaSource,
    definePlugin,
    defineSubtitleProvider,
    TaskError,
    PluginDefinitionError,
    RunSchema,
    TriggerSchema,
    COST_KINDS,
    RESOURCE_CLASSES,
    TRIGGER_KINDS,
} from './index.js';
import type { TaskInputOf } from './index.js';
import { mockContext, runTask } from '@sapd/lumastra-plugin-sdk-testing';
import type {
    TaskDefinition,
    ProviderDefinition,
    TaskContext,
    WatchSyncDefinition,
} from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const minimalTaskDef: TaskDefinition<{ libraryGroupId?: string }, void> = {
    id: 'test-task',
    name: 'Test Task',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '1.0.0',
    capabilities: { database: true },
    resourceClass: 'io',
    inputSchema: z.object({ libraryGroupId: z.string().optional() }),
    identityFor: (input) => input.libraryGroupId ?? 'global',
    async execute(_ctx) {
        return { success: true, itemsProcessed: 0 };
    },
};

// ---------------------------------------------------------------------------
// defineTask — compile-time type check
// ---------------------------------------------------------------------------

describe('defineTask', () => {
    it('returns the definition unchanged', () => {
        const def = defineTask(minimalTaskDef);
        expect(def.id).toBe('test-task');
        expect(def.resourceClass).toBe('io');
    });

    it('throws when id is missing', () => {
        expect(() => defineTask({ ...minimalTaskDef, id: '' })).toThrow(/id must not be blank/);
    });

    it('throws when id fails regex', () => {
        expect(() => defineTask({ ...minimalTaskDef, id: 'Bad-ID' })).toThrow(/id must match/);
    });

    it('throws when id fails regex (uppercase)', () => {
        expect(() => defineTask({ ...minimalTaskDef, id: 'TestTask' })).toThrow(/id must match/);
    });

    it('throws when inputSchema is missing', () => {
        const { inputSchema: _, ...rest } = minimalTaskDef;
        expect(() =>
            // @ts-expect-error intentionally missing inputSchema
            defineTask(rest),
        ).toThrow(/inputSchema is mandatory/);
    });

    it('throws when identityFor is missing', () => {
        const { identityFor: _, ...rest } = minimalTaskDef;
        expect(() =>
            // @ts-expect-error intentionally missing identityFor
            defineTask(rest),
        ).toThrow(/identityFor is mandatory/);
    });

    it('throws when execute is missing', () => {
        const { execute: _, ...rest } = minimalTaskDef;
        expect(() =>
            // @ts-expect-error intentionally missing execute
            defineTask(rest),
        ).toThrow(/execute is mandatory/);
    });

    it('throws when resourceClass is missing', () => {
        const { resourceClass: _, ...rest } = minimalTaskDef;
        expect(() =>
            // @ts-expect-error intentionally missing resourceClass
            defineTask(rest),
        ).toThrow(/resourceClass is mandatory/);
    });

    it('accepts all valid resource classes', () => {
        for (const rc of ['cpu', 'io', 'embedding', 'maintenance'] as const) {
            expect(() =>
                defineTask({
                    ...minimalTaskDef,
                    id: `test-${rc}`,
                    resourceClass: rc,
                }),
            ).not.toThrow();
        }
    });
});

// ---------------------------------------------------------------------------
// defineProvider
// ---------------------------------------------------------------------------

describe('defineProvider', () => {
    const minimalProvider: ProviderDefinition<{ query: string }, { id: string }> = {
        id: 'tmdb-provider',
        name: 'TMDB',
        version: '1.0.0',
        capabilities: { http: true },
        async isConfigured() {
            return true;
        },
        async search() {
            return [];
        },
        async detail() {
            return { id: 'x' };
        },
    };

    it('returns the definition unchanged', () => {
        const def = defineProvider(minimalProvider);
        expect(def.id).toBe('tmdb-provider');
    });

    it('throws when id is missing', () => {
        expect(() => defineProvider({ ...minimalProvider, id: '' })).toThrow(
            /id must not be blank/,
        );
    });

    it('accepts a provider without search (search is optional)', () => {
        const { search: _, ...rest } = minimalProvider;
        expect(() => defineProvider(rest)).not.toThrow();
    });

    it('throws when detail is missing', () => {
        const { detail: _, ...rest } = minimalProvider;
        expect(() =>
            // @ts-expect-error intentionally missing detail
            defineProvider(rest),
        ).toThrow(/detail is mandatory/);
    });
});

// ---------------------------------------------------------------------------
// defineTrickplayProvider
// ---------------------------------------------------------------------------

describe('defineTrickplayProvider', () => {
    it('validates required fields', () => {
        expect(() =>
            defineTrickplayProvider({
                id: 'tp-provider',
                capabilities: { http: true },
                async fetchParams() {
                    return null;
                },
            }),
        ).not.toThrow();

        expect(() =>
            // @ts-expect-error intentionally missing fetchParams
            defineTrickplayProvider({ id: 'tp-provider', capabilities: {} }),
        ).toThrow(/fetchParams is mandatory/);
    });
});

// ---------------------------------------------------------------------------
// defineWatchSync
// ---------------------------------------------------------------------------

const minimalWatchSync: WatchSyncDefinition = {
    id: 'jellyfin-sync',
    name: 'Jellyfin Watch Sync',
    version: '1.0.0',
    capabilities: { http: true, database: true },
    providerName: 'Jellyfin',
    async isAvailable(_ctx) {
        return true;
    },
    async resolveIds(_ctx, _items) {
        return [];
    },
    async pushWatchState(_ctx, _items, _signal) {
        return {
            succeeded: 0,
            failed: 0,
            skipped: 0,
            staleIds: [],
            errors: [],
            successful: [],
            drainedAsSkipped: [],
        };
    },
};

describe('defineWatchSync', () => {
    it('validates required fields — happy path', () => {
        expect(() => defineWatchSync(minimalWatchSync)).not.toThrow();
    });

    it('throws when pushWatchState is missing', () => {
        const { pushWatchState: _, ...rest } = minimalWatchSync;
        expect(() =>
            // @ts-expect-error intentionally missing pushWatchState
            defineWatchSync(rest),
        ).toThrow(/pushWatchState is mandatory/);
    });

    it('throws when isAvailable is missing', () => {
        const { isAvailable: _, ...rest } = minimalWatchSync;
        expect(() =>
            // @ts-expect-error intentionally missing isAvailable
            defineWatchSync(rest),
        ).toThrow(/isAvailable is mandatory/);
    });

    it('throws when providerName is missing', () => {
        expect(() => defineWatchSync({ ...minimalWatchSync, providerName: '' })).toThrow(
            /providerName is mandatory/,
        );
    });

    it('accepts optional pullWatchState', () => {
        expect(() =>
            defineWatchSync({
                ...minimalWatchSync,
                id: 'sync-with-pull',
                async pullWatchState(_ctx, _opts) {
                    return { items: [], errors: [] };
                },
            }),
        ).not.toThrow();
    });

    it('accepts and validates an optional pull-specific user audience', () => {
        expect(() =>
            defineWatchSync({
                ...minimalWatchSync,
                id: 'sync-with-pull-users',
                async listPullUsers() {
                    return ['user-1'];
                },
            }),
        ).not.toThrow();

        expect(() =>
            defineWatchSync({
                ...minimalWatchSync,
                id: 'sync-with-invalid-pull-users',
                // @ts-expect-error runtime validation protects JavaScript plugins
                listPullUsers: true,
            }),
        ).toThrow(/listPullUsers must be a function/);
    });

    it('accepts optional pushResumePosition', () => {
        expect(() =>
            defineWatchSync({
                ...minimalWatchSync,
                id: 'sync-with-resume',
                async pushResumePosition(_ctx, _items, _signal) {},
            }),
        ).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// defineFeature
// ---------------------------------------------------------------------------

describe('defineFeature', () => {
    it('validates required fields', () => {
        expect(() =>
            defineFeature({
                id: 'my-feature',
                routes: [
                    {
                        method: 'GET',
                        path: '/hello',
                        handler: async () => new Response('ok'),
                    },
                ],
            }),
        ).not.toThrow();

        expect(() =>
            // @ts-expect-error intentionally missing routes
            defineFeature({ id: 'my-feature' }),
        ).toThrow(/routes must not be empty/);
    });
});

// ---------------------------------------------------------------------------
// defineExternalService
// ---------------------------------------------------------------------------

describe('defineExternalService', () => {
    it('returns the definition unchanged for a minimal shape', () => {
        const def = defineExternalService({ id: 'openai' });
        expect(def.id).toBe('openai');
    });

    it('accepts a full shape with settings and isConfigured', () => {
        const def = defineExternalService({
            id: 'my-ai-service',
            name: 'My AI Service',
            version: '1.0.0',
            capabilities: { http: true },
            settings: {
                fields: [{ key: 'API_KEY', type: 'secret', label: 'API Key' }],
            },
            isConfigured: () => false,
            isAvailable: () => false,
        });
        expect(def.id).toBe('my-ai-service');
        expect(def.settings?.fields).toHaveLength(1);
    });

    it('throws when id is missing', () => {
        expect(() => defineExternalService({ id: '' })).toThrow(/id is required/);
    });

    it('throws when id fails kebab-case pattern (uppercase)', () => {
        expect(() => defineExternalService({ id: 'OpenAI' })).toThrow(/invalid id/);
    });

    it('throws when id contains a slash', () => {
        expect(() => defineExternalService({ id: 'my/service' })).toThrow(/invalid id/);
    });

    it('throws when id contains whitespace', () => {
        expect(() => defineExternalService({ id: 'my service' })).toThrow(/invalid id/);
    });

    it('rejects ids starting with a digit (must match registry ID_PATTERN)', () => {
        expect(() => defineExternalService({ id: '3d-ai' })).toThrow(/invalid id/);
    });

    it('accepts a digit anywhere after the first character', () => {
        expect(() => defineExternalService({ id: 'service-3d' })).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// defineMediaSource
// ---------------------------------------------------------------------------

describe('defineMediaSource', () => {
    const minimalMediaSource = {
        id: 'my-media-source',
        sourceConfig: {
            supportsIncrementalScan: false,
            defaultScanIntervalHours: 24,
        },
        async scan(_ctx: unknown, _opts: { libraryPathId?: string }) {
            return {
                added: 0,
                updated: 0,
                removed: 0,
                unmatched: 0,
                skipped: 0,
                durationMs: 0,
                errors: [],
            };
        },
        async fullSync(_ctx: unknown) {
            return {
                added: 0,
                updated: 0,
                removed: 0,
                durationMs: 0,
                errors: [],
            };
        },
        async getStatus(_ctx: unknown) {
            return { itemCount: 0, isScanning: false };
        },
    };

    it('accepts a minimal valid definition', () => {
        const def = defineMediaSource(minimalMediaSource);
        expect(def.id).toBe('my-media-source');
    });

    it('throws on missing id', () => {
        expect(() => defineMediaSource({ ...minimalMediaSource, id: '' })).toThrow(
            /id is required/,
        );
    });

    it('throws on empty id (whitespace only)', () => {
        expect(() => defineMediaSource({ ...minimalMediaSource, id: '   ' })).toThrow(
            /id is required/,
        );
    });

    it('throws on uppercase id', () => {
        expect(() => defineMediaSource({ ...minimalMediaSource, id: 'MySource' })).toThrow(
            /invalid id/,
        );
    });

    it('throws on id containing a slash', () => {
        expect(() => defineMediaSource({ ...minimalMediaSource, id: 'my/source' })).toThrow(
            /invalid id/,
        );
    });

    it('throws on id starting with a digit', () => {
        expect(() => defineMediaSource({ ...minimalMediaSource, id: '3d-scanner' })).toThrow(
            /invalid id/,
        );
    });

    it('throws on missing scan', () => {
        const { scan: _, ...rest } = minimalMediaSource;
        expect(() =>
            // @ts-expect-error intentionally missing scan
            defineMediaSource(rest),
        ).toThrow(/scan is mandatory/);
    });

    it('throws on missing fullSync', () => {
        const { fullSync: _, ...rest } = minimalMediaSource;
        expect(() =>
            // @ts-expect-error intentionally missing fullSync
            defineMediaSource(rest),
        ).toThrow(/fullSync is mandatory/);
    });

    it('throws on missing getStatus', () => {
        const { getStatus: _, ...rest } = minimalMediaSource;
        expect(() =>
            // @ts-expect-error intentionally missing getStatus
            defineMediaSource(rest),
        ).toThrow(/getStatus is mandatory/);
    });

    it('accepts all 4 watcher methods declared together', () => {
        expect(() =>
            defineMediaSource({
                ...minimalMediaSource,
                id: 'watcher-source',
                async startWatching(_ctx: unknown) {},
                async stopWatching(_ctx: unknown) {},
                async getWatcherStatus(_ctx: unknown) {
                    return { active: true, paths: 1 };
                },
                async updateWatcherTargets(_ctx: unknown) {},
            }),
        ).not.toThrow();
    });

    it('throws when only 2 of 4 watcher methods are declared', () => {
        expect(() =>
            defineMediaSource({
                ...minimalMediaSource,
                id: 'partial-watcher',
                async startWatching(_ctx: unknown) {},
                async stopWatching(_ctx: unknown) {},
            }),
        ).toThrow(/watcher methods must be all-or-nothing.*2\/4/);
    });

    it('accepts settings.fields', () => {
        const def = defineMediaSource({
            ...minimalMediaSource,
            settings: {
                fields: [
                    { key: 'URL', type: 'string', label: 'Server URL' },
                    { key: 'API_KEY', type: 'secret', label: 'API Key' },
                ],
            },
        });
        expect(def.settings?.fields).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// defineIntegration
// ---------------------------------------------------------------------------

describe('defineIntegration', () => {
    it('validates that at least one handler is provided', () => {
        expect(() =>
            defineIntegration({
                id: 'sonarr',
                capabilities: { http: true },
                async handleWebhook() {
                    return {};
                },
            }),
        ).not.toThrow();

        expect(() => defineIntegration({ id: 'sonarr', capabilities: {} })).toThrow(
            /handleWebhook or sendNotification/,
        );
    });
});

// ---------------------------------------------------------------------------
// definePlugin — multi-contract aggregate
// ---------------------------------------------------------------------------

describe('definePlugin', () => {
    it('validates all contracts and returns def', () => {
        const result = definePlugin({
            tasks: [minimalTaskDef, { ...minimalTaskDef, id: 'test-task-two', name: 'Test Two' }],
            providers: [
                {
                    id: 'my-provider',
                    name: 'My Provider',
                    version: '1.0.0',
                    capabilities: {},
                    async isConfigured() {
                        return true;
                    },
                    async search() {
                        return [];
                    },
                    async detail() {
                        return {};
                    },
                },
            ],
        });
        expect(result.tasks).toHaveLength(2);
        expect(result.providers).toHaveLength(1);
    });

    it('throws when all arrays are empty', () => {
        expect(() => definePlugin({})).toThrow(/at least one contract/);
    });

    it('accepts a media-source-only plugin', () => {
        const result = definePlugin({
            mediaSources: [
                {
                    id: 'my-source',
                    sourceConfig: {
                        supportsIncrementalScan: true,
                        defaultScanIntervalHours: 24,
                    },
                    async scan() {
                        return {
                            added: 0,
                            updated: 0,
                            removed: 0,
                            unmatched: 0,
                            skipped: 0,
                            durationMs: 0,
                            errors: [],
                        };
                    },
                    async fullSync() {
                        return { added: 0, updated: 0, removed: 0, durationMs: 0, errors: [] };
                    },
                    async getStatus() {
                        return { itemCount: 0, isScanning: false };
                    },
                },
            ],
        });
        expect(result.mediaSources).toHaveLength(1);
    });

    it('accepts an external-service-only plugin', () => {
        const result = definePlugin({
            externalServices: [{ id: 'my-service', settings: { fields: [] } }],
        });
        expect(result.externalServices).toHaveLength(1);
    });

    it('propagates inner defineMediaSource validation errors', () => {
        expect(() =>
            definePlugin({
                mediaSources: [{ id: 'Bad-ID' } as unknown as Parameters<typeof definePlugin>[0]],
            } as unknown as Parameters<typeof definePlugin>[0]),
        ).toThrow(/kebab-case/);
    });

    it('propagates inner defineTask validation errors', () => {
        expect(() => definePlugin({ tasks: [{ ...minimalTaskDef, id: 'Bad-ID' }] })).toThrow(
            /id must match/,
        );
    });
});

// ---------------------------------------------------------------------------
// TaskError
// ---------------------------------------------------------------------------

describe('TaskError', () => {
    it('carries kind=transient', () => {
        const err = new TaskError({ message: 'rate limit', kind: 'transient' });
        expect(err.kind).toBe('transient');
        expect(err.name).toBe('TaskError');
        expect(err).toBeInstanceOf(Error);
    });

    it('carries kind=permanent', () => {
        const err = new TaskError({
            message: 'invalid config',
            kind: 'permanent',
        });
        expect(err.kind).toBe('permanent');
    });

    it('carries kind=fatal', () => {
        const err = new TaskError({ message: 'db corrupt', kind: 'fatal' });
        expect(err.kind).toBe('fatal');
    });

    it('stores cause', () => {
        const cause = new Error('original');
        const err = new TaskError({
            message: 'wrapped',
            kind: 'transient',
            cause,
        });
        expect(err.cause).toBe(cause);
    });
});

// ---------------------------------------------------------------------------
// RunSchema
// ---------------------------------------------------------------------------

describe('RunSchema', () => {
    it('parses a valid run', () => {
        const raw = {
            id: 'run_01JZ',
            taskId: 'test-task',
            label: 'Test Task',
            state: 'active',
            input: { libraryGroupId: 'abc' },
            trigger: { kind: 'manual' },
            startedAt: new Date().toISOString(),
            stages: [],
            actor: { type: 'user', id: 'alice' },
        };
        const result = RunSchema.safeParse(raw);
        expect(result.success).toBe(true);
    });

    it('keeps the resume chain of a resumed run (and rejects a zero count)', () => {
        const raw = {
            id: 'run_01JZ',
            taskId: 'test-task',
            label: 'Test Task',
            state: 'active',
            input: {},
            trigger: {
                kind: 'manual',
                by: 'alice',
                resume: { rootRunId: 'run_A', previousRunId: 'run_B', count: 2, max: 3 },
            },
            startedAt: new Date().toISOString(),
            stages: [],
            actor: { type: 'user', id: 'alice' },
        };
        const result = RunSchema.safeParse(raw);
        expect(result.success).toBe(true);
        expect(result.success && result.data.trigger.resume?.count).toBe(2);
        const zero = RunSchema.safeParse({
            ...raw,
            trigger: { ...raw.trigger, resume: { ...raw.trigger.resume, count: 0 } },
        });
        expect(zero.success).toBe(false);
    });

    it('rejects invalid state', () => {
        const raw = {
            id: 'run_01JZ',
            taskId: 'test-task',
            label: 'Test Task',
            state: 'unknown-state',
            input: {},
            trigger: { kind: 'manual' },
            startedAt: new Date().toISOString(),
            stages: [],
            actor: { type: 'user' },
        };
        const result = RunSchema.safeParse(raw);
        expect(result.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// TItem generic threading (item 5)
// ---------------------------------------------------------------------------

describe('TItem threading through backlog callbacks', () => {
    it('TItem flows into backlog.compute / idOf / processItems with inference', () => {
        interface Row {
            id: string;
            name: string;
        }
        // NB: don't spread `minimalTaskDef` here — its declared type
        // `TaskDefinition<{ libraryGroupId?: string }>` carries an optional
        // `failures` field whose `list`/`retry` callbacks are pinned to that
        // input shape, which clashes with the `{ groupId: string }` input of
        // this task. Write the input-independent fields out instead.
        const task = defineTask<{ groupId: string }, void, Row>({
            id: 'item-typed-task',
            name: 'Test Task',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: { database: true },
            resourceClass: 'io',
            inputSchema: z.object({ groupId: z.string() }),
            identityFor: (i) => i.groupId,
            async execute(_ctx) {
                return { success: true, itemsProcessed: 0 };
            },
            backlog: {
                unitLabel: 'rows',
                sliceSize: 10,
                softBudget: '1m',
                idOf: (row) => {
                    // Type-level assert: row is Row, not unknown.
                    const _name: string = row.name;
                    return row.id;
                },
                stages: async (ctx) => {
                    // ctx.input typed as { groupId: string } now.
                    const _gid: string = ctx.input.groupId;
                    return [];
                },
                compute: async (_ctx, _limit) => ({
                    items: [{ id: 'r1', name: 'a' }],
                }),
            },
            processItems: async (ctx, items) => {
                const _name: string = items[0].name;
                const _gid: string = ctx.input.groupId;
            },
        });
        expect(task.id).toBe('item-typed-task');
        // Sanity: identityFor still works.
        expect(task.identityFor({ groupId: 'x' })).toBe('x');
    });
});

// ---------------------------------------------------------------------------
// defineTaskFromSchema (item 6)
// ---------------------------------------------------------------------------

describe('defineTaskFromSchema derives TInput from inputSchema', () => {
    it('produces a definition with the schema attached and ctx.input typed', async () => {
        const Input = z.object({
            libraryGroupId: z.string(),
            priority: z.number().optional(),
        });
        // Use the TaskInputOf alias here to verify it compiles and produces
        // the right shape. (`const Input` + `type Input` is valid TS — separate
        // value/type namespaces — but eslint's no-redeclare can't tell.)
        // eslint-disable-next-line no-redeclare
        type Input = TaskInputOf<typeof Input>;
        const seen: Input[] = [];
        const task = defineTaskFromSchema(Input, {
            id: 'from-schema-task',
            name: 'From-Schema Task',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'io',
            identityFor: (input) => input.libraryGroupId,
            async execute(ctx) {
                // ctx.input is typed as Input — non-optional field accessible.
                const lgi: string = ctx.input.libraryGroupId;
                seen.push({
                    libraryGroupId: lgi,
                    priority: ctx.input.priority,
                });
                return { success: true };
            },
        });
        expect(task.inputSchema).toBe(Input);
        const result = await runTask(task, {
            libraryGroupId: 'g-1',
            priority: 5,
        });
        expect(result.success).toBe(true);
        expect(seen[0].libraryGroupId).toBe('g-1');
        expect(seen[0].priority).toBe(5);
    });

    it('runs the same defineTask validator', () => {
        const Input = z.object({});
        expect(() =>
            defineTaskFromSchema(Input, {
                id: 'Bad-ID',
                name: 'x',
                version: '1',
                processingVersion: 1,
                minAppVersion: '1',
                capabilities: {},
                resourceClass: 'io',
                identityFor: () => 'g',
                async execute() {
                    return { success: true };
                },
            }),
        ).toThrow(/id must match/);
    });
});

// ---------------------------------------------------------------------------
// Type-level smoke: TaskContext generic
// ---------------------------------------------------------------------------

describe('type smoke', () => {
    it('TaskContext generic carries typed input', async () => {
        type MyInput = { libraryGroupId: string };
        const task = defineTask<MyInput, { count: number }>({
            id: 'typed-task',
            name: 'Typed Task',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'maintenance',
            inputSchema: z.object({ libraryGroupId: z.string() }),
            identityFor: (input) => input.libraryGroupId,
            async execute(ctx: TaskContext<MyInput>) {
                const _: string = ctx.input.libraryGroupId;
                return { success: true, result: { count: 1 } };
            },
        });
        const result = await runTask(task, { libraryGroupId: 'grp' });
        expect(result.result?.count).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// COST_KINDS / RESOURCE_CLASSES runtime arrays
// ---------------------------------------------------------------------------

describe('runtime constant arrays', () => {
    it('COST_KINDS contains all 3 values', () => {
        expect(COST_KINDS).toContain('openai_tokens');
        expect(COST_KINDS).toContain('cpu_seconds');
        expect(COST_KINDS).toContain('api_calls');
        expect(COST_KINDS).toHaveLength(3);
    });

    it('RESOURCE_CLASSES contains all 8 values', () => {
        expect(RESOURCE_CLASSES).toContain('cpu');
        expect(RESOURCE_CLASSES).toContain('io');
        expect(RESOURCE_CLASSES).toContain('embedding');
        expect(RESOURCE_CLASSES).toContain('maintenance');
        expect(RESOURCE_CLASSES).toContain('ingest');
        expect(RESOURCE_CLASSES).toContain('bulk');
        expect(RESOURCE_CLASSES).toContain('analysis');
        expect(RESOURCE_CLASSES).toContain('discovery');
        expect(RESOURCE_CLASSES).toHaveLength(8);
    });

    it('TRIGGER_KINDS lists every kind accepted by TriggerSchema', () => {
        // Locks the contract: every value in TRIGGER_KINDS must round-trip
        // through TriggerSchema (catches drift if either side is amended in
        // isolation).
        for (const kind of TRIGGER_KINDS) {
            const parsed = TriggerSchema.safeParse({ kind });
            expect(parsed.success, `TRIGGER_KINDS member '${kind}' rejected by TriggerSchema`).toBe(
                true,
            );
        }
        expect(TRIGGER_KINDS).toContain('webhook');
        expect(TRIGGER_KINDS).toContain('in-process');
        expect(TRIGGER_KINDS).toHaveLength(6);
    });
});

// ---------------------------------------------------------------------------
// ctx.mode <-> TriggerKind alignment
// ---------------------------------------------------------------------------

describe('TaskContext.mode aligns with TriggerKind', () => {
    it('accepts every TRIGGER_KINDS value at the type and runtime layer', () => {
        // The friendly mockContext shape is typed as TaskContext['mode']; if
        // the inline mode union ever drops a kind, this loop fails to compile.
        for (const kind of TRIGGER_KINDS) {
            const ctx = mockContext({ mode: kind });
            expect(ctx.mode).toBe(kind);
        }
    });

    it('rejects modes outside TRIGGER_KINDS at runtime via TriggerSchema', () => {
        expect(TriggerSchema.safeParse({ kind: 'webhook' }).success).toBe(true);
        expect(TriggerSchema.safeParse({ kind: 'in-process' }).success).toBe(true);
        expect(TriggerSchema.safeParse({ kind: 'made-up' }).success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ctx.signal / ctx.abortSignal alias (item 9 — deprecation preserves runtime)
// ---------------------------------------------------------------------------

describe('TaskContext signal aliases', () => {
    it('signal and abortSignal point at the same AbortSignal', () => {
        const ctx = mockContext();
        expect(ctx.signal).toBe(ctx.abortSignal);
    });
});

// ---------------------------------------------------------------------------
// PluginDefinitionError
// ---------------------------------------------------------------------------

describe('PluginDefinitionError', () => {
    it('includes task id in message', () => {
        const err = new PluginDefinitionError({
            id: 'my-task',
            message: 'test',
            phase: 'registration',
        });
        expect(err.message).toContain('my-task');
        expect(err.taskId).toBe('my-task');
        expect(err.phase).toBe('registration');
        expect(err.name).toBe('PluginDefinitionError');
        expect(err).toBeInstanceOf(Error);
    });

    it('is thrown by defineTask for invalid schedule.every', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'sched-bad',
                schedule: { every: 'bad-unit' },
            }),
        ).toThrow(PluginDefinitionError);
    });

    it('is thrown by defineTask for invalid timeout.hard', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'timeout-bad',
                timeout: { hard: 'notaduration', soft: '5m' },
            }),
        ).toThrow(PluginDefinitionError);
    });

    it('is thrown when processItems lacks backlog', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'process-no-backlog',
                processItems: async () => undefined,
            }),
        ).toThrow(/processItems requires backlog/);
    });
});

// ---------------------------------------------------------------------------
// defineTask — extended validation
// ---------------------------------------------------------------------------

describe('defineTask extended validation', () => {
    it('accepts resumeAfterRestart on a manual task and rejects it on a pipeline stage', () => {
        expect(() =>
            defineTask({ ...minimalTaskDef, id: 'resume-ok', resumeAfterRestart: true }),
        ).not.toThrow();
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'resume-stage',
                resumeAfterRestart: true,
                pipeline: { of: 'some-parent' },
            } as never),
        ).toThrow(/resumeAfterRestart cannot be combined with pipeline\.of/);
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'resume-not-bool',
                resumeAfterRestart: 'yes',
            } as never),
        ).toThrow(/resumeAfterRestart must be a boolean/);
    });

    it('accepts valid schedule.every duration', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'sched-ok',
                schedule: { every: '15m' },
            }),
        ).not.toThrow();
    });

    it('rejects invalid schedule.every', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'sched-bad2',
                schedule: { every: '5x' },
            }),
        ).toThrow(/schedule.every/);
    });

    it('accepts valid timeout', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'timeout-ok',
                timeout: { hard: '1h', soft: '30m' },
            }),
        ).not.toThrow();
    });

    it('rejects invalid timeout.soft', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'timeout-soft-bad',
                timeout: { hard: '1h', soft: 'bad' },
            }),
        ).toThrow(/timeout.soft/);
    });

    it('rejects failures.retry without failures.list', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'failures-retry-no-list',
                failures: {
                    retry: async () => undefined,
                } as never,
            }),
        ).toThrow(/failures.retry requires failures.list/);
    });

    it('rejects exclusiveWith.ttl with invalid duration', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'excl-ttl-bad',
                exclusiveWith: { scope: 'global', ttl: 'forever' },
            }),
        ).toThrow(/exclusiveWith\.ttl/);
    });

    it('accepts valid exclusiveWith.ttl', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'excl-ttl-ok',
                exclusiveWith: { scope: 'global', ttl: '24h' },
            }),
        ).not.toThrow();
    });

    it('throws PluginDefinitionError when exclusiveWith.ttl < timeout.hard', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'excl-ttl-shorter-than-hard',
                timeout: { hard: '1h', soft: '55m' },
                exclusiveWith: { scope: 'global', ttl: '10m' },
            }),
        ).toThrow(PluginDefinitionError);
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'excl-ttl-shorter-than-hard-2',
                timeout: { hard: '1h', soft: '55m' },
                exclusiveWith: { scope: 'global', ttl: '10m' },
            }),
        ).toThrowError(/exclusiveWith\.ttl.*shorter than timeout\.hard/s);
    });

    it('does not throw when exclusiveWith.ttl >= timeout.hard', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'excl-ttl-ge-hard',
                timeout: { hard: '1h', soft: '55m' },
                exclusiveWith: { scope: 'global', ttl: '2h' },
            }),
        ).not.toThrow();
    });

    it('rejects timeout.soft >= timeout.hard', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'timeout-inverted',
                timeout: { hard: '5m', soft: '10m' },
            }),
        ).toThrow(/strictly less than/);
    });

    it('rejects pipeline.after entry that matches own id', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'self-ref',
                pipeline: { of: 'parent-task', after: ['self-ref'] },
            }),
        ).toThrow(/pipeline\.after cannot reference the task's own id/);
    });

    it('rejects pipeline.after entry with bad id format', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'bad-pipeline-after',
                pipeline: { of: 'parent', after: ['Bad-ID'] },
            }),
        ).toThrow(/pipeline\.after entry 'Bad-ID' is not a valid task id/);
    });

    it('rejects pipeline.of with bad id format', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'bad-pipeline-of',
                pipeline: { of: 'Bad-Parent' },
            }),
        ).toThrow(/pipeline\.of must be a valid task id/);
    });

    it('rejects backlog.softBudget with invalid duration', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'soft-budget-bad',
                backlog: {
                    unitLabel: 'items',
                    sliceSize: 100,
                    softBudget: 'banana',
                    idOf: () => 'x',
                    stages: async () => [],
                    compute: async () => ({ items: [] }),
                },
            }),
        ).toThrow(/backlog\.softBudget/);
    });

    it('rejects backlog.sliceSize that is not a positive integer', () => {
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'slice-size-bad',
                backlog: {
                    unitLabel: 'items',
                    sliceSize: 0,
                    softBudget: '5m',
                    idOf: () => 'x',
                    stages: async () => [],
                    compute: async () => ({ items: [] }),
                },
            }),
        ).toThrow(/backlog\.sliceSize must be a positive integer/);
    });

    it('fails fast when inputSchema.safeParse throws on registration', () => {
        // A "schema" whose safeParse throws is structurally invalid — defineTask
        // should surface this at registration rather than at first run.
        const bombSchema = {
            parse: () => undefined,
            safeParse: () => {
                throw new Error('boom from custom schema');
            },
        } as unknown as z.ZodSchema<{ libraryGroupId?: string }>;
        expect(() =>
            defineTask({
                ...minimalTaskDef,
                id: 'bomb-schema',
                inputSchema: bombSchema,
            }),
        ).toThrow(/safeParse\(\{\}\) threw at registration time/);
    });

    it('every PluginDefinitionError carries the task id', () => {
        // Spot-check that all validation errors flow through PluginDefinitionError
        // (which prefixes message with `defineTask(${id}): ...`).
        try {
            defineTask({
                ...minimalTaskDef,
                id: 'id-check-task',
                schedule: { every: 'bad' },
            });
            expect.fail('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(PluginDefinitionError);
            expect((e as PluginDefinitionError).taskId).toBe('id-check-task');
            expect((e as Error).message).toContain('id-check-task');
        }
    });
});

// ---------------------------------------------------------------------------
// defineWatchSync — __autoTasks
// ---------------------------------------------------------------------------

describe('defineWatchSync __autoTasks', () => {
    it('attaches two auto tasks (push + pull)', () => {
        const ws = defineWatchSync(minimalWatchSync);
        expect((ws as { __autoTasks?: unknown[] }).__autoTasks).toHaveLength(2);
    });

    it('push task id is <id>-push', () => {
        const ws = defineWatchSync({ ...minimalWatchSync, id: 'my-sync' });
        const tasks = (ws as { __autoTasks?: { id: string }[] }).__autoTasks ?? [];
        expect(tasks[0].id).toBe('my-sync-push');
        expect(tasks[1].id).toBe('my-sync-pull');
    });

    it('accepts deprecated pushEvery/pullEvery options without setting auto-task schedules', () => {
        // pushEvery/pullEvery were intentionally neutered: the watch-sync
        // engine drives timing, so auto-tasks must NOT declare a schedule
        // (otherwise the scheduler would fire the stub handlers periodically).
        // The options are retained on the surface but logged as deprecated.
        const ws = defineWatchSync(
            { ...minimalWatchSync, id: 'custom-sync' },
            { pushEvery: '10m', pullEvery: '30m' },
        );
        const tasks =
            (ws as { __autoTasks?: { schedule?: { every: string } }[] }).__autoTasks ?? [];
        expect(tasks[0].schedule).toBeUndefined();
        expect(tasks[1].schedule).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// defineSubtitleProvider
// ---------------------------------------------------------------------------

const minimalSubtitleProvider = {
    id: 'opensubs',
    name: 'OpenSubs',
    version: '1.0.0',
    async search() {
        return [];
    },
    async download() {
        return { content: 'WEBVTT', format: 'vtt' as const };
    },
};

describe('defineSubtitleProvider', () => {
    it('returns the definition unchanged when valid', () => {
        expect(defineSubtitleProvider(minimalSubtitleProvider)).toBe(minimalSubtitleProvider);
    });

    it('rejects a non-kebab-case id', () => {
        expect(() =>
            defineSubtitleProvider({ ...minimalSubtitleProvider, id: 'Open_Subs' }),
        ).toThrow(/id must match/);
    });

    it('requires search', () => {
        const { search: _search, ...rest } = minimalSubtitleProvider;
        expect(() =>
            defineSubtitleProvider(rest as unknown as typeof minimalSubtitleProvider),
        ).toThrow(/search is mandatory/);
    });

    it('requires download — a provider that cannot deliver a file is useless', () => {
        const { download: _download, ...rest } = minimalSubtitleProvider;
        expect(() =>
            defineSubtitleProvider(rest as unknown as typeof minimalSubtitleProvider),
        ).toThrow(/download is mandatory/);
    });
});
