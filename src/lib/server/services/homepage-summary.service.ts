// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Homepage integration summary — builds the payload of GET /api/v1/integrations/homepage
 * for gethomepage.dev's generic `customapi` widget.
 *
 * Two layers:
 *  - buildHomepageSummary(): pure projection of already-fetched inputs into the wire
 *    shape. Every label rule lives (and is tested) here.
 *  - getHomepageSummary(): fetches each section independently and caches in-process —
 *    live data 5 s, library data 5 min — so several dashboard tiles polling every
 *    10 s cost one build per pod (each replica keeps its own cache). A failing or slow
 *    (> 3 s) section degrades to its empty value plus a `homepage:<section>` alert; it
 *    never fails the response.
 */

import type postgres from 'postgres';
import type { Run } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { getStreamingSummary } from '$lib/server/services/streaming-summary.service.js';
import {
    readClusterNodes,
    type LiveClusterNode,
} from '$lib/server/services/cluster-heartbeat.service.js';
import { getInstancesExpectedOnline } from '$lib/server/database/queries/cluster-nodes.queries.js';
import {
    getHomepageLibrarySnapshot,
    type HomepageLibrarySnapshot,
} from '$lib/server/database/queries/homepage-library.queries.js';
import {
    getHomepageTaskCounts,
    type HomepageTaskCounts,
} from '$lib/server/database/queries/homepage-tasks.queries.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { buildComponentHealth } from '$lib/server/health/component-health.js';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';
import type { StreamingSummary } from '$lib/schemas/api-streaming-responses.js';
import type {
    HomepageHealth,
    HomepageListItem,
    HomepageSummary,
} from '$lib/schemas/api-homepage-responses.js';

const logger = Logger.for('HomepageSummary');

export const HOMEPAGE_LIST_CAP = 10;
const LIVE_TTL_MS = 5_000;
const LIBRARY_TTL_MS = 5 * 60_000;
/** Expected-online nodes only change on a node join/leave — no need to query it every 5 s. */
const NODES_EXPECTED_TTL_MS = 60_000;
/** A section slower than this is reported unavailable instead of stalling the response. */
const SECTION_TIMEOUT_MS = 3_000;
const ALERT_LABEL_MAX = 80;
const GIB = 1024 ** 3;

export interface ComponentHealthLike {
    status: 'pass' | 'warn' | 'fail';
    reason?: string;
    error?: string;
}

/** Inputs of the pure builder. `null` = that section could not be read. */
export interface HomepageInputs {
    streaming: StreamingSummary | null;
    nodes: LiveClusterNode[] | null;
    nodesExpected: number | null;
    /** Running runs to LIST (capped); the exact numbers come from `taskCounts`. */
    runs: Run[] | null;
    taskCounts: HomepageTaskCounts | null;
    queues: { waiting: number; paused: string[] } | null;
    components: Record<string, ComponentHealthLike> | null;
    library: HomepageLibrarySnapshot | null;
    version: string;
    now: Date;
    taskName: (taskId: string, fallback?: string | null) => string;
}

/** Components whose failure means the server cannot serve anything. */
const CRITICAL_COMPONENTS = new Set(['database', 'valkey']);

/** 3d / 5h / 12m — the largest whole unit. */
export function formatUptime(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    if (s >= 86_400) return `${Math.floor(s / 86_400)}d`;
    if (s >= 3_600) return `${Math.floor(s / 3_600)}h`;
    return `${Math.floor(s / 60)}m`;
}

function round1(n: number): string {
    return (Math.round(n * 10) / 10).toFixed(1);
}

/** Non-negative integer for a `count` field — NaN/Infinity/negative would fail the wire schema. */
function count(n: number | null | undefined): number {
    return n != null && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Non-negative finite number. */
function nonNegative(n: number | null | undefined): number {
    return n != null && Number.isFinite(n) && n > 0 ? n : 0;
}

/** 0..100 integer percentage, or null when the inputs can't produce one. */
function percent(fraction: number): number | null {
    if (!Number.isFinite(fraction)) return null;
    return Math.min(100, Math.max(0, Math.floor(fraction * 100)));
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sessionItems(streaming: StreamingSummary): HomepageListItem[] {
    return streaming.streams.map((s) => {
        const parts: string[] = [s.method];
        if (s.bitrateMbps != null) parts.push(`${round1(s.bitrateMbps)} Mbps`);
        const pct = s.progress != null ? percent(s.progress) : null;
        if (pct != null) parts.push(`${pct}%`);
        if (s.paused) parts.push('paused');
        return { name: `${s.username} · ${s.title}`, label: parts.join(' · ') };
    });
}

function nodeItem(n: LiveClusterNode): HomepageListItem {
    const parts: string[] = [n.role];
    const r = n.resources;
    if (r?.cpuUsedCores != null && Number.isFinite(r.cpuUsedCores)) {
        parts.push(`${round1(Math.max(0, r.cpuUsedCores))} cores`);
    }
    if (r && Number.isFinite(r.memoryUsedBytes)) {
        const used = round1(Math.max(0, r.memoryUsedBytes) / GIB);
        const limit = r.memoryLimitBytes;
        parts.push(
            limit != null && Number.isFinite(limit) && limit > 0
                ? `${used}/${round1(limit / GIB)} GiB`
                : `${used} GiB`,
        );
    }
    parts.push(`up ${formatUptime(n.uptimeSeconds)}`);
    return { name: nodeName(n), label: parts.join(' · ') };
}

function nodeName(n: LiveClusterNode): string {
    return n.hostname?.trim() || n.instanceId || 'unknown';
}

function taskItem(run: Run, taskName: HomepageInputs['taskName']): HomepageListItem {
    const name = taskName(run.taskId, run.label);
    if (run.state === 'cancelling') return { name, label: 'cancelling' };
    const stage = run.stages.find((st) => st.state === 'active');
    if (!stage) return { name, label: 'running' };
    const pct =
        stage.total != null && stage.total > 0 && stage.processed != null
            ? percent(stage.processed / stage.total)
            : null;
    return { name, label: pct != null ? `${stage.label} · ${pct}%` : stage.label };
}

function recentName(row: HomepageLibrarySnapshot['recent'][number]): string {
    return row.media_type === 'movie' && row.year != null
        ? `${row.title} (${row.year})`
        : row.title;
}

export function buildHomepageSummary(inputs: HomepageInputs): HomepageSummary {
    const cap = <T>(items: T[]): T[] => items.slice(0, HOMEPAGE_LIST_CAP);

    const streaming = inputs.streaming;
    const nodes = inputs.nodes ?? [];
    const runs = inputs.runs ?? [];
    const library = inputs.library;

    // Component alerts first (they say what is wrong), then cluster/queue conditions,
    // then sections we failed to read.
    const alerts: HomepageListItem[] = [];
    const alert = (name: string, label: string): void => {
        alerts.push({ name, label: truncate(label, ALERT_LABEL_MAX) });
    };
    let critical = false;
    for (const [name, c] of Object.entries(inputs.components ?? {})) {
        if (c.status !== 'warn' && c.status !== 'fail') continue;
        if (c.status === 'fail' && CRITICAL_COMPONENTS.has(name)) critical = true;
        alert(name, `${c.status}: ${c.reason ?? c.error ?? 'no detail'}`);
    }
    if (inputs.nodes && inputs.nodesExpected != null && nodes.length < inputs.nodesExpected) {
        alert('cluster', `warn: ${nodes.length} of ${inputs.nodesExpected} nodes up`);
    }
    for (const queue of inputs.queues?.paused ?? []) alert(`queue:${queue}`, 'warn: paused');
    const sections: Array<[string, unknown]> = [
        ['health', inputs.components],
        ['sessions', inputs.streaming],
        ['nodes', inputs.nodes],
        ['nodesExpected', inputs.nodesExpected],
        ['tasks', inputs.runs],
        ['taskCounts', inputs.taskCounts],
        ['queues', inputs.queues],
        ['library', inputs.library],
    ];
    for (const [section, value] of sections) {
        if (value === null) alert(`homepage:${section}`, 'fail: unavailable');
    }
    const health: HomepageHealth = critical ? 'down' : alerts.length > 0 ? 'degraded' : 'ok';

    const streams = count(streaming?.streamCount);
    const transcodes = Math.min(count(streaming?.transcodeCount), streams);

    return {
        generatedAt: inputs.now.toISOString(),
        summary: {
            streams,
            transcodes,
            directPlays: streams - transcodes,
            users: count(streaming?.userCount),
            bandwidthMbps: nonNegative(streaming?.bandwidthMbps),
            nodesUp: nodes.length,
            nodesExpected: Math.max(count(inputs.nodesExpected), nodes.length),
            tasksRunning: inputs.taskCounts ? count(inputs.taskCounts.running) : runs.length,
            tasksQueued: count(inputs.queues?.waiting),
            tasksFailed24h: count(inputs.taskCounts?.failed24h),
            alerts: alerts.length,
            health,
            version: inputs.version || 'unknown',
        },
        sessions: cap(streaming ? sessionItems(streaming) : []),
        nodes: cap([...nodes].sort((a, b) => nodeName(a).localeCompare(nodeName(b))).map(nodeItem)),
        tasks: cap(runs.map((r) => taskItem(r, inputs.taskName))),
        alerts: cap(alerts),
        library: {
            movies: count(library?.counts.movies),
            series: count(library?.counts.series),
            episodes: count(library?.counts.episodes),
            artists: count(library?.counts.artists),
            albums: count(library?.counts.albums),
            tracks: count(library?.counts.tracks),
            audiobooks: count(library?.counts.audiobooks),
        },
        recentlyAdded: cap(
            (library?.recent ?? []).flatMap((r) => {
                const addedAt = new Date(r.added_at);
                if (Number.isNaN(addedAt.getTime())) return [];
                return [{ name: recentName(r), addedAt: addedAt.toISOString() }];
            }),
        ),
    };
}

// ── Fetch + cache ────────────────────────────────────────────────────────────

interface TtlCache<T> {
    get(load: () => Promise<T>): Promise<T>;
    reset(): void;
}

/** Keeps a value for `ttlMs`, shares one in-flight load, never caches a rejection. */
function ttlCache<T>(ttlMs: number): TtlCache<T> {
    let value: { at: number; data: T } | null = null;
    let inflight: Promise<T> | null = null;
    return {
        get(load) {
            if (value && Date.now() - value.at < ttlMs) return Promise.resolve(value.data);
            if (inflight) return inflight;
            inflight = load()
                .then((data) => {
                    value = { at: Date.now(), data };
                    return data;
                })
                .finally(() => {
                    inflight = null;
                });
            return inflight;
        },
        reset() {
            value = null;
            inflight = null;
        },
    };
}

const summaryCache = ttlCache<HomepageSummary>(LIVE_TTL_MS);
const libraryCache = ttlCache<HomepageLibrarySnapshot>(LIBRARY_TTL_MS);
const nodesExpectedCache = ttlCache<number>(NODES_EXPECTED_TTL_MS);

/** Test hook — drop every cache. */
export function __resetHomepageCachesForTests(): void {
    summaryCache.reset();
    libraryCache.reset();
    nodesExpectedCache.reset();
}

/**
 * Run one section, mapping a failure OR a hang to `null`. Without the timeout a stuck
 * dependency would wedge the shared in-flight build, and with it every later caller.
 */
async function section<T>(name: string, load: () => Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`timed out after ${SECTION_TIMEOUT_MS} ms`)),
            SECTION_TIMEOUT_MS,
        );
    });
    try {
        return await Promise.race([load(), timeout]);
    } catch (err) {
        logger.warn('homepage summary section failed', {
            section: name,
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function loadSummary(sql: postgres.Sql): Promise<HomepageSummary> {
    const now = new Date();
    const [streaming, nodes, nodesExpected, runs, taskCounts, queues, components, library] =
        await Promise.all([
            section('sessions', () => getStreamingSummary(sql, HOMEPAGE_LIST_CAP)),
            section('nodes', () => readClusterNodes()),
            section('nodesExpected', () =>
                nodesExpectedCache.get(async () => (await getInstancesExpectedOnline(sql)).length),
            ),
            section('tasks', async () => {
                const { runs } = await orchestrator.listRuns({
                    state: ['active', 'cancelling'],
                    limit: HOMEPAGE_LIST_CAP,
                });
                return runs;
            }),
            section('taskCounts', () => getHomepageTaskCounts(sql)),
            section('queues', async () => {
                const depths = await orchestrator.getQueueDepths();
                let waiting = 0;
                const paused: string[] = [];
                for (const [queue, d] of Object.entries(depths)) {
                    waiting += d?.waiting ?? 0;
                    if (d?.paused) paused.push(queue);
                }
                return { waiting, paused };
            }),
            section('health', async () => {
                const { timestamp: _ts, ...entries } = (await buildComponentHealth()) as {
                    timestamp?: string;
                } & Record<string, unknown>;
                const out: Record<string, ComponentHealthLike> = {};
                for (const [name, value] of Object.entries(entries)) {
                    if (value && typeof value === 'object' && 'status' in value) {
                        out[name] = value as ComponentHealthLike;
                    }
                }
                return out;
            }),
            section('library', () => libraryCache.get(() => getHomepageLibrarySnapshot(sql))),
        ]);

    return buildHomepageSummary({
        streaming,
        nodes,
        nodesExpected,
        runs,
        taskCounts,
        queues,
        components,
        library,
        version: config.APP_VERSION,
        now,
        taskName: taskDisplayName,
    });
}

/** The cached summary (5 s live / 5 min library). `sql` should be the admin pool. */
export function getHomepageSummary(sql: postgres.Sql): Promise<HomepageSummary> {
    return summaryCache.get(() => loadSummary(sql));
}
