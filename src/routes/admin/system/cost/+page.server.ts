// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readProviderCalls } from '$lib/server/utils/provider-calls.js';
import type { ProviderCallsResponse } from '$lib/schemas/provider-calls.js';
import { denyUnlessAdmin } from '$lib/server/admin/admin-action-gate.js';
import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import {
    listCostAggregations,
    listRecentCostlyRuns,
    getAssistantUsage,
} from '$lib/server/database/queries/cost-ledger.queries.js';
import { getAiConfig } from '$lib/server/config/domains/ai.js';
import { config } from '$lib/server/config.js';
import { saveConfig } from '$lib/server/config/index.js';
import {
    estimateEmbeddingCostUsd,
    embeddingPricePerMillion,
    embeddingPriceSource,
    parseCostPriceOverrides,
} from '$lib/server/ai/cost.js';
import { getRegistry } from '$lib/server/tasks/registry.js';
import {
    computeTaskRunRates,
    type TaskRunRateRow,
} from '$lib/server/tasks/observability/run-rate.js';
import { auditLog, auditActorFromLocals } from '$lib/server/utils/audit-log.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { Actions } from './$types';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';
import {
    buildProviderCallRows,
    readRequestPathCalls,
    REQUEST_PATH_RETENTION_DAYS,
    type ExternalCallOutcomeCounts,
    type ProviderCallRow,
    type TaskHostCallTotals,
} from '$lib/server/utils/external-request-stats.js';

const logger = Logger.for('AdminCost');

/**
 * Admin IA redesign (spec §7 "no raw internal ids in operator copy"): resolve
 * a task id to its registered friendly name. Falls back to the raw id for
 * external-plugin tasks or ids that no longer exist in the registry (e.g. a
 * removed builtin whose cost history is still on record) — the id itself is
 * ALWAYS shown too (title attribute) so a raw-id grep/support search still works.
 */
function taskNameFor(taskId: string): string {
    return taskDisplayName(taskId, getRegistry().getTask(taskId)?.name);
}

const DEFAULT_SINCE_DAYS = 7;
const RECENT_RUNS_LIMIT = 25;

/** A recent expensive run, flattened for the cost drill-down table. */
export interface RecentCostlyRunView {
    runId: string;
    taskId: string;
    /** Friendly task name from the registry; falls back to `taskId`. */
    taskName: string;
    completedAt: string;
    breakdown: Array<{ costUnit: string; value: number }>;
}

/** AI token spend — the only real dollar cost (embeddings + assistant). */
export interface AiCostSummary {
    embeddingModel: string;
    /** null = the configured embedding model is local/unrecognised → no $ assigned. */
    embeddingPricePerMillion: number | null;
    /** Where `embeddingPricePerMillion` came from — null when unpriced. */
    embeddingPriceSource: 'custom' | 'built-in' | null;
    embeddingTokens: number;
    embeddingCostUsd: number;
    assistantTokens: number;
    assistantCostUsd: number;
    assistantMessages: number;
    totalCostUsd: number;
}

/** Per-destination-host request count within a task. */
export interface ApiRequestDomain {
    domain: string;
    count: number;
}

/** External API request volume — count only, NO dollar cost (no pricing data). */
export interface ApiRequestRow {
    taskId: string;
    /** Friendly task name from the registry; falls back to `taskId`. */
    taskName: string;
    count: number;
    avgPerDay: number;
    /** Breakdown of `count` by destination host (e.g. api.themoviedb.org). */
    byDomain: ApiRequestDomain[];
}
export interface ApiRequestSummary {
    total: number;
    avgPerDay: number;
    byTask: ApiRequestRow[];
}

/** Any other recorded cost unit (e.g. cpu_seconds), with a friendly task name. */
export interface OtherUsageRow {
    taskId: string;
    taskName: string;
    costUnit: string;
    totalUnits: number;
}

/**
 * Calls per provider host: background-task calls (cost_breakdown, `sinceDays`)
 * next to request-path calls (hourly stats, clamped to the retention), with
 * failed calls and 429s for both.
 */
export interface ProviderCallSummary {
    /** Window of the background-task side, in days (the page's window). */
    sinceDays: number;
    /** Window of the request-path side: the page's window clamped to the 8-day retention. */
    liveWindowDays: number;
    taskCalls: number;
    liveCalls: number;
    errors: number;
    rateLimited: number;
    rows: ProviderCallRow[];
}

export interface CostPageData {
    providerCalls: ProviderCallsResponse | null;
    sinceDays: number;
    ai: AiCostSummary;
    apiRequests: ApiRequestSummary;
    /** Per-provider calls, errors and 429s (tasks + request path). */
    providers: ProviderCallSummary;
    /** Any other recorded cost units (e.g. cpu_seconds) — shown as raw totals. */
    otherUnits: OtherUsageRow[];
    recentRuns: RecentCostlyRunView[];
    /** Per-task runs (24h) vs declared schedule — surfaces sweep-driven over-firing. */
    runRates: TaskRunRateRow[];
    /** True when the run-rate computation failed — distinct from "nothing over-firing". */
    runRatesError: boolean;
    dbError: string | null;
}

function emptyProviders(sinceDays: number): ProviderCallSummary {
    return {
        sinceDays,
        liveWindowDays: Math.min(sinceDays, REQUEST_PATH_RETENTION_DAYS),
        taskCalls: 0,
        liveCalls: 0,
        errors: 0,
        rateLimited: 0,
        rows: [],
    };
}

const EMPTY_AI: AiCostSummary = {
    embeddingModel: '',
    embeddingPricePerMillion: null,
    embeddingPriceSource: null,
    embeddingTokens: 0,
    embeddingCostUsd: 0,
    assistantTokens: 0,
    assistantCostUsd: 0,
    assistantMessages: 0,
    totalCostUsd: 0,
};

export const load = async ({ url }: { url: URL }): Promise<CostPageData> => {
    const rawDays = url.searchParams.get('days');
    const parsed = rawDays !== null ? Number.parseInt(rawDays, 10) : NaN;
    const sinceDays = Number.isFinite(parsed)
        ? Math.min(Math.max(1, parsed), 3650)
        : DEFAULT_SINCE_DAYS;

    const providerCalls = await readProviderCalls(24).catch(() => null);
    const sql = getDb();
    if (!sql) {
        return {
            providerCalls,
            sinceDays,
            ai: EMPTY_AI,
            apiRequests: { total: 0, avgPerDay: 0, byTask: [] },
            providers: emptyProviders(sinceDays),
            otherUnits: [],
            recentRuns: [],
            runRates: [],
            runRatesError: false,
            dbError: 'Database unavailable',
        };
    }

    try {
        let runRatesError = false;
        const [aggregations, costly, assistant, runRates, requestPath] = await Promise.all([
            listCostAggregations(sql, { sinceDays }),
            listRecentCostlyRuns(sql, { limit: RECENT_RUNS_LIMIT }),
            getAssistantUsage(sql, { sinceDays }),
            // Fail-soft: over-firing is a diagnostic, never a reason to 500 the page.
            computeTaskRunRates(sql).catch((err) => {
                logger.warn('run-rate computation failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
                runRatesError = true;
                return [] as TaskRunRateRow[];
            }),
            // Request-path provider calls from Valkey hourly stats. Never throws.
            readRequestPathCalls(sinceDays),
        ]);

        // ── AI tokens (the real $) ───────────────────────────────────────────
        // `openai_tokens` in cost_breakdown is recorded only by embedding tasks.
        const embeddingTokens = aggregations
            .filter((a) => a.costUnit === 'openai_tokens')
            .reduce((sum, a) => sum + a.totalUnits, 0);
        const embeddingModel = getAiConfig().embeddingModel ?? '';
        // Operator-defined AI_COST_PRICE_OVERRIDES (settings.json), consulted
        // before the built-in table — see ai/cost.ts.
        const priceOverrides = parseCostPriceOverrides(config.AI_COST_PRICE_OVERRIDES);
        const embeddingCostUsd = estimateEmbeddingCostUsd(
            embeddingModel,
            embeddingTokens,
            priceOverrides,
        );

        const ai: AiCostSummary = {
            embeddingModel,
            embeddingPricePerMillion: embeddingPricePerMillion(embeddingModel, priceOverrides),
            embeddingPriceSource: embeddingPriceSource(embeddingModel, priceOverrides),
            embeddingTokens,
            embeddingCostUsd,
            assistantTokens: assistant.totalTokens,
            assistantCostUsd: assistant.totalCostUsd,
            assistantMessages: assistant.messageCount,
            totalCostUsd: embeddingCostUsd + assistant.totalCostUsd,
        };

        // ── API requests (count only, avg/day; no $) ─────────────────────────
        // The bare `api_calls` unit is the per-task total; `api_calls:<host>`
        // units carry the per-domain breakdown. Group the latter by task.
        const API_HOST_PREFIX = 'api_calls:';
        // Per-host failed calls and the 429 subset, recorded alongside api_calls.
        const API_ERRORS_PREFIX = 'api_errors:';
        const API_429_PREFIX = 'api_429:';
        const domainsByTask = new Map<string, ApiRequestDomain[]>();
        for (const a of aggregations) {
            if (!a.costUnit.startsWith(API_HOST_PREFIX)) continue;
            const domain = a.costUnit.slice(API_HOST_PREFIX.length);
            const list = domainsByTask.get(a.taskId) ?? [];
            list.push({ domain, count: a.totalUnits });
            domainsByTask.set(a.taskId, list);
        }
        const apiRows = aggregations.filter((a) => a.costUnit === 'api_calls');
        const byTask: ApiRequestRow[] = apiRows
            .map((a) => ({
                taskId: a.taskId,
                taskName: taskNameFor(a.taskId),
                count: a.totalUnits,
                avgPerDay: a.totalUnits / sinceDays,
                byDomain: (domainsByTask.get(a.taskId) ?? []).sort((x, y) => y.count - x.count),
            }))
            .sort((x, y) => y.count - x.count);
        const apiTotal = byTask.reduce((sum, r) => sum + r.count, 0);

        // ── Provider calls: task side per host (calls, errors, 429s) ─────────
        const taskTotals = new Map<string, TaskHostCallTotals>();
        const taskHost = (host: string): TaskHostCallTotals => {
            let t = taskTotals.get(host);
            if (!t) taskTotals.set(host, (t = { host, calls: 0, errors: 0, rateLimited: 0 }));
            return t;
        };
        for (const a of aggregations) {
            if (a.costUnit.startsWith(API_HOST_PREFIX)) {
                taskHost(a.costUnit.slice(API_HOST_PREFIX.length)).calls += a.totalUnits;
            } else if (a.costUnit.startsWith(API_ERRORS_PREFIX)) {
                taskHost(a.costUnit.slice(API_ERRORS_PREFIX.length)).errors += a.totalUnits;
            } else if (a.costUnit.startsWith(API_429_PREFIX)) {
                taskHost(a.costUnit.slice(API_429_PREFIX.length)).rateLimited += a.totalUnits;
            }
        }
        const liveByHost: ReadonlyMap<string, ExternalCallOutcomeCounts> = requestPath.byHost;
        const providerRows = buildProviderCallRows([...taskTotals.values()], liveByHost);
        const providers: ProviderCallSummary = {
            sinceDays,
            liveWindowDays: requestPath.windowDays,
            taskCalls: providerRows.reduce((sum, r) => sum + r.taskCalls, 0),
            liveCalls: providerRows.reduce((sum, r) => sum + r.liveCalls, 0),
            errors: providerRows.reduce((sum, r) => sum + r.errors, 0),
            rateLimited: providerRows.reduce((sum, r) => sum + r.rateLimited, 0),
            rows: providerRows,
        };

        // ── Anything else recorded (e.g. cpu_seconds) ────────────────────────
        const otherUnits: OtherUsageRow[] = aggregations
            .filter(
                (a) =>
                    a.costUnit !== 'openai_tokens' &&
                    a.costUnit !== 'api_calls' &&
                    !a.costUnit.startsWith(API_HOST_PREFIX) &&
                    !a.costUnit.startsWith(API_ERRORS_PREFIX) &&
                    !a.costUnit.startsWith(API_429_PREFIX),
            )
            .map((a) => ({
                taskId: a.taskId,
                taskName: taskNameFor(a.taskId),
                costUnit: a.costUnit,
                totalUnits: a.totalUnits,
            }));

        const recentRuns: RecentCostlyRunView[] = costly.map((r) => {
            const entries = Object.entries(r.costBreakdown)
                // Drop zero-value units so a completed-but-no-work run doesn't
                // render a noisy "0 openai_tokens" chip.
                .filter(([, value]) => value > 0);
            // When a run has per-host `api_calls:<host>` units, drop the bare
            // `api_calls` total (its sum) to avoid a redundant chip, and show
            // each host by its bare domain name.
            const hasPerHost = entries.some(([unit]) => unit.startsWith(API_HOST_PREFIX));
            return {
                runId: r.runId,
                taskId: r.taskId,
                taskName: taskNameFor(r.taskId),
                completedAt: r.completedAt.toISOString(),
                breakdown: entries
                    // Errors and 429s are shown in the per-provider table, not as chips.
                    .filter(
                        ([unit]) =>
                            !unit.startsWith(API_ERRORS_PREFIX) && !unit.startsWith(API_429_PREFIX),
                    )
                    .filter(([unit]) => !(hasPerHost && unit === 'api_calls'))
                    .map(([unit, value]) => ({
                        costUnit: unit.startsWith(API_HOST_PREFIX)
                            ? unit.slice(API_HOST_PREFIX.length)
                            : unit,
                        value,
                    })),
            };
        });

        return {
            providerCalls,
            sinceDays,
            ai,
            apiRequests: {
                total: apiTotal,
                avgPerDay: apiTotal / sinceDays,
                byTask,
            },
            providers,
            otherUnits,
            recentRuns,
            runRates,
            runRatesError,
            dbError: null,
        };
    } catch (err) {
        return {
            providerCalls,
            sinceDays,
            ai: EMPTY_AI,
            apiRequests: { total: 0, avgPerDay: 0, byTask: [] },
            providers: emptyProviders(sinceDays),
            otherUnits: [],
            recentRuns: [],
            runRates: [],
            runRatesError: false,
            dbError: err instanceof Error ? err.message : 'Failed to load cost data',
        };
    }
};

/** Cap the assignable price so a fat-fingered value can't silently poison the ledger. */
const MAX_ASSIGNABLE_PRICE_PER_MILLION = 10_000;

export const actions: Actions = {
    /**
     * Assign (or update) an operator-defined USD-per-1M-token price for a
     * model the built-in pricing table doesn't recognise — the "Assign
     * price" button on an unpriced cost-page row. Persists through the SAME
     * settings pipeline as the main Settings page (`saveConfig` →
     * settings.json, cross-replica invalidation via CONFIG_CHANGED_CHANNEL),
     * just scoped to the single `AI_COST_PRICE_OVERRIDES` key so this form
     * doesn't need to round-trip the rest of the config schema.
     */
    assignPrice: async ({ request, locals }) => {
        const denied = denyUnlessAdmin(locals);
        if (denied) return denied;
        const formData = await request.formData();
        const modelRaw = formData.get('model');
        const priceRaw = formData.get('pricePerMillion');

        const model = typeof modelRaw === 'string' ? modelRaw.trim() : '';
        // Reject empty/very short prefixes: `startsWith('')` matches every
        // model name, so an empty (or 1-char) prefix would silently reprice
        // every model in the built-in tables too, not just the intended one.
        if (model.length < 2) {
            return fail(400, { error: 'Missing or too-short model name' });
        }
        // Number('') is 0, so a blank field must not pass as a $0 override.
        const priceStr = typeof priceRaw === 'string' ? priceRaw.trim() : '';
        const price = priceStr === '' ? NaN : Number(priceStr);
        if (!Number.isFinite(price) || price < 0 || price > MAX_ASSIGNABLE_PRICE_PER_MILLION) {
            return fail(400, {
                error: `Price must be a number between 0 and ${MAX_ASSIGNABLE_PRICE_PER_MILLION}`,
            });
        }

        // Merge into the existing override list: replace any prior entry for
        // this exact model (case-insensitive), keep every other entry as-is,
        // then append the new one. Re-serialize through parseCostPriceOverrides
        // first so a malformed pre-existing entry doesn't silently persist
        // forever untouched.
        const modelKey = model.toLowerCase();
        const existing = parseCostPriceOverrides(config.AI_COST_PRICE_OVERRIDES);
        const next = existing.filter((o) => o.prefix !== modelKey);
        next.push({ prefix: modelKey, perMillion: price });
        const nextList = next.map((o) => `${o.prefix}=${o.perMillion}`);

        try {
            await saveConfig({ AI_COST_PRICE_OVERRIDES: nextList });
        } catch (err) {
            logger.error('Failed to save AI cost price override', err as Error);
            return fail(500, {
                error: err instanceof Error ? err.message : 'Failed to save price override',
            });
        }

        auditLog('settings.save', 'config', auditActorFromLocals(locals), {
            changedKeys: ['AI_COST_PRICE_OVERRIDES'],
            assignedModel: modelKey,
            pricePerMillion: price,
        });

        return { success: true, model: modelKey, pricePerMillion: price };
    },
};
