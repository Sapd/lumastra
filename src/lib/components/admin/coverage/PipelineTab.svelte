<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import { browser } from '$app/environment';
    import { startVisibleRefresh } from '../media/visible-refresh.js';
    import PipelineProgressStrip from './PipelineProgressStrip.svelte';
    import PipelineTimeline from './PipelineTimeline.svelte';
    import ItemEventHistory from './ItemEventHistory.svelte';
    import {
        PipelineTimelineResponseSchema,
        type PipelineTimelineResponse,
        type TimelineStage,
    } from '$lib/schemas/pipeline-timeline.schema.js';
    import type { StageStateRow } from '$lib/types/pipeline.js';
    import { apiGet } from '$lib/api/client.js';
    import { apiUrl } from '$lib/shared/api-urls.js';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';

    interface Props {
        mediaItemId: string;
        /**
         * Show raw stage/task ids alongside the friendly step names (admin IA
         * redesign, spec §3.3: "raw ids only in dev mode"). Threaded down from
         * `$page.data.devToolsEnabled` by the media detail page.
         */
        devMode?: boolean;
        section?: 'processing' | 'history';
    }

    const { mediaItemId, devMode = false, section = 'processing' }: Props = $props();

    let timeline = $state<PipelineTimelineResponse | null>(null);
    let loading = $state(true);
    let error = $state<string | null>(null);

    // The progress strip consumes the legacy StageStateRow[] shape; project the
    // timeline stages onto the few fields it reads so we keep one data source.
    const progressRows = $derived<StageStateRow[]>(
        (timeline?.stages ?? []).map((s: TimelineStage) => ({
            media_item_id: mediaItemId,
            stage_id: s.stageId,
            processing_version: s.processingVersion,
            status: s.status,
            attempt: s.attempt,
            last_run_id: s.run?.runId ?? null,
            last_error: s.lastError,
            skipped_reason: s.skippedReason,
            started_at: s.startedAt ? new Date(s.startedAt) : null,
            completed_at: s.completedAt ? new Date(s.completedAt) : null,
            next_eligible_at: s.nextEligibleAt ? new Date(s.nextEligibleAt) : null,
            updated_at: new Date(s.updatedAt),
        })),
    );

    /**
     * The header counts are the SAME five buckets the rows use
     * (`TimelineStage.operatorState`), not the raw status tally. The old line
     * counted `in_progress` and `obsolete` as separate columns while silently
     * folding an admin-paused step in with ordinary waiting — so the summary and
     * the rows below it could disagree about what "waiting" meant.
     */
    const stateCounts = $derived.by(() => {
        const counts = { done: 0, failed: 0, waiting: 0, skipped: 0, off: 0 };
        for (const stage of timeline?.stages ?? []) counts[stage.operatorState] += 1;
        return counts;
    });

    /**
     * Optimistic operator-state for an SSE status flip, so a row that just
     * completed stops rendering as "waiting" before the reconciling fetch lands.
     *
     * Deliberately COARSER than the server's `stageOperatorState`: the diagnosis
     * it needs is server-only, so this cannot see `off` or a predicate-blocked
     * skip. That is why the patch is followed by a debounced full reload — this
     * is a stop-gap for one frame, never the source of truth.
     */
    function optimisticOperatorState(
        status: TimelineStage['status'],
    ): TimelineStage['operatorState'] {
        if (status === 'completed') return 'done';
        if (status === 'failed_transient' || status === 'failed_permanent') return 'failed';
        if (status === 'skipped_permanent' || status === 'obsolete') return 'skipped';
        return 'waiting';
    }

    let loadToken = 0;

    async function load(): Promise<void> {
        const token = ++loadToken;
        const subjectId = mediaItemId;
        const {
            data: body,
            error: fetchError,
            status,
        } = await apiGet(
            `/api/admin/media/${subjectId}/pipeline/timeline`,
            PipelineTimelineResponseSchema,
        );
        if (token !== loadToken || subjectId !== mediaItemId) return; // a newer load superseded this one
        if (fetchError || !body) {
            error = status ? `HTTP ${status}` : (fetchError ?? 'Failed to load');
        } else {
            timeline = body;
            // The template checks `error` first: left set, one transient
            // failure hid every later successful load.
            error = null;
        }
        loading = false;
    }

    $effect(() => {
        const subjectId = mediaItemId;
        void subjectId;
        let cancelled = false;
        let es: EventSource | null = null;
        let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

        /**
         * Coalesce a burst of stage-status events into ONE authoritative fetch.
         * A single item can flip several stages within a second or two; the
         * in-place patch keeps the UI live, this restores the fields only the
         * server can compute (diagnosis, off, position, blast radius).
         */
        function scheduleReconcile(): void {
            if (reconcileTimer) clearTimeout(reconcileTimer);
            reconcileTimer = setTimeout(() => {
                reconcileTimer = null;
                if (!cancelled) void load();
            }, 1_500);
        }

        // A new item must not show the previous item's stages while it loads:
        // the timeline's retry/give-up buttons would post A's stage ids to B.
        timeline = null;
        error = null;
        loading = true;
        untrack(() => void load());
        const stopRefresh = browser ? startVisibleRefresh(load) : () => {};

        // Preserve the existing SSE live-update wiring: patch per-stage status
        // in place on `update`, re-fetch the full timeline on `seed`/`delete`.
        if (browser) es = new EventSource(apiUrl('internal', '/admin/ingest/stream'));
        es?.addEventListener('stage-state-changed', (ev) => {
            if (cancelled) return;
            let data: {
                mediaItemId: string;
                stageId: string;
                newStatus: string;
                processingVersion: number;
                kind: string;
            };
            try {
                data = JSON.parse((ev as MessageEvent).data) as typeof data;
            } catch {
                return;
            }
            if (data.mediaItemId !== mediaItemId) return;
            // The stream carries no input identity, so analyzer evidence must be
            // reconciled before a terminal status can describe this source.
            if (data.stageId.startsWith('lumastra-intro-analyzer:') && data.kind !== 'delete') {
                scheduleReconcile();
                return;
            }

            if (data.kind === 'delete') {
                // Drop a pending or in-flight reload: it would clear this banner.
                if (reconcileTimer) clearTimeout(reconcileTimer);
                reconcileTimer = null;
                loadToken++;
                timeline = null;
                error = 'This item was dismissed or deleted. Reload to refresh.';
                return;
            }

            const current = timeline;
            if (!current) {
                // Nothing to patch (the first load failed): a seed still
                // means there is a timeline worth fetching.
                if (data.kind === 'seed') void load();
                return;
            }
            const idx = current.stages.findIndex((s) => s.stageId === data.stageId);
            if (idx >= 0) {
                const nextStatus = data.newStatus as TimelineStage['status'];
                const nextStages = [...current.stages];
                nextStages[idx] = {
                    ...nextStages[idx],
                    status: nextStatus,
                    processingVersion: data.processingVersion,
                    operatorState: optimisticOperatorState(nextStatus),
                    // The queue position and blast radius were computed for the
                    // OLD status; carrying them onto a row that just changed
                    // state would show a stale "812 items ahead" on a finished
                    // step. Drop them and let the reload re-derive.
                    queueWait: undefined,
                    blastRadius: undefined,
                };
                timeline = { ...current, stages: nextStages };
                scheduleReconcile();
            } else if (data.kind === 'seed') {
                void load();
            }
        });

        es?.addEventListener('open', () => {
            if (!cancelled) void load();
        });

        return () => {
            cancelled = true;
            loadToken++;
            stopRefresh();
            if (reconcileTimer) clearTimeout(reconcileTimer);
            es?.close();
        };
    });
</script>

{#if loading}
    <div class="p-4 text-zinc-500">Loading pipeline timeline…</div>
{:else if error && !timeline}
    <div class="p-4 text-red-600">Error: {error}</div>
{:else if timeline}
    {#if error}<p class="p-4 text-amber-300">{m.media_source_stale()}</p>{/if}
    <section class="space-y-4 p-4">
        {#if section === 'processing'}
            <header class="flex flex-wrap items-center gap-3">
                <PipelineProgressStrip rows={progressRows} {devMode} />
                <span class="text-sm text-zinc-600 dark:text-zinc-400">
                    {m.admin_pipeline_summary_state_done({ count: stateCounts.done })} ·
                    {m.admin_pipeline_summary_state_failed({ count: stateCounts.failed })} ·
                    {m.admin_pipeline_summary_state_waiting({ count: stateCounts.waiting })} ·
                    {m.admin_pipeline_summary_state_skipped({
                        count: stateCounts.skipped,
                    })}{#if stateCounts.off > 0}
                        · <span class="text-amber-400"
                            >{m.admin_pipeline_summary_state_off({ count: stateCounts.off })}</span
                        >{/if}
                </span>
            </header>

            <PipelineTimeline
                {mediaItemId}
                stages={timeline.stages.filter(
                    (stage) =>
                        stage.operatorState === 'failed' || stage.operatorState === 'waiting',
                )}
                onremediated={load}
                {devMode} />
            <details class="rounded-lg border border-surface-700 p-3">
                <summary class="cursor-pointer text-sm text-surface-300"
                    >{m.media_redesign_success_steps()}</summary>
                <PipelineTimeline
                    {mediaItemId}
                    stages={timeline.stages.filter(
                        (stage) =>
                            stage.operatorState !== 'failed' && stage.operatorState !== 'waiting',
                    )}
                    onremediated={load}
                    {devMode} />
            </details>
        {:else}
            <ItemEventHistory events={timeline.events} />
        {/if}

        <!--
          The bridge to /admin/fix, placed where someone is already stuck.

          An operator who opened this tab has a specific item and a suspicion.
          If the pipeline reads clean, the next questions are about VISIBILITY
          or PLAYBACK — different subsystems, different pages, and previously no
          route between them: the explainers all take a media UUID, which is
          sitting right here and was being copied by hand into another tab.

          Deliberately at the BOTTOM. These are the "the obvious thing didn't
          explain it" links, and putting them above the timeline would offer an
          exit before the page has answered anything.
        -->
        <section class="space-y-1 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <h3 class="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {m.admin_pipeline_related_heading()}
            </h3>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">
                {m.admin_pipeline_related_intro()}
            </p>
            <div class="flex flex-wrap gap-x-4 gap-y-1 pt-0.5 text-xs">
                <a
                    href={`${resolve('/admin/fix/user-cannot-see')}?mediaId=${encodeURIComponent(mediaItemId)}`}
                    class="text-primary-500 hover:text-primary-400 dark:text-primary-300">
                    {m.admin_pipeline_related_visibility()}
                </a>
                <a
                    href={`${resolve('/admin/fix/why-transcode')}?mediaId=${encodeURIComponent(mediaItemId)}`}
                    class="text-primary-500 hover:text-primary-400 dark:text-primary-300">
                    {m.admin_pipeline_related_transcode()}
                </a>
                <a
                    href={resolve('/admin/fix/where-is-it')}
                    class="text-primary-500 hover:text-primary-400 dark:text-primary-300">
                    {m.admin_pipeline_related_trace()}
                </a>
            </div>
        </section>
    </section>
{/if}
