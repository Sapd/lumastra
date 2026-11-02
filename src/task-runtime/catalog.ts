// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { PLUGIN_SDK_ABI, RESOURCE_CLASSES, type TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import { TASK_PROTOCOL_VERSION } from './protocol.js';
import { z } from 'zod';

export const PLUGIN_CONTRACT_KINDS = [
    'task',
    'provider',
    'trickplay',
    'watch-sync',
    'feature',
    'integration',
    'external-service',
    'media-source',
    'subtitle-provider',
    'lyrics-provider',
    'auth-provider',
] as const;

// Pick metadata only, so a task's inferred input/result function types never
// need to be widened or cast merely to publish its catalog entry.
export type CatalogDefinition = Pick<
    TaskDefinition,
    | 'id'
    | 'version'
    | 'processingVersion'
    | 'resourceClass'
    | 'declaredResourceClass'
    | 'isolation'
    | 'capabilities'
    | 'schedule'
    | 'pipeline'
    | 'quotas'
    | 'scope'
    | 'exclusiveWith'
    | 'taskPriority'
    | 'timeout'
    | 'backpressure'
    | 'retry'
    | 'manualOnly'
    | 'demo'
    | 'resumeAfterRestart'
> & { dynamicSchedule?: unknown; backlog?: unknown };

export interface CatalogTask {
    id: string;
    version: string;
    processingVersion: number;
    resourceClass: TaskDefinition['resourceClass'];
    declaredResourceClass?: TaskDefinition['declaredResourceClass'];
    isolation: 'inline' | 'worker';
    capabilities: TaskDefinition['capabilities'];
    schedule?: TaskDefinition['schedule'];
    pipeline?: { of: string; after: string[]; conditional: boolean };
    dynamicSchedule: boolean;
    backlog: boolean;
    quotas?: TaskDefinition['quotas'];
    scope?: TaskDefinition['scope'];
    exclusiveWith?: TaskDefinition['exclusiveWith'];
    taskPriority?: TaskDefinition['taskPriority'];
    timeout?: TaskDefinition['timeout'];
    backpressure?: TaskDefinition['backpressure'];
    retry?: { attempts: number; backoff: 'exponential' | number[] };
    manualOnly: boolean;
    demo: boolean;
    resumeAfterRestart: boolean;
    // Opaque functions always execute in the TypeScript host with real context.
    inputValidation: 'typescript-sdk';
    identityPolicy: 'typescript-sdk';
    retryPolicy: 'typescript-sdk';
}

export interface TaskCatalog {
    version: number;
    sdkAbi: number;
    revision: string;
    tasks: CatalogTask[];
}

export function createTaskCatalog(definitions: readonly CatalogDefinition[]): TaskCatalog {
    const seen = new Set<string>();
    const tasks: CatalogTask[] = definitions
        .map((task): CatalogTask => {
            if (seen.has(task.id)) throw new Error(`Duplicate catalog task: ${task.id}`);
            seen.add(task.id);
            return {
                id: task.id,
                version: task.version,
                processingVersion: task.processingVersion,
                resourceClass: task.resourceClass,
                declaredResourceClass: task.declaredResourceClass,
                isolation: task.isolation ?? 'inline',
                capabilities: {
                    database: task.capabilities.database,
                    http: task.capabilities.http,
                    ffmpeg: task.capabilities.ffmpeg,
                    cache: task.capabilities.cache,
                    dataDir: task.capabilities.dataDir,
                    allowedDomains: task.capabilities.allowedDomains
                        ? [...task.capabilities.allowedDomains]
                        : undefined,
                },
                schedule: task.schedule
                    ? {
                          every: task.schedule.every,
                          runOnStartup: task.schedule.runOnStartup,
                          startupDelay: task.schedule.startupDelay,
                          envOverride: task.schedule.envOverride,
                      }
                    : undefined,
                pipeline: task.pipeline
                    ? {
                          of: task.pipeline.of,
                          after: [...(task.pipeline.after ?? [])],
                          conditional: !!task.pipeline.when,
                      }
                    : undefined,
                dynamicSchedule: !!task.dynamicSchedule,
                backlog: !!task.backlog,
                quotas: task.quotas
                    ? {
                          maxRunsPerDay: task.quotas.maxRunsPerDay,
                          maxRunsPerTenant: task.quotas.maxRunsPerTenant,
                          maxConcurrent: task.quotas.maxConcurrent,
                          costBudgetMonthly: task.quotas.costBudgetMonthly,
                      }
                    : undefined,
                scope: task.scope,
                exclusiveWith: task.exclusiveWith
                    ? { scope: task.exclusiveWith.scope, ttl: task.exclusiveWith.ttl }
                    : undefined,
                taskPriority: task.taskPriority,
                timeout: task.timeout
                    ? { hard: task.timeout.hard, soft: task.timeout.soft }
                    : undefined,
                backpressure: task.backpressure
                    ? {
                          onQueueDepthOver: task.backpressure.onQueueDepthOver,
                          action: task.backpressure.action,
                      }
                    : undefined,
                retry: task.retry
                    ? {
                          attempts: task.retry.attempts,
                          backoff: Array.isArray(task.retry.backoff)
                              ? [...task.retry.backoff]
                              : task.retry.backoff,
                      }
                    : undefined,
                manualOnly: task.manualOnly ?? false,
                demo: task.demo ?? false,
                resumeAfterRestart: task.resumeAfterRestart ?? false,
                inputValidation: 'typescript-sdk',
                identityPolicy: 'typescript-sdk',
                retryPolicy: 'typescript-sdk',
            };
        })
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const body = { version: TASK_PROTOCOL_VERSION, sdkAbi: PLUGIN_SDK_ABI, tasks };
    // Roundtrip detaches all manifest references and drops absent JSON fields.
    const serialized = JSON.stringify(body);
    return parseTaskCatalog({
        ...(JSON.parse(serialized) as Omit<TaskCatalog, 'revision'>),
        revision: createHash('sha256').update(serialized).digest('hex'),
    });
}

// Validation at the consumer boundary is independent of manifest registration.
const resourceClass = z.enum(RESOURCE_CLASSES);
const catalogTaskSchema = z
    .object({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/),
        version: z.string(),
        processingVersion: z.number().int().positive(),
        resourceClass,
        declaredResourceClass: resourceClass.optional(),
        isolation: z.enum(['inline', 'worker']),
        capabilities: z
            .object({
                database: z.boolean().optional(),
                http: z.boolean().optional(),
                ffmpeg: z.boolean().optional(),
                cache: z.boolean().optional(),
                dataDir: z.boolean().optional(),
                allowedDomains: z.array(z.string()).optional(),
            })
            .strict(),
        schedule: z
            .object({
                every: z.string(),
                runOnStartup: z.boolean().optional(),
                startupDelay: z.string().optional(),
                envOverride: z.string().optional(),
            })
            .strict()
            .optional(),
        pipeline: z
            .object({ of: z.string(), after: z.array(z.string()), conditional: z.boolean() })
            .strict()
            .optional(),
        dynamicSchedule: z.boolean(),
        backlog: z.boolean(),
        quotas: z
            .object({
                maxRunsPerDay: z.number().optional(),
                maxRunsPerTenant: z.number().optional(),
                maxConcurrent: z.number().optional(),
                costBudgetMonthly: z.number().optional(),
            })
            .strict()
            .optional(),
        scope: z.enum(['global', 'libraryGroup', 'user']).optional(),
        exclusiveWith: z
            .object({ scope: z.enum(['global', 'libraryGroup', 'user']), ttl: z.string() })
            .strict()
            .optional(),
        taskPriority: z
            .union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(7)])
            .optional(),
        timeout: z.object({ hard: z.string(), soft: z.string() }).strict().optional(),
        backpressure: z
            .object({
                onQueueDepthOver: z.number(),
                action: z.enum(['drop', 'fail-fast', 'shed-oldest']),
            })
            .strict()
            .optional(),
        retry: z
            .object({
                attempts: z.number().int(),
                backoff: z.union([z.literal('exponential'), z.array(z.number())]),
            })
            .strict()
            .optional(),
        manualOnly: z.boolean(),
        demo: z.boolean(),
        resumeAfterRestart: z.boolean(),
        inputValidation: z.literal('typescript-sdk'),
        identityPolicy: z.literal('typescript-sdk'),
        retryPolicy: z.literal('typescript-sdk'),
    })
    .strict();
const catalogSchema = z
    .object({
        version: z.literal(TASK_PROTOCOL_VERSION),
        sdkAbi: z.literal(PLUGIN_SDK_ABI),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        tasks: z.array(catalogTaskSchema),
    })
    .strict();

export function parseTaskCatalog(value: unknown): TaskCatalog {
    const catalog = catalogSchema.parse(value);
    for (let index = 1; index < catalog.tasks.length; index++) {
        if (catalog.tasks[index - 1].id >= catalog.tasks[index].id)
            throw new Error('Task catalog must be sorted with unique task IDs');
    }
    const body = { version: catalog.version, sdkAbi: catalog.sdkAbi, tasks: catalog.tasks };
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (digest !== catalog.revision) throw new Error('Task catalog revision mismatch');
    return catalog;
}
