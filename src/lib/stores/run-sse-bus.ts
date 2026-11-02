// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { browser } from '$app/environment';
import { writable, derived } from 'svelte/store';
import { CloudEventSchema } from '$lib/schemas/cloud-events.schema.js';
import { RunSchema, type Run, type RunState } from '$lib/schemas/run.schema.js';
// The redacted lifecycle-event projection. Imported from the SDK directly
// because `$lib/schemas/run.schema.js` re-exports only the full-run shapes;
// SSE frames carry this narrower contract (no input/result/error.stack).
import { RunEventSchema } from '@sapd/lumastra-plugin-sdk';
import type { BusEvent } from '$lib/schemas/mission-control.schema.js';
import { apiUrl } from '$lib/shared/api-urls.js';

export type { Run, RunState };
export type { BusEvent };

export interface RunSSEBus {
    connect(): void;
    disconnect(): void;
    /** Re-attempt connection after exhausting reconnect budget. */
    manualRetry(): void;
    readonly connected: boolean;
    readonly runs: Map<string, Run>;
    /** All runs in pending or active state. */
    readonly activeRuns: Run[];
    /**
     * Bounded ring (newest-last) of normalized run-failure / run-completion /
     * meta autonomous-action events the bus has observed since connect. The
     * Slice-4 Mission Control error/action ticker reads this — a pure
     * projection of events the bus already receives (no new stream, no new
     * server work). Capped at {@link RECENT_EVENTS_CAP}, FIFO-evicting oldest.
     */
    readonly recentEvents: BusEvent[];
    /**
     * Register a callback fired each time a new {@link BusEvent} is pushed to
     * the ring. Returns an unsubscribe. Inert for consumers that don't use it.
     */
    onEvent(callback: (event: BusEvent) => void): () => void;
    /**
     * True once the bus has exhausted its reconnect budget
     * (`MAX_RECONNECT_ATTEMPTS`) and stopped retrying. Drives the page-level
     * stale banner + `Reconnect` button. Cleared by `manualRetry()`.
     */
    readonly reconnectExhausted: boolean;
    /**
     * Fires on every bus change including progress events (~60 Hz max via
     * rAF). Use this for derived state that needs to track live progress
     * (e.g. taskAggregates).
     */
    onAnyChange(callback: () => void): () => void;
    /**
     * Fires ONLY on run state transitions (started/completed/failed/cancelled
     * etc.) — never on progress events. Use this for expensive side effects
     * like server reloads that should not be triggered by ~4 Hz progress
     * traffic. Without this distinction, a continuously-progressing run
     * would keep a 500ms refresh debounce permanently hot, preventing
     * the lane catalog from ever refreshing.
     */
    onTransitionChange(callback: () => void): () => void;
    /** Optimistically insert or update a run in the local map. */
    upsertRun(run: Run): void;
}

// EventSource bypasses the global fetch interceptor, so this must carry the
// install base path itself or SSE dies on a subpath install.
const SSE_URL = apiUrl('internal', '/runs/stream');
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Bounded `recentEvents` ring size — caps growth during a failure storm. */
const RECENT_EVENTS_CAP = 200;
/**
 * Polling-fallback interval used when the SSE stream is unavailable.
 *
 * The reverse proxy bypasses Authentik for /api/v1/*, so the admin SSE
 * EventSource — which cannot send an Authorization header and relied on the
 * Authentik cookie reaching the stream — may now fail/401 on some deployments.
 * Rather than build a token-SSE path, we DEGRADE: when the stream errors we
 * poll the same REST surface (/api/runs, same admin-cookie auth as every
 * other admin fetch) so the operations pages keep showing live-ish run state
 * instead of going stale/blank. Polling stops the moment SSE reconnects.
 */
const FALLBACK_POLL_INTERVAL_MS = 5_000;

/**
 * Map a run's `error.kind` onto the ticker severity. `transient` is a likely-
 * retryable blip (warn); `permanent`/`fatal` (and an absent kind, treated
 * conservatively) are hard failures (error).
 */
function severityForErrorKind(kind: string | undefined): BusEvent['severity'] {
    return kind === 'transient' ? 'warn' : 'error';
}

/**
 * Severity for a `meta` autonomous-action subtype. Leader churn / reclaim /
 * conflict are operationally noteworthy (warn); routine ticks (scheduler-tick,
 * node-registered, pipeline-when-skip) are informational. Unknown subtypes
 * default to info — a meta event should never masquerade as an error.
 */
function severityForMetaType(subtype: string): BusEvent['severity'] {
    switch (subtype) {
        case 'recovery-reclaimed':
        case 'transition-conflict':
        case 'subscription-lost':
            return 'warn';
        default:
            return 'info';
    }
}

function reconnectDelay(attempt: number): number {
    return Math.min(INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempt - 1), MAX_RECONNECT_DELAY_MS);
}

function parseJsonSafe(data: string): unknown {
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

function extractRun(data: unknown): Run | null {
    if (typeof data !== 'object' || data === null) return null;
    // Lifecycle frames carry the redacted RunEvent projection (no input, no
    // result, no error.stack), so parse against that contract — RunSchema
    // requires `input` and would reject every frame.
    const parsed = RunEventSchema.safeParse(data);
    return parsed.success ? (parsed.data as Run) : null;
}

const TERMINAL_STATES = new Set<string>(['completed', 'failed', 'cancelled']);

function isTerminal(run: Run): boolean {
    return TERMINAL_STATES.has(run.state);
}

/**
 * Merge an incoming run over the one already in the map.
 *
 * Lifecycle frames carry the redacted `RunEvent` projection, which deliberately
 * omits `input` and `result` (they are unbounded and broadcast to any
 * `runs:read` token). The map is ALSO filled from REST, which does carry them,
 * and the admin runs UI reads both — `RunCard`'s item-context chip reads
 * `run.input`, and `run-items-processed` prefers `result.itemsProcessed`.
 *
 * So a lifecycle frame must not replace wholesale: doing so silently blanks
 * those fields the moment any frame lands, and no REST refresh restores them
 * (RunList's mergeFreshest treats a terminal SSE row as authoritative).
 * Carry forward whatever the incoming payload cannot express.
 */
function mergeRunUpdate(existing: Run | undefined, incoming: Run): Run {
    if (!existing) return incoming;
    return {
        ...incoming,
        input: incoming.input ?? existing.input,
        result: incoming.result ?? existing.result,
        countSummary: incoming.countSummary ?? existing.countSummary,
    };
}

function createRunSSEBus(): RunSSEBus {
    const runsStore = writable(new Map<string, Run>());
    const connectedStore = writable(false);
    const changeCallbacks = new Set<() => void>();
    const transitionCallbacks = new Set<() => void>();

    const activeRunsStore = derived(runsStore, ($runs) =>
        Array.from($runs.values()).filter(
            (r) => r.state === 'pending' || r.state === 'active' || r.state === 'cancelling',
        ),
    );

    let eventSource: EventSource | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let manuallyDisconnected = false;
    let lastEventId = '0';

    let _runs: Map<string, Run> = new Map();
    let _activeRuns: Run[] = [];
    let _connected = false;

    // ── Recent-events ring (ticker projection) + reconnect-exhaustion flag ──
    const eventCallbacks = new Set<(event: BusEvent) => void>();
    let _recentEvents: BusEvent[] = [];
    let _reconnectExhausted = false;
    let _eventSeq = 0;

    function pushBusEvent(event: BusEvent): void {
        // Append newest-last; FIFO-evict the oldest beyond the cap so a failure
        // storm can't grow the ring unbounded.
        _recentEvents = [..._recentEvents, event];
        if (_recentEvents.length > RECENT_EVENTS_CAP) {
            _recentEvents = _recentEvents.slice(_recentEvents.length - RECENT_EVENTS_CAP);
        }
        for (const cb of eventCallbacks) {
            try {
                cb(event);
            } catch (err) {
                console.error('[RunSSEBus] Event callback error:', err);
            }
        }
    }

    runsStore.subscribe((v) => {
        _runs = v;
    });
    activeRunsStore.subscribe((v) => {
        _activeRuns = v;
    });
    // Track connection-state changes and propagate them to change
    // subscribers. Without the `notifyChange()` call, consumers like the
    // System Health page that do
    //     bus.onAnyChange(() => { sseConnected = bus.connected; })
    // never observe the false→true transition that happens on
    // `EventSource.onopen` until the next CloudEvent happens to arrive.
    // On a quiet system (no runs in progress) that meant the page sat
    // on the initial `connectedStore = false` reading forever, showing
    // "Reconnecting…" indefinitely even though the stream was healthy.
    let _firstConnectedTick = true;
    connectedStore.subscribe((v) => {
        const changed = _connected !== v;
        _connected = v;
        // Skip the very first emission (initial writable() value) so we
        // don't fire spurious "change" events before connect() is even
        // called. Any genuine transition after that does notify.
        if (_firstConnectedTick) {
            _firstConnectedTick = false;
            return;
        }
        if (changed) notifyChange();
    });

    function notifyChange(): void {
        for (const cb of changeCallbacks) {
            try {
                cb();
            } catch (err) {
                console.error('[RunSSEBus] Change callback error:', err);
            }
        }
    }

    /**
     * Notify the transition-only subset of callbacks AND the generic
     * changeCallbacks. Use for run state transitions; progress events should
     * call notifyChange directly so they don't trigger transition callbacks.
     */
    function notifyTransition(): void {
        for (const cb of transitionCallbacks) {
            try {
                cb();
            } catch (err) {
                console.error('[RunSSEBus] Transition callback error:', err);
            }
        }
        notifyChange();
    }

    function runTimestamp(r: Run): number {
        // completedAt first: a terminal run usually carries BOTH completedAt and
        // an older heartbeatAt, and reading heartbeat first made terminal frames
        // compare as older than the active row already in the map.
        const ts = r.completedAt ?? r.heartbeatAt ?? r.startedAt;
        return ts ? Date.parse(ts) : 0;
    }

    // ── Progress event throttling ─────────────────────────────────────────
    //
    // Progress events fire every 250ms per active run. With N concurrent
    // runs that's 4N events/sec hitting Svelte's effect scheduler — enough
    // to trip "effect update depth exceeded" once N gets into the dozens.
    //
    // Strategy: buffer progress updates per-runId, flush once per rAF tick
    // (~60fps cap). One runsStore.update + one notifyChange per frame,
    // regardless of how many events arrive. State transitions stay
    // synchronous (rare and high-value).
    interface PendingStage {
        id: string;
        processed?: number;
        total?: number;
        currentItem?: string;
    }
    const pendingProgress = new Map<string, Map<string, PendingStage>>();
    let progressFlushScheduled = false;

    function scheduleProgressFlush(): void {
        if (progressFlushScheduled) return;
        progressFlushScheduled = true;
        const fire = (): void => {
            progressFlushScheduled = false;
            if (pendingProgress.size === 0) return;
            // Snapshot + clear before processing so any progress event that
            // arrives during runsStore.update queues into a fresh empty
            // buffer (which the next rAF will pick up). Avoids "lost an
            // update mid-flush" without needing a lock.
            const drained = new Map(pendingProgress);
            pendingProgress.clear();
            runsStore.update((current) => {
                const next = new Map(current);
                let mutated = false;
                for (const [runId, stageMap] of drained) {
                    const existing = next.get(runId);
                    if (!existing) continue; // run not in bus yet — skip
                    // Skip terminal runs. A run can transition completed/failed/
                    // cancelled SYNCHRONOUSLY (via applyCloudEvent) between the
                    // progress event being buffered and the rAF firing. The
                    // terminal Run carries the authoritative `stages` snapshot
                    // from task_history; merging in-flight progress over it
                    // would produce a misleading "completed but processed=N
                    // where N differs from the terminal snapshot" state.
                    if (
                        existing.state === 'completed' ||
                        existing.state === 'failed' ||
                        existing.state === 'cancelled'
                    ) {
                        continue;
                    }
                    const stagesById = new Map(existing.stages.map((s) => [s.id, s]));
                    for (const [id, incoming] of stageMap) {
                        const prev = stagesById.get(id);
                        stagesById.set(id, {
                            id,
                            label: prev?.label ?? id,
                            state: prev?.state ?? ('active' as const),
                            processed: incoming.processed ?? prev?.processed,
                            total: incoming.total ?? prev?.total,
                            currentItem: incoming.currentItem ?? prev?.currentItem,
                        });
                    }
                    next.set(runId, {
                        ...existing,
                        stages: Array.from(stagesById.values()),
                    });
                    mutated = true;
                }
                return mutated ? next : current;
            });
            // Progress-only notify: triggers onAnyChange subscribers
            // (taskAggregates, RunCard progress bars) but NOT transition
            // callbacks. State-transition events use notifyTransition().
            notifyChange();
        };
        if (browser && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(fire);
        } else {
            // SSR / test path — defer to a microtask-equivalent.
            setTimeout(fire, 16);
        }
    }

    function bufferProgressEvent(runId: string, stages: unknown[]): void {
        let stageMap = pendingProgress.get(runId);
        if (!stageMap) {
            stageMap = new Map();
            pendingProgress.set(runId, stageMap);
        }
        for (const raw of stages) {
            if (typeof raw !== 'object' || raw === null) continue;
            const s = raw as Record<string, unknown>;
            const id = typeof s.id === 'string' ? s.id : null;
            if (!id) continue;
            const prev = stageMap.get(id);
            stageMap.set(id, {
                id,
                processed: typeof s.processed === 'number' ? s.processed : prev?.processed,
                total: typeof s.total === 'number' ? s.total : prev?.total,
                currentItem: typeof s.currentItem === 'string' ? s.currentItem : prev?.currentItem,
            });
        }
        scheduleProgressFlush();
    }

    function applyCloudEvent(raw: unknown): void {
        const envelope = CloudEventSchema.safeParse(raw);
        if (!envelope.success) return;

        const ev = envelope.data;

        // Progress events carry only { runId, stages: [{id, processed, total, currentItem}] }
        // — they're not full Run objects. Buffer into pendingProgress
        // and let the rAF flush merge them into runsStore in one pass.
        if (ev.type === 'org.lumastra.task.run.progress') {
            const data = ev.data as { runId?: unknown; stages?: unknown };
            if (typeof data?.runId !== 'string' || !Array.isArray(data.stages)) return;
            bufferProgressEvent(data.runId, data.stages as unknown[]);
            return;
        }

        // `meta` autonomous-action events (leader change, recovery-reclaim,
        // transition-conflict, etc.) carry no Run object — surface them onto the
        // ticker ring and stop. Previously these never reached the bus at all
        // (no run-shaped data → dropped); the Slice-4 ticker is their first
        // consumer (slice-4 spec §6.1).
        if (ev.type.startsWith('org.lumastra.task.meta.')) {
            const subtype = ev.type.slice('org.lumastra.task.meta.'.length);
            const data =
                ev.data && typeof ev.data === 'object' ? (ev.data as Record<string, unknown>) : {};
            const instanceId =
                typeof data.instanceId === 'string'
                    ? data.instanceId
                    : typeof data.holderInstanceId === 'string'
                      ? data.holderInstanceId
                      : undefined;
            pushBusEvent({
                seq: _eventSeq++,
                ts: Date.now(),
                kind: 'meta',
                severity: severityForMetaType(subtype),
                summary: subtype.replace(/-/g, ' '),
                taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
                runId: typeof data.runId === 'string' ? data.runId : undefined,
                instanceId,
                metaType: subtype,
            });
            return;
        }

        const run = extractRun(ev.data);
        if (!run) return;

        runsStore.update((current) => {
            const next = new Map(current);
            const existing = next.get(run.id);
            // A terminal frame wins unconditionally: it is the authoritative
            // final state, and timestamp comparison can never justify keeping
            // an in-flight snapshot over it.
            if (!existing || isTerminal(run) || runTimestamp(run) >= runTimestamp(existing)) {
                next.set(run.id, mergeRunUpdate(existing, run));
            }
            return next;
        });
        // State transitions notify BOTH transition + any-change callbacks.
        // Without this distinction, a continuously-progressing run would
        // keep the page's scheduleRefresh debounce permanently hot and the
        // lane catalog would never refresh from the server.
        notifyTransition();

        // Project terminal failure / completion onto the ticker ring. Only
        // failures and completions feed the error/action ticker; pending/active/
        // cancelling transitions are run movement, shown by the class groups.
        if (run.state === 'failed') {
            pushBusEvent({
                seq: _eventSeq++,
                ts: Date.now(),
                kind: 'run.failed',
                severity: severityForErrorKind(run.error?.kind),
                summary: run.error?.message
                    ? `${run.label}: ${run.error.message}`
                    : `${run.label} failed`,
                taskId: run.taskId,
                runId: run.id,
                instanceId: run.ownerInstanceId,
            });
        } else if (run.state === 'completed') {
            pushBusEvent({
                seq: _eventSeq++,
                ts: Date.now(),
                kind: 'run.completed',
                severity: 'info',
                summary: `${run.label} completed`,
                taskId: run.taskId,
                runId: run.id,
                instanceId: run.ownerInstanceId,
            });
        }
    }

    function scheduleReconnect(): void {
        reconnectAttempts++;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.warn(
                '[RunSSEBus] Max reconnect attempts reached — call manualRetry() to resume',
            );
            // Surface exhaustion so the page can show a persistent stale banner
            // + Reconnect button instead of sitting silently disconnected
            // (audit: reconnect exhaustion was invisible).
            _reconnectExhausted = true;
            connectedStore.set(false);
            return;
        }
        const delay = reconnectDelay(reconnectAttempts);
        reconnectTimer = setTimeout(() => {
            if (!manuallyDisconnected) openConnection();
        }, delay);
    }

    function manualRetry(): void {
        reconnectAttempts = 0;
        manuallyDisconnected = false;
        _reconnectExhausted = false;
        openConnection();
    }

    async function seedActiveRuns(): Promise<void> {
        // Valkey pubsub doesn't replay history before subscribe. Without a
        // one-shot GET on connect, quiet runs (mid-execution, only heartbeats)
        // never appear in the bus until they next change state — so panels
        // bound to activeRuns render 'No active runs' for active systems.
        try {
            const res = await fetch('/api/runs?state=pending,active,cancelling&limit=200', {
                credentials: 'same-origin',
            });
            if (!res.ok) return;
            const body = (await res.json()) as { items?: unknown[] };
            if (!Array.isArray(body.items)) return;
            runsStore.update((current) => {
                const next = new Map(current);
                for (const raw of body.items ?? []) {
                    const parsed = RunSchema.safeParse(raw);
                    if (!parsed.success) continue;
                    const run = parsed.data;
                    const existing = next.get(run.id);
                    if (!existing || runTimestamp(run) >= runTimestamp(existing)) {
                        next.set(run.id, run);
                    }
                }
                return next;
            });
            notifyChange();
        } catch {
            // Best-effort — SSE will fill the gap once events flow.
        }
    }

    // ── Polling fallback ──────────────────────────────────────────────────────
    // Active only while the SSE stream is down. Re-uses seedActiveRuns() (a plain
    // admin-cookie fetch to /api/runs) on an interval so panels bound to
    // activeRuns keep refreshing even when EventSource can't authenticate. Idle
    // (no timer) whenever SSE is connected — zero overhead on the happy path.
    let fallbackPollTimer: ReturnType<typeof setInterval> | null = null;

    function startFallbackPolling(): void {
        if (!browser) return;
        if (fallbackPollTimer) return;
        // Immediate refresh so the UI doesn't wait a full interval after SSE drops.
        void seedActiveRuns();
        fallbackPollTimer = setInterval(() => {
            if (manuallyDisconnected) {
                stopFallbackPolling();
                return;
            }
            void seedActiveRuns();
        }, FALLBACK_POLL_INTERVAL_MS);
    }

    function stopFallbackPolling(): void {
        if (fallbackPollTimer) {
            clearInterval(fallbackPollTimer);
            fallbackPollTimer = null;
        }
    }

    // Reference counter — connection stays open while at least one consumer holds it.
    let _refCount = 0;

    function openConnection(): void {
        if (!browser) return;

        manuallyDisconnected = false;

        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        // Seed the in-memory map from the REST surface so panels bound to
        // activeRuns show real state before any SSE event arrives.
        void seedActiveRuns();

        const url = lastEventId !== '0' ? `${SSE_URL}?since=${lastEventId}` : SSE_URL;
        eventSource = new EventSource(url);

        eventSource.onmessage = (event: MessageEvent<string>) => {
            // Firefox can deliver lastEventId='' on the first message; only
            // adopt non-empty ids so the next reconnect's ?since= cursor
            // doesn't regress to 0 and replay the whole stream.
            if (event.lastEventId && event.lastEventId !== '0') {
                lastEventId = event.lastEventId;
            }
            const data = parseJsonSafe(event.data);
            applyCloudEvent(data);
        };

        for (const eventType of [
            'org.lumastra.task.run.started',
            'org.lumastra.task.run.completed',
            'org.lumastra.task.run.failed',
            'org.lumastra.task.run.cancelled',
            'org.lumastra.task.run.cancelling',
            'org.lumastra.task.run.progress',
            'org.lumastra.task.run.stage.completed',
            'org.lumastra.task.cost.threshold.exceeded',
            // `meta` autonomous-action subtypes arrive with the CloudEvent type
            // as the SSE `event:` name (see runs/stream `_metaCloudEventType`).
            // The bus's default `onmessage` only fires for unnamed events, so
            // without these explicit listeners meta events never reach the bus.
            // The ticker (Slice 4) is their first consumer.
            'org.lumastra.task.meta.leader-elected',
            'org.lumastra.task.meta.leader-reacquired',
            'org.lumastra.task.meta.subscription-lost',
            'org.lumastra.task.meta.transition-conflict',
            'org.lumastra.task.meta.node-registered',
            'org.lumastra.task.meta.scheduler-tick',
            'org.lumastra.task.meta.recovery-reclaimed',
            'org.lumastra.task.meta.pipeline-when-skip',
            'org.lumastra.task.meta.unknown',
        ] as const) {
            eventSource.addEventListener(eventType, (event: MessageEvent<string>) => {
                // Firefox can deliver lastEventId='' on the first message; only
                // adopt non-empty ids so the next reconnect's ?since= cursor
                // doesn't regress to 0 and replay the whole stream.
                if (event.lastEventId && event.lastEventId !== '0') {
                    lastEventId = event.lastEventId;
                }
                const data = parseJsonSafe(event.data);
                applyCloudEvent(data);
            });
        }

        eventSource.onopen = () => {
            reconnectAttempts = 0;
            _reconnectExhausted = false;
            // SSE is healthy again — tear down the polling fallback (if any).
            stopFallbackPolling();
            connectedStore.set(true);
        };

        eventSource.onerror = () => {
            connectedStore.set(false);
            if (manuallyDisconnected) return;
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
            // DEGRADE: the stream is down (network blip OR a 401 because the
            // proxy bypasses Authentik for /api/v1 and EventSource can't send a
            // Bearer). Start polling the REST surface so the admin pages keep
            // refreshing while we retry. Polling is idempotent (guards its own
            // timer) and stops on the next successful onopen. This must NOT
            // hard-error the admin Tasks/System pages — it never throws.
            startFallbackPolling();
            // Internal reconnect: call openConnection() directly so refcount
            // is NOT incremented (the same logical consumers are still holding
            // their references).
            scheduleReconnect();
        };
    }

    function closeConnection(): void {
        if (manuallyDisconnected) return;
        manuallyDisconnected = true;

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        // Tear down the polling fallback when the last consumer leaves so a
        // backgrounded page doesn't keep hitting /api/runs forever.
        stopFallbackPolling();

        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        connectedStore.set(false);
        runsStore.set(new Map());
        reconnectAttempts = 0;
    }

    // ── Public refcounting wrappers ───────────────────────────────────────────
    // open on first consumer (0→1), close only when the last leaves (→0).

    function connect(): void {
        if (!browser) return;
        _refCount += 1;
        if (_refCount === 1) openConnection();
    }

    function disconnect(): void {
        if (_refCount === 0) return;
        _refCount -= 1;
        if (_refCount === 0) closeConnection();
    }

    function onAnyChange(callback: () => void): () => void {
        changeCallbacks.add(callback);
        return () => {
            changeCallbacks.delete(callback);
        };
    }

    function onTransitionChange(callback: () => void): () => void {
        transitionCallbacks.add(callback);
        return () => {
            transitionCallbacks.delete(callback);
        };
    }

    function onEvent(callback: (event: BusEvent) => void): () => void {
        eventCallbacks.add(callback);
        return () => {
            eventCallbacks.delete(callback);
        };
    }

    function upsertRun(run: Run): void {
        runsStore.update((current) => {
            const next = new Map(current);
            const existing = next.get(run.id);
            // Never let a fetch-sourced snapshot overwrite a terminal state we
            // already observed — an in-flight list request that resolves after
            // a completion event would otherwise strand the run as active.
            if (existing && isTerminal(existing) && !isTerminal(run)) return current;
            if (!existing || isTerminal(run) || runTimestamp(run) >= runTimestamp(existing)) {
                next.set(run.id, mergeRunUpdate(existing, run));
            }
            return next;
        });
        // Optimistic upsert from an admin action is conceptually a transition
        // (it represents a new or moved run), so notify both subscriber sets.
        notifyTransition();
    }

    return {
        connect,
        disconnect,
        manualRetry,
        get connected() {
            return _connected;
        },
        get runs() {
            return _runs;
        },
        get activeRuns() {
            return _activeRuns;
        },
        get recentEvents() {
            return _recentEvents;
        },
        get reconnectExhausted() {
            return _reconnectExhausted;
        },
        onAnyChange,
        onTransitionChange,
        onEvent,
        upsertRun,
    };
}

export const runSSEBus: RunSSEBus = createRunSSEBus();
