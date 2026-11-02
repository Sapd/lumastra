<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin IA redesign, spec §3.3/§6: the run DetailPanel, rebuilt onto the
  shared `DetailPanel` shell with the spec's fixed Summary / Steps / Log tab
  set. Public props stay exactly `{ runId, onclose }` — this component is
  mounted from several places app-wide (Task Detail's Runs tab via the
  `runDetailPanel` store, System Health, Library, the Runs page itself), all
  of which only ever open it as an overlay, so `mode` stays hardcoded to
  `'panel'` (the plan's explicit call: "a full page for a single run is not
  needed").
-->
<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { z } from 'zod';
    import { Icon, ClipboardDocument } from 'svelte-hero-icons';
    import { apiGet, apiPost } from '$lib/api/client.js';
    import { RunSchema, type Run } from '$lib/schemas/run.schema.js';
    import { CancelResponseSchema } from '$lib/schemas/run.schema.js';
    import { RunDiagnosticsSchema, type RunDiagnostics } from '$lib/schemas/run.schema.js';
    import { formatTaskRunReport } from '$lib/shared/task-run-report.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { formatCount } from '$lib/utils/admin/formatters.js';
    import { runItemsProcessed } from './run-items-processed.js';
    import { mergeActiveStageProgress } from './run-live-progress.js';
    import AriaProgressBar from '$lib/components/ui/AriaProgressBar.svelte';
    import DetailPanel from '$lib/components/admin/detail/DetailPanel.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import RunLogStream from './RunLogStream.svelte';
    import ActionModal from '$lib/components/admin/ActionModal.svelte';
    import { RUN_STATE_BADGE } from '$lib/components/admin/tasks/run-state-badges.js';
    import TaskStatusBadge from '$lib/components/admin/tasks/TaskStatusBadge.svelte';
    import type { BadgeProps } from '$lib/components/admin/tasks/badge-types.js';
    import { taskStatusLabel } from '$lib/utils/operator-labels.js';
    // The run sidebar names the task but never said what it DOES. The curated
    // descriptions already existed for the task catalog; this was a wiring gap.
    import { taskDescription } from '$lib/utils/admin/task-descriptions.js';
    import * as m from '$lib/paraglide/messages.js';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import { resumeLabel, serverLabel, stopReasonLabel, triggerLabel } from './run-labels.js';
    import {
        FileHealthRecheckRequestSchema,
        FileHealthRecheckResultSchema,
    } from '$lib/schemas/file-health-recheck.js';
    import { fileHealthRecheckMessage } from '$lib/utils/file-health-issue.js';

    type TabId = 'summary' | 'steps' | 'log';

    interface Props {
        runId: string;
        onclose: () => void;
    }

    let { runId, onclose }: Props = $props();

    let run = $state<Run | null>(null);
    // Admin-only companion payload: the unredacted error (with stack) plus the
    // server-side path-redaction roots. `GET /runs/{id}` deliberately strips
    // `error.stack` because its `runs:read` scope is granted to every logged-in
    // user; the stack lives behind `auth: {kind:'admin'}` on
    // `GET /runs/{id}/diagnostics`. A non-admin viewer simply gets null here and
    // sees the panel exactly as before.
    let diagnostics = $state<RunDiagnostics | null>(null);
    let loading = $state(true);
    let loadError = $state<ClassifiedError | null>(null);
    let activeTab = $state<TabId>('summary');
    let cancelling = $state(false);
    // Pending Stop / Force-stop confirmation. Stopping a run is destructive (it
    // can kill a legitimate long-running scan mid-flight), so both buttons open
    // an ActionModal instead of firing on the raw click. The target runId is
    // captured at open time so a later deep-link switch to a different run
    // can't redirect a confirmed cancel onto the wrong run.
    let pendingCancel = $state<{ runId: string; hard: boolean } | null>(null);
    let fetchToken = 0;
    let terminalResultAttempts = 0;
    let terminalResultTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalResultLoadError = $state(false);
    let terminalProbeRestHydratedRunId: string | undefined;
    // Separate from `fetchToken`: the 5s run poll bumps that one, and a
    // diagnostics fetch still in flight when a poll tick lands must not be
    // discarded as stale (it would never be retried and the stack would
    // silently never appear).
    let diagnosticsToken = 0;
    let unsubSSE: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let destroyed = false;
    let consecutiveSameHeartbeat = 0;
    // 18 polls × 5 s = 90 s: three missed ~30 s heartbeats.
    const ORPHAN_POLLS = 18;
    let lastHeartbeatSeen: string | undefined = undefined;

    /**
     * Steps is offered only when there are steps to show — or could be, while
     * the run is live. A finished run of a task that never reports steps got a
     * tab whose whole content was "This run has no steps".
     */
    let tabs = $derived.by(() => {
        const live =
            run?.state === 'active' || run?.state === 'pending' || run?.state === 'cancelling';
        const withSteps = !run || live || run.stages.length > 0;
        return [
            { id: 'summary', label: m.admin_run_tab_summary() },
            ...(withSteps ? [{ id: 'steps', label: m.admin_run_tab_steps() }] : []),
            { id: 'log', label: m.admin_run_tab_log() },
        ];
    });

    /** Raw task id and other internals under the title: Developer mode only. */
    let devMode = $derived($page.data?.devToolsEnabled === true);

    let outcome = $derived(run ? stopReasonLabel(run.result, run.countSummary) : null);
    const SelectedRecheckEnvelopeSchema = z.object({ recheck: FileHealthRecheckResultSchema });
    function needsSelectedProbeResult(r: Run | null): boolean {
        if (!r || r.state !== 'completed' || r.taskId !== 'media-probe' || r.error) return false;
        return FileHealthRecheckRequestSchema.safeParse(r.input).success;
    }
    function shouldHydrateTerminalProbe(r: Run | null): boolean {
        if (!r || r.state !== 'completed' || r.taskId !== 'media-probe' || r.error) return false;
        if (r.result != null) return false;
        // A redacted cached SSE run has no input. Hydrate once from REST, then
        // only keep retrying if that authoritative input identifies a selected
        // file whose result is still missing.
        return (
            (r.input == null && terminalProbeRestHydratedRunId !== r.id) ||
            needsSelectedProbeResult(r)
        );
    }
    let selectedRecheck = $derived.by(() => {
        if (!run || run.taskId !== 'media-probe' || run.state !== 'completed' || run.error) {
            return null;
        }
        const input = FileHealthRecheckRequestSchema.safeParse(run.input);
        const envelope = SelectedRecheckEnvelopeSchema.safeParse(run.result);
        if (!input.success || !envelope.success) return null;
        return envelope.data.recheck.fileId === input.data.fileId ? envelope.data.recheck : null;
    });

    function formatWhen(iso: string | undefined): string {
        if (!iso) return '—';
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
    }

    // Terminal states are absorbing: once a run reaches one, no in-flight
    // earlier SSE event should be allowed to revert it.
    const TERMINAL_STATES: ReadonlySet<Run['state']> = new Set([
        'completed',
        'failed',
        'cancelled',
    ]);

    function runTimestampMs(r: Run): number {
        // heartbeatAt advances every ~30s for active runs (newest signal).
        // completedAt is set exactly once at terminal transition.
        // startedAt is the floor (always present, never changes).
        const ts = r.heartbeatAt ?? r.completedAt ?? r.startedAt;
        if (!ts) return 0;
        const ms = Date.parse(ts);
        return Number.isFinite(ms) ? ms : 0;
    }

    /**
     * A progress event deliberately does not advance `heartbeatAt`: a busy
     * worker can publish many item counts between heartbeats. Keep that
     * high-watermark data when a newer REST snapshot (or an older SSE run
     * envelope) arrives, otherwise the progress strip flickers away between
     * the two transports.
     */
    /**
     * Merge an incoming Run snapshot (from REST or SSE) into local state,
     * keeping whichever side carries the newer timestamp. Terminal states
     * are absorbing — never let a stale non-terminal update overwrite a
     * terminal one we already have. This is the shell's SSE-patch-in-place
     * contract in practice: the `run` object mutates, `DetailPanel`'s
     * children snippet never remounts (spec §6).
     */
    function applyRunUpdate(incoming: Run, scheduleTerminalHydration = true): void {
        if (!run) {
            run = incoming;
            if (scheduleTerminalHydration && shouldHydrateTerminalProbe(incoming)) {
                scheduleTerminalResultFetch(incoming.id);
            }
            return;
        }
        if (run.id !== incoming.id) {
            // Defensive: SSE callbacks can fire with a stale runId binding
            // if the user opens panels in rapid succession.
            return;
        }
        if (TERMINAL_STATES.has(run.state) && !TERMINAL_STATES.has(incoming.state)) {
            // Already terminal locally; ignore any earlier-state snapshot.
            return;
        }
        if (runTimestampMs(incoming) >= runTimestampMs(run)) {
            // SSE lifecycle frames ship the redacted RunEvent projection, which
            // carries no `input` and no `result`. This panel stops polling once
            // a run is terminal, so replacing wholesale on a terminal frame
            // blanks the Input/Result sections permanently with no path back.
            const preserved = {
                ...incoming,
                input: incoming.input ?? run.input,
                result: incoming.result ?? run.result,
                countSummary: incoming.countSummary ?? run.countSummary,
            };
            run = TERMINAL_STATES.has(incoming.state)
                ? preserved
                : {
                      ...preserved,
                      stages: mergeActiveStageProgress(run.stages, incoming.stages),
                  };
            if (scheduleTerminalHydration && shouldHydrateTerminalProbe(run)) {
                scheduleTerminalResultFetch(incoming.id);
            } else if (run.result != null) {
                terminalResultAttempts = 0;
                terminalResultLoadError = false;
                if (terminalResultTimer) clearTimeout(terminalResultTimer);
                terminalResultTimer = undefined;
            } else if (!shouldHydrateTerminalProbe(run)) {
                terminalResultAttempts = 0;
                terminalResultLoadError = false;
                if (terminalResultTimer) clearTimeout(terminalResultTimer);
                terminalResultTimer = undefined;
            }
        }
    }

    function scheduleTerminalResultFetch(id: string): void {
        if (terminalResultTimer || terminalResultAttempts >= 3 || destroyed) return;
        terminalResultTimer = setTimeout(
            () => {
                terminalResultTimer = undefined;
                void fetchTerminalResult(id);
            },
            terminalResultAttempts === 0 ? 0 : 1_000,
        );
    }

    async function fetchTerminalResult(id: string): Promise<void> {
        if (destroyed || id !== runId || !run || !shouldHydrateTerminalProbe(run)) return;
        terminalResultAttempts++;
        try {
            const { data, error } = await apiGet(`/api/runs/${encodeURIComponent(id)}`, RunSchema);
            if (destroyed || id !== runId || !run || run.id !== id) return;
            if (error || !data || data.id !== id)
                throw new Error(error ?? 'Terminal run is not available yet');
            terminalProbeRestHydratedRunId = id;
            applyRunUpdate(data);
            if (shouldHydrateTerminalProbe(run)) {
                throw new Error('Selected-file result is not available yet');
            }
            terminalResultAttempts = 0;
            terminalResultLoadError = false;
            if (terminalResultTimer) clearTimeout(terminalResultTimer);
            terminalResultTimer = undefined;
        } catch {
            if (destroyed || id !== runId || !run || run.id !== id) return;
            if (terminalResultAttempts < 3) scheduleTerminalResultFetch(id);
            else terminalResultLoadError = true;
        }
    }

    function retryTerminalResult(): void {
        terminalResultAttempts = 0;
        terminalResultLoadError = false;
        scheduleTerminalResultFetch(runId);
    }

    async function loadRun(id: string): Promise<void> {
        // Guard against a missing/placeholder id so we never fetch /api/runs/null.
        if (!id || id === 'null' || id === 'undefined') {
            loading = false;
            if (!run) loadError = classifyError(new Error(m.admin_run_no_run_selected()));
            return;
        }
        const my = ++fetchToken;
        loading = true;
        loadError = null;

        // Prefer SSE-local state (already up-to-date) before fetching, but
        // only as a placeholder — the API response still gets merged via
        // applyRunUpdate so the freshest snapshot wins.
        const cached = runSSEBus.runs.get(id);
        if (cached) {
            applyRunUpdate(cached, false);
            loading = false;
        }

        let response: Awaited<ReturnType<typeof apiGet<typeof RunSchema>>>;
        try {
            response = await apiGet(`/api/runs/${encodeURIComponent(id)}`, RunSchema);
        } catch (error) {
            if (my !== fetchToken || destroyed) return;
            if (run?.id === id && shouldHydrateTerminalProbe(run)) {
                scheduleTerminalResultFetch(id);
            } else if (!run) {
                loadError = classifyError(error);
            }
            loading = false;
            return;
        }
        const { data, error, status } = response;
        if (my !== fetchToken || destroyed) return;

        if (error || !data) {
            if (!run) loadError = classifyError(new Error(error ?? undefined), { status });
            if (run?.id === id && shouldHydrateTerminalProbe(run)) {
                scheduleTerminalResultFetch(id);
            }
        } else {
            if (data.id === id) terminalProbeRestHydratedRunId = id;
            applyRunUpdate(data);
            // The run was still active when the panel opened and has now failed:
            // the error (and its stack) only exists in Postgres from the
            // terminal transition on, so the open-time diagnostics fetch came
            // back empty. Re-fetch once so the stack and the copy report are
            // actually populated for the failure the operator is looking at.
            if (data.error && !diagnostics?.error) void loadDiagnostics(id);
            if (run?.id === id && shouldHydrateTerminalProbe(run)) {
                scheduleTerminalResultFetch(id);
            }
        }
        loading = false;
    }

    /**
     * Fetch the admin-only diagnostics payload. Failure is NOT an error state:
     * a non-admin viewer gets 403 here by design, and the panel keeps working
     * without the stack or the copy affordance. Fetched once per runId (not on
     * every poll tick) — the error is only written at the terminal transition.
     */
    async function loadDiagnostics(id: string): Promise<void> {
        if (!id || id === 'null' || id === 'undefined') return;
        const my = ++diagnosticsToken;
        const { data } = await apiGet(
            `/api/runs/${encodeURIComponent(id)}/diagnostics`,
            RunDiagnosticsSchema,
        );
        if (my !== diagnosticsToken || destroyed) return;
        diagnostics = data ?? null;
    }

    /**
     * Empty `libraryRoots` means `redactPaths` has nothing to match — every
     * library path would ride into a "redacted" GitHub report unredacted. Same
     * fail-loud rule the transcode-failures page applies: disable the github
     * button rather than silently ship an unredacted report under a label that
     * promises redaction.
     */
    let redactionUnavailable = $derived((diagnostics?.redaction.libraryRoots.length ?? 0) === 0);

    async function copyReport(mode: 'github' | 'raw'): Promise<void> {
        if (!run) return;
        const body = formatTaskRunReport(
            {
                runId: run.id,
                taskId: run.taskId,
                label: run.label,
                state: run.state,
                trigger: run.trigger.kind,
                startedAt: run.startedAt,
                completedAt: run.completedAt,
                ownerInstanceId: run.ownerInstanceId,
                scope: run.scope,
                // Prefer the admin diagnostics error (carries the stack); fall
                // back to the stack-less error from the shared run response.
                error: diagnostics?.error ?? run.error ?? null,
                input: run.input,
                roots: diagnostics?.redaction ?? { libraryRoots: [] },
            },
            mode,
        );
        try {
            await navigator.clipboard.writeText(body);
        } catch {
            // Plain-HTTP LAN installs have no clipboard API, and a denied
            // permission rejects: say so instead of a dead button.
            toasts.error(m.admin_transcode_failures_toast_copy_failed());
            return;
        }
        toasts.success(
            mode === 'github' ? m.admin_run_copied_redacted() : m.admin_run_copied_raw(),
        );
    }

    async function cancelRun(targetRunId: string, hard = false): Promise<void> {
        if (cancelling || !run) return;
        // Hard kill only permitted after a soft cancel has transitioned the run to 'cancelling'.
        if (hard && run.state !== 'cancelling') {
            toasts.info(m.admin_run_cancel_state_changed());
            return;
        }
        cancelling = true;
        const { data, error, status } = await apiPost(
            `/api/runs/${encodeURIComponent(targetRunId)}/cancel`,
            CancelResponseSchema,
            { hard },
        );
        cancelling = false;
        // 409 = the run finished between render and confirm — the normal
        // cancel race, not a failure. Refresh so the panel stops offering Stop
        // on a finished run. 404 (unknown run) stays a real error.
        if (status === 409) {
            toasts.info(m.admin_run_cancel_already_finished());
        } else if (error || !data) {
            toasts.error(m.admin_run_cancel_failed({ error: error ?? m.admin_err_server() }));
        } else if (!data.accepted) {
            toasts.info(m.admin_run_cancel_already_finished());
        } else {
            toasts.success(m.admin_run_cancel_stopping());
        }
        // Only reload the run this panel still shows: re-pointing it while the
        // POST was in flight must not let a load of the old run win.
        if (targetRunId === runId) await loadRun(targetRunId);
    }

    function pct(processed: number | undefined, total: number | undefined): number {
        if (!total || total === 0) return 0;
        return Math.min(100, ((processed ?? 0) / total) * 100);
    }

    function formatElapsed(startedAt: string, completedAt?: string): string {
        const start = Date.parse(startedAt);
        if (!Number.isFinite(start)) return '—';
        const end = completedAt ? Date.parse(completedAt) : Date.now();
        const ms = Math.max(0, end - start);
        if (ms < 1000) return `${ms}ms`;
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const mins = Math.floor(s / 60);
        if (mins < 60) return `${mins}m ${s % 60}s`;
        return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    }

    function badgeProps(r: Run): BadgeProps {
        if (r.state === 'pending') {
            if (r.admissionObservation === 'playback-deferred')
                return { color: 'yellow', label: m.admin_run_playback_deferred() };
            if (r.admissionObservation === 'waiting')
                return { color: 'blue', label: m.admin_run_confirmed_waiting() };
            return { color: 'gray', label: m.admin_run_recorded_unconfirmed() };
        }
        if (
            (r.state === 'active' || r.state === 'cancelling') &&
            r.admissionObservation !== 'active'
        )
            return { color: 'gray', label: m.admin_run_recorded_unconfirmed() };
        const state = r.state;
        const key =
            state === 'active'
                ? 'running'
                : state === 'cancelling'
                  ? 'cancelling'
                  : state === 'cancelled'
                    ? 'cancelled'
                    : state === 'completed'
                      ? 'completed'
                      : state === 'failed'
                        ? 'failed'
                        : state === 'pending'
                          ? 'queued'
                          : 'idle';
        return RUN_STATE_BADGE[key] ?? RUN_STATE_BADGE.idle;
    }

    function pollTick(): void {
        if (destroyed || !run) return;
        // Stop polling terminal runs immediately.
        if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled') {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = undefined;
            return;
        }
        // Stop polling an orphaned run: an ACTIVE run whose heartbeat has not
        // moved for ORPHAN_POLLS polls. Heartbeats come every ~30 s and this
        // polls every 5 s, so the old 5-poll limit stopped polling healthy runs
        // between two heartbeats; a queued run has no heartbeat yet at all.
        const currentHeartbeat = run.heartbeatAt;
        if (run.state === 'active' && currentHeartbeat && currentHeartbeat === lastHeartbeatSeen) {
            consecutiveSameHeartbeat++;
            if (consecutiveSameHeartbeat >= ORPHAN_POLLS) {
                if (pollTimer) clearInterval(pollTimer);
                pollTimer = undefined;
                return;
            }
        } else {
            consecutiveSameHeartbeat = 0;
            lastHeartbeatSeen = currentHeartbeat;
        }
        void loadRun(runId);
    }

    function ensurePolling(): void {
        if (pollTimer || destroyed) return;
        pollTimer = setInterval(pollTick, 5_000);
    }

    $effect(() => {
        // Track ONLY runId. Everything below reads+writes `run` (loadRun →
        // applyRunUpdate does `if (!run)` then `run = …`); doing that tracked
        // makes the effect depend on `run` while writing it → a reactive cycle
        // → effect_update_depth_exceeded (fired when clicking a run already in
        // the SSE cache). untrack() isolates the side effects from dependency
        // tracking so the effect re-runs on runId changes only.
        const id = runId;
        untrack(() => {
            // Reset state when the panel is reused for a different runId so the
            // applyRunUpdate id-guard doesn't silently bail with the previous
            // run's snapshot still on screen.
            run = null;
            terminalResultAttempts = 0;
            terminalResultLoadError = false;
            terminalProbeRestHydratedRunId = undefined;
            if (terminalResultTimer) clearTimeout(terminalResultTimer);
            terminalResultTimer = undefined;
            diagnostics = null;
            activeTab = 'summary';
            // Close any pending Stop/Force-stop confirmation captured against
            // the previous run — confirming it now would target a run this
            // panel no longer shows.
            pendingCancel = null;
            consecutiveSameHeartbeat = 0;
            lastHeartbeatSeen = undefined;
            // Restart polling if a previous panel's terminal-state or orphan-
            // detection branch cleared the timer. Without this, switching from a
            // terminal run to an active one leaves the new run un-polled and
            // dependent on SSE alone.
            ensurePolling();
            void loadRun(id);
            void loadDiagnostics(id);
        });
    });

    onMount(() => {
        // pollTimer is started from the first $effect run (which fires on
        // mount alongside onMount). Keep onMount for the SSE subscription
        // which only needs to be wired once per component instance.
        unsubSSE = runSSEBus.onAnyChange(() => {
            const sseRun = runSSEBus.runs.get(runId);
            // Route SSE updates through the same timestamp-aware merger as
            // the REST path. Previously this did `run = sseRun` directly,
            // which could overwrite a just-fetched terminal snapshot with
            // an older 'active' event that arrived after the GET response.
            if (!sseRun) return;

            const latestTimestamp = run ? runTimestampMs(run) : 0;
            applyRunUpdate(sseRun);
            // A run the orphan check gave up on is alive again: resume polling.
            if (!pollTimer && run && !TERMINAL_STATES.has(run.state)) {
                consecutiveSameHeartbeat = 0;
                ensurePolling();
            }

            // Stage progress events inherit the last run heartbeat, so their
            // envelope can be older than a REST poll even while the stage
            // counts are newer. Merge just that live progress back in rather
            // than discarding it under the timestamp guard above.
            if (
                run &&
                !TERMINAL_STATES.has(run.state) &&
                !TERMINAL_STATES.has(sseRun.state) &&
                runTimestampMs(sseRun) < latestTimestamp
            ) {
                run = {
                    ...run,
                    stages: mergeActiveStageProgress(run.stages, sseRun.stages),
                };
            }
        });
    });

    onDestroy(() => {
        destroyed = true;
        if (pollTimer) clearInterval(pollTimer);
        unsubSSE?.();
        if (terminalResultTimer) clearTimeout(terminalResultTimer);
    });

    let canCancel = $derived(
        run !== null &&
            (run.state === 'pending' || run.state === 'active' || run.state === 'cancelling'),
    );

    let costEntries = $derived(run?.costBreakdown ? Object.entries(run.costBreakdown) : []);

    let itemsProcessed = $derived(run ? runItemsProcessed(run) : null);

    // A run can have several pipeline stages, but only one normally reports
    // live work at a time. Surface that active stage above every tab so an
    // operator does not have to leave the log to answer "how far along is it?".
    let overallProgressStage = $derived.by(() => {
        const stagesWithTotals =
            run?.stages.filter((stage) => stage.total !== undefined && stage.total > 0) ?? [];
        return (
            stagesWithTotals.find((stage) => stage.state === 'active') ??
            stagesWithTotals.find((stage) => stage.state === 'waiting') ??
            stagesWithTotals[0] ??
            null
        );
    });

    // Pretty-printed task_history.input. An empty object is treated as "no
    // input" — the vast majority of scheduled runs carry `{}` and rendering an
    // empty brace pair as if it were data is noise.
    let inputJson = $derived.by((): string | null => {
        const raw = run?.input;
        if (raw === undefined || raw === null) return null;
        if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) {
            return null;
        }
        try {
            return JSON.stringify(raw, null, 2) ?? null;
        } catch {
            return '(input not serializable)';
        }
    });

    // Plain-language label for a stage state. `active` reads "In progress" to
    // match the run badge vocabulary; the rest fall through to the shared helper.
    function stageStateLabel(state: string): string {
        return taskStatusLabel(state === 'active' ? 'running' : state);
    }
</script>

<DetailPanel
    titleText={run?.label ?? runId}
    subtitle={devMode ? run?.taskId : undefined}
    description={run ? taskDescription(run.taskId) : undefined}
    {tabs}
    {activeTab}
    onTabChange={(id) => (activeTab = id as TabId)}
    mode="panel"
    {onclose}>
    {#snippet children(tab)}
        <AsyncSection
            loading={loading && !run}
            error={run ? null : loadError}
            onretry={() => void loadRun(runId)}>
            {#if run}
                <!-- Kept outside the tab branches so state and progress remain
                     visible while watching a long-running log stream. -->
                <section
                    aria-label="Run progress"
                    class="mb-5 rounded border border-surface-700/60 bg-surface-800/35 p-3">
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <TaskStatusBadge {...badgeProps(run)} />
                        <span class="text-surface-400">
                            {#if run.state === 'pending'}
                                {m.admin_run_record_age({ time: formatElapsed(run.startedAt) })}
                            {:else if run.executionStartedAt}
                                {m.admin_run_execution_elapsed({
                                    time: formatElapsed(run.executionStartedAt, run.completedAt),
                                })}
                            {:else}
                                {m.admin_run_execution_unknown()}
                            {/if}
                        </span>
                        <span class="text-surface-500">{triggerLabel(run.trigger)}</span>
                        {#if resumeLabel(run.trigger)}
                            <span class="text-amber-300/90">{resumeLabel(run.trigger)}</span>
                        {/if}
                        {#if itemsProcessed !== null && (itemsProcessed.unit === 'frames' || !overallProgressStage)}
                            <span class="text-surface-300">
                                {formatCount(itemsProcessed.count, itemsProcessed.unit)}
                            </span>
                        {/if}
                        {#if outcome}
                            <span class="text-surface-400">· {outcome}</span>
                        {/if}
                        {#if terminalResultLoadError}
                            <span role="alert" class="text-warning-300">
                                {m.admin_runs_refresh_failed()}
                                <button
                                    type="button"
                                    class="ml-1 underline"
                                    onclick={retryTerminalResult}>
                                    {m.common_retry()}
                                </button>
                            </span>
                        {/if}
                        {#if run.ownerInstanceId}
                            <!-- Was an unlabelled `e0440fdcb81e-201f00`. -->
                            <span class="text-surface-500" title={run.ownerInstanceId}>
                                {m.admin_run_on_server({
                                    server: serverLabel(run.ownerInstanceId),
                                })}
                            </span>
                        {/if}
                    </div>
                    {#if overallProgressStage}
                        <div class="mt-3">
                            <div class="mb-1 flex items-center justify-between gap-3 text-xs">
                                <span class="min-w-0 truncate font-medium text-surface-200">
                                    {overallProgressStage.label}
                                </span>
                                <span class="shrink-0 tabular-nums text-surface-400">
                                    {overallProgressStage.processed ?? 0} / {overallProgressStage.total}
                                    · {Math.round(
                                        pct(
                                            overallProgressStage.processed,
                                            overallProgressStage.total,
                                        ),
                                    )}%
                                </span>
                            </div>
                            <AriaProgressBar
                                label={`${overallProgressStage.label} progress`}
                                value={pct(
                                    overallProgressStage.processed,
                                    overallProgressStage.total,
                                )} />
                            {#if overallProgressStage.currentItem && overallProgressStage.state === 'active'}
                                <p
                                    class="mt-1 truncate text-xs text-surface-500"
                                    title={overallProgressStage.currentItem}>
                                    {overallProgressStage.currentItem}
                                </p>
                            {/if}
                        </div>
                    {/if}
                </section>

                {#if tab === 'summary'}
                    <div class="space-y-6">
                        <!-- Error block -->
                        {#if run.error}
                            <section aria-labelledby="run-detail-error">
                                <h3
                                    id="run-detail-error"
                                    class="mb-2 text-xs font-semibold uppercase tracking-wide text-red-400">
                                    {m.admin_run_error_heading()}
                                </h3>
                                <div
                                    class="rounded border border-red-700/30 bg-red-900/20 p-3 text-sm text-red-300">
                                    <p>{run.error.message}</p>
                                    <!-- The stack comes from the admin-gated
                                         run-diagnostics endpoint.
                                         `run.error.stack` is always absent
                                         here: the shared run-detail def strips
                                         it because its runs:read scope reaches
                                         every logged-in user. -->
                                    {#if diagnostics?.error?.stack}
                                        <details class="mt-2 text-xs text-red-300/70">
                                            <summary class="cursor-pointer"
                                                >{m.admin_error_details_toggle()}</summary>
                                            <p class="mt-1 whitespace-pre-wrap font-mono">
                                                {diagnostics.error.stack}
                                            </p>
                                        </details>
                                    {/if}
                                </div>
                            </section>
                        {/if}

                        <!-- Input — the actual args that produced this run.
                             Task inputs are structural identifiers only
                             (libraryPathId / libraryGroupId / force / limit /
                             seasonId / batchSize …), so nothing is redacted for
                             this admin-only view. The copy-for-GitHub path DOES
                             redact, because a `.passthrough()` input schema
                             cannot rule out a path- or credential-shaped value
                             ending up in a public issue. -->
                        <section aria-labelledby="run-detail-input">
                            <h3
                                id="run-detail-input"
                                class="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
                                {m.admin_run_input_heading()}
                            </h3>
                            {#if inputJson}
                                <pre
                                    class="max-h-64 overflow-auto rounded bg-surface-800/40 p-3 font-mono text-xs text-surface-300 whitespace-pre-wrap">{inputJson}</pre>
                            {:else}
                                <p class="text-xs italic text-surface-500">
                                    {m.admin_run_no_input()}
                                </p>
                            {/if}
                        </section>

                        {#if selectedRecheck}
                            <section aria-labelledby="run-detail-selected-file-result">
                                <h3
                                    id="run-detail-selected-file-result"
                                    class="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
                                    {m.admin_run_selected_file_result()}
                                </h3>
                                <p class="text-sm text-surface-200">
                                    {fileHealthRecheckMessage(selectedRecheck)}
                                </p>
                            </section>
                        {/if}

                        <!-- Report — copy this run as a GitHub-ready Markdown
                             block. All formatting/redaction lives in
                             $lib/shared/task-run-report.ts so the tests execute
                             the same code these buttons do. -->
                        <!-- NOT gated on `diagnostics`: "Copy raw" needs none of
                             it (it falls back to `run.error` and ignores the
                             roots), and a transient failure of the diagnostics
                             fetch must not remove the operator's only copy
                             affordance. The github button gates itself via
                             `redactionUnavailable`, which is already true when
                             `diagnostics` is null. -->
                        <section aria-labelledby="run-detail-report" class="space-y-1">
                            <h3 id="run-detail-report" class="sr-only">
                                {m.admin_run_copy_github()}
                            </h3>
                            <div class="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    class="btn btn-sm variant-soft inline-flex items-center gap-1"
                                    disabled={redactionUnavailable}
                                    title={redactionUnavailable
                                        ? m.admin_run_copy_redaction_unavailable()
                                        : undefined}
                                    onclick={() => void copyReport('github')}>
                                    <Icon src={ClipboardDocument} class="h-4 w-4" />
                                    <span>{m.admin_run_copy_github()}</span>
                                </button>
                                <button
                                    type="button"
                                    class="btn btn-sm variant-soft inline-flex items-center gap-1"
                                    onclick={() => void copyReport('raw')}>
                                    <Icon src={ClipboardDocument} class="h-4 w-4" />
                                    <span>{m.admin_run_copy_raw()}</span>
                                </button>
                            </div>
                            {#if redactionUnavailable}
                                <p class="text-xs text-warning-300">
                                    {m.admin_run_copy_redaction_unavailable_hint()}
                                </p>
                            {/if}
                        </section>

                        <!-- Cost breakdown -->
                        {#if costEntries.length > 0}
                            <section aria-labelledby="run-detail-cost">
                                <h3
                                    id="run-detail-cost"
                                    class="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
                                    {m.admin_run_cost_heading()}
                                </h3>
                                <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                                    {#each costEntries as [kind, units] (kind)}
                                        <dt class="text-surface-500">{kind}</dt>
                                        <dd class="tabular-nums text-surface-200">
                                            {units}
                                        </dd>
                                    {/each}
                                </dl>
                            </section>
                        {/if}

                        <!-- Actions -->
                        {#if canCancel}
                            <section aria-labelledby="run-detail-actions" class="space-y-1">
                                <h3 id="run-detail-actions" class="sr-only">
                                    {m.admin_run_actions_heading()}
                                </h3>
                                <div class="flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        class="btn btn-sm variant-filled-error"
                                        disabled={cancelling}
                                        onclick={() => (pendingCancel = { runId, hard: false })}>
                                        {cancelling ? m.admin_run_stopping() : m.admin_run_stop()}
                                    </button>
                                    <button
                                        type="button"
                                        class="text-xs px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                        disabled={cancelling || run?.state !== 'cancelling'}
                                        title={m.admin_run_force_stop_hint()}
                                        onclick={() => (pendingCancel = { runId, hard: true })}>
                                        {m.admin_run_force_stop()}
                                    </button>
                                </div>
                                <p class="text-xs text-surface-500">
                                    {m.admin_runs_stop_buttons_hint()}
                                </p>
                            </section>
                        {/if}

                        <!-- Metadata -->
                        <section aria-labelledby="run-detail-meta">
                            <h3
                                id="run-detail-meta"
                                class="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
                                {m.admin_run_details_heading()}
                            </h3>
                            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                                <dt class="text-surface-500">{m.admin_run_field_id()}</dt>
                                <dd class="font-mono text-surface-300 break-all">
                                    {run.id}
                                </dd>
                                <dt class="text-surface-500">{m.admin_run_field_task()}</dt>
                                <dd class="text-surface-300">
                                    <a
                                        href={resolve(
                                            `/admin/tasks/${encodeURIComponent(run.taskId)}`,
                                        )}
                                        class="underline underline-offset-2 hover:text-white"
                                        >{run.label}</a>
                                </dd>
                                <dt class="text-surface-500">{m.admin_run_field_enqueued()}</dt>
                                <dd class="text-surface-300">{formatWhen(run.startedAt)}</dd>
                                {#if run.executionStartedAt}
                                    <dt class="text-surface-500">
                                        {m.admin_run_field_execution_started()}
                                    </dt>
                                    <dd class="text-surface-300">
                                        {formatWhen(run.executionStartedAt)}
                                    </dd>
                                {/if}
                                {#if run.completedAt}
                                    <dt class="text-surface-500">
                                        {m.admin_run_field_finished()}
                                    </dt>
                                    <dd class="text-surface-300">
                                        {formatWhen(run.completedAt)}
                                    </dd>
                                {/if}
                                {#if run.ownerInstanceId}
                                    <dt class="text-surface-500">{m.admin_run_field_server()}</dt>
                                    <dd class="font-mono text-surface-300">
                                        {run.ownerInstanceId}
                                    </dd>
                                {/if}
                                {#if run.parentRunId}
                                    <dt class="text-surface-500">{m.admin_run_field_part_of()}</dt>
                                    <dd class="font-mono text-surface-300">
                                        {run.parentRunId}
                                    </dd>
                                {/if}
                                <dt class="text-surface-500">{m.admin_run_field_started_by()}</dt>
                                <dd class="text-surface-300">{triggerLabel(run.trigger)}</dd>
                                {#if run.trigger.resume}
                                    <dt class="text-surface-500">
                                        {m.admin_run_field_resumed_from()}
                                    </dt>
                                    <dd class="font-mono text-surface-300">
                                        {run.trigger.resume.previousRunId}
                                        <span class="font-sans text-surface-500">
                                            · {resumeLabel(run.trigger)}
                                        </span>
                                    </dd>
                                {/if}
                                {#if run.scope?.libraryGroupId}
                                    <dt class="text-surface-500">
                                        {m.admin_run_field_library_group()}
                                    </dt>
                                    <dd class="text-surface-300">
                                        {run.scope.libraryGroupId}
                                    </dd>
                                {/if}
                                {#if run.scope?.userId}
                                    <dt class="text-surface-500">{m.admin_run_field_user()}</dt>
                                    <dd class="text-surface-300">{run.scope.userId}</dd>
                                {/if}
                            </dl>
                        </section>
                    </div>
                {:else if tab === 'steps'}
                    {#if run.stages.length > 0}
                        <div class="space-y-2">
                            {#each run.stages as stage (stage.id)}
                                <div
                                    class="rounded bg-surface-800/40 px-3 py-2"
                                    class:opacity-55={stage.state === 'completed'}
                                    class:opacity-40={stage.state === 'waiting' ||
                                        stage.state === 'skipped'}>
                                    <div class="flex items-center justify-between text-xs">
                                        <span
                                            class="font-medium"
                                            class:text-red-300={stage.state === 'failed'}
                                            class:text-surface-300={stage.state !== 'failed'}>
                                            {stage.label}
                                        </span>
                                        <span class="text-surface-500 tabular-nums">
                                            {#if stage.total !== undefined && stage.total > 0}
                                                {stage.processed ?? 0} / {stage.total}
                                            {:else}
                                                {stageStateLabel(stage.state)}
                                            {/if}
                                        </span>
                                    </div>
                                    <div class="mt-1">
                                        <AriaProgressBar
                                            label={stage.label}
                                            value={pct(stage.processed, stage.total)} />
                                    </div>
                                    {#if stage.currentItem && stage.state === 'active'}
                                        <div
                                            class="mt-1 truncate text-xs text-surface-500"
                                            title={stage.currentItem}>
                                            {stage.currentItem}
                                        </div>
                                    {/if}
                                    {#if stage.etaMs !== undefined}
                                        <div class="mt-0.5 text-xs text-surface-500">
                                            {m.admin_run_eta_remaining({
                                                seconds: Math.round(stage.etaMs / 1000),
                                            })}
                                        </div>
                                    {/if}
                                </div>
                            {/each}
                        </div>
                    {:else}
                        <div class="py-6 text-center text-sm text-surface-500">
                            <p class="italic">{m.admin_run_no_steps()}</p>
                            <p class="mt-1 text-xs text-surface-600">
                                {m.admin_runs_no_steps_hint()}
                            </p>
                        </div>
                    {/if}
                {:else if tab === 'log'}
                    <RunLogStream
                        {runId}
                        bodyClass="h-[calc(100dvh-11rem)]"
                        emptyMessage={run.state === 'active' ||
                        run.state === 'pending' ||
                        run.state === 'cancelling'
                            ? m.admin_runs_log_empty_running()
                            : m.admin_runs_log_empty_finished()} />
                {/if}
            {/if}
        </AsyncSection>
    {/snippet}
</DetailPanel>

{#if pendingCancel}
    <ActionModal
        title={pendingCancel.hard
            ? m.admin_run_force_stop_confirm_title()
            : m.admin_run_stop_confirm_title()}
        confirmText={pendingCancel.hard ? m.admin_run_force_stop() : m.admin_run_stop()}
        confirmColor="red"
        onclose={() => (pendingCancel = null)}
        onconfirm={async () => {
            const target = pendingCancel;
            if (!target) return;
            await cancelRun(target.runId, target.hard);
            pendingCancel = null;
        }}>
        <p class="text-sm text-surface-300">
            {pendingCancel.hard
                ? m.admin_run_force_stop_confirm_body()
                : m.admin_run_stop_confirm_body()}
        </p>
    </ActionModal>
{/if}
