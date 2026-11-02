<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { z } from 'zod';
    import { resolve } from '$lib/paths';
    import { apiGet, apiPost } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store';
    import { RunTriggerResponseSchema } from '$lib/schemas/task-definition.schema.js';
    import { getIngestStageActivity } from '$lib/api/admin.js';
    import { useNow } from '$lib/utils/use-now.svelte';
    import { relativeTime } from '$lib/utils/relative-time';
    import { Icon, ArrowRight } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { formatPercent } from '$lib/utils/admin/formatters.js';
    // One name per step on every surface: this card said "Intro/outro
    // detection" and "Recommendations (AI)" where the map said "Intro" and
    // "Library" for the same two steps.
    import { pipelineStepName } from '$lib/config/pipeline-step-names.js';

    /**
     * Library-processing hero — the positive "your library is being processed,
     * here's how far and that it's still moving" signal a fresh OSS admin needs
     * during the import anxiety window. Always-on chrome: a four-state machine
     * (loading / empty / working / done) keeps the hero visible so a settled
     * library shows a "fully processed" reassurance instead of an empty gap.
     * Momentum (a moving "updated Ns ago" + recent throughput) reassures more
     * than ETA accuracy.
     *
     * The aggregate bar comes from the coverage stage-row summary; the per-stage
     * rows + momentum from /api/admin/ingest/stage-activity, denominated in
     * ELIGIBLE items (skipped_permanent items are disclosed as "not applicable",
     * never counted) so a stage like trickplay reads "done (48,118 of 48,118)"
     * instead of a terrifying-and-false "44%".
     *
     * Per-stage rows are clickable to expand into mockup-(b) detail:
     *   - larger bar + "N of M {unit}  {pct}%"
     *   - "~X remaining at the current pace (≈N {unit}/min)"
     *   - "Currently analyzing: N {unit}"
     *   - plain-language description + skip-reason disclosure
     *   - Advanced row: "N failed (will retry) · [View runs →] [Run now]"
     */
    const CoverageSummarySchema = z.object({
        total: z.number(),
        completed: z.number(),
        in_progress: z.number(),
        failed: z.number(),
        pending: z.number(),
        skipped: z.number().optional(),
        obsolete: z.number().optional(),
    });
    // `.passthrough()` is load-bearing, not decoration. apiGet runs every plain
    // object schema through `toStrict()` before validating, and this endpoint
    // returns `{ items, summary, limit, offset }` — so a probe that names only
    // `summary` is rejected with a single `unrecognized_keys` issue:
    //   [API] schema mismatch endpoint=/api/admin/library/coverage?limit=1 …
    //   issues=1  Unrecognized keys: "items", "limit", "offset"
    // Validation is fail-open so the UI kept working, which is why this sat in
    // prod logs rather than surfacing as a bug. NotificationDrawer's ProcProbeSchema
    // hits the same endpoint and already does this.
    const CoverageProbeSchema = z.object({ summary: CoverageSummarySchema }).passthrough();
    const StageProgressSchema = z.object({
        stage_id: z.string(),
        completed: z.number(),
        remaining: z.number(),
        notApplicable: z.number(),
        eligibleTotal: z.number(),
        completed_5m: z.number(),
        running: z.number(),
        failed_transient: z.number().optional().default(0),
        failed_permanent: z.number().optional().default(0),
    });
    type StageProgress = z.infer<typeof StageProgressSchema>;

    type Summary = z.infer<typeof CoverageSummarySchema>;

    // Friendly label, denomination unit, plain-language description and skip-reason
    // per headline stage_id. Kept in sync with HEADLINE_PROGRESS_STAGE_IDS in
    // ingest-map.queries.ts. The taskId is the owning task that /api/tasks/:id/run
    // accepts — for multi-stage tasks the task id differs from the stage id.
    interface StageMeta {
        label: string;
        unit: string;
        taskId: string;
        description: string;
        skipReason: string;
    }
    const STAGE_META: Record<string, StageMeta> = {
        'media-probe-a': {
            label: 'Importing & matching',
            unit: 'files',
            taskId: 'media-probe',
            description:
                'Files are being scanned and matched to your media library. New titles appear as each file is identified.',
            skipReason: 'already probed or not a media file',
        },
        'trickplay-generation': {
            label: 'Trickplay previews',
            unit: 'videos',
            taskId: 'trickplay-generation',
            description:
                'Thumbnail strip previews are being generated so you can scrub the timeline to see what is at any point. Your library is fully watchable while this runs.',
            skipReason: 'no video track (music, seasons, or discovery items without files)',
        },
        // Keyed to the SPLIT stage id (16.212.0); `taskId` below stays the
        // task id, which did not change and is what the deep link needs.
        'lumastra-intro-analyzer:visual': {
            label: 'Intro/outro detection',
            unit: 'episodes',
            taskId: 'lumastra-intro-analyzer',
            description:
                'Skip-intro buttons appear as each show finishes. Your library is fully watchable while this runs in the background.',
            skipReason: 'no file on disk, or too short to contain an intro',
        },
        'music-analysis': {
            label: 'Music analysis',
            unit: 'tracks',
            taskId: 'music-analysis',
            description:
                'BPM, mood, and audio features are being extracted so music recommendations work well.',
            skipReason: 'not a music track or audio analysis binary unavailable',
        },
        'library-embeddings': {
            label: 'Recommendations (AI)',
            unit: 'items',
            taskId: 'library-embeddings',
            description:
                'AI recommendation vectors are being generated. Recommendations improve progressively as more items are processed.',
            skipReason: 'no AI API key configured or item not in library',
        },
    };
    const STAGE_ORDER = [
        'media-probe-a',
        'trickplay-generation',
        'lumastra-intro-analyzer:visual',
        'music-analysis',
        'library-embeddings',
    ];

    let summary = $state<Summary | null>(null);
    let runningNow = $state(0);
    let completed5m = $state(0);
    let lastCompletedIso = $state<string | null>(null);
    let progress = $state<StageProgress[]>([]);
    // True once a COHERENT snapshot (coverage AND stage-activity together) has
    // loaded at least once. Gating render on this prevents a partial first load
    // (coverage OK, stage-activity failed → summary set, progress still []) from
    // being misread as a settled "done" library.
    let loaded = $state(false);

    const now = useNow(5000);

    // Expanded stage rows — SvelteSet per svelte/prefer-svelte-reactivity rule.
    const expandedStages = new SvelteSet<string>();

    function toggleExpand(stageId: string): void {
        if (expandedStages.has(stageId)) {
            expandedStages.delete(stageId);
        } else {
            expandedStages.add(stageId);
        }
    }

    // In-flight "Run now" triggers per taskId.
    const triggeringTasks = new SvelteSet<string>();

    async function triggerRun(taskId: string): Promise<void> {
        if (triggeringTasks.has(taskId)) return;
        triggeringTasks.add(taskId);
        try {
            // Through the API client (base path, auth-expiry handling) and
            // with the outcome reported: a refused run used to look like a
            // queued one.
            const { data, error } = await apiPost(
                `/api/tasks/${encodeURIComponent(taskId)}/run`,
                RunTriggerResponseSchema,
                {},
            );
            if (error || !data) {
                toasts.error(m.admin_task_run_error({ error: error ?? m.toast_unknown_error() }));
            } else if (data.deduped) {
                toasts.info(m.admin_task_run_already_running());
            } else {
                toasts.success(m.admin_task_run_started());
            }
        } finally {
            triggeringTasks.delete(taskId);
        }
    }

    async function load(): Promise<void> {
        const [cov, act] = await Promise.all([
            apiGet('/api/admin/library/coverage?limit=1', CoverageProbeSchema),
            getIngestStageActivity(),
        ]);
        if (cov.data) summary = cov.data.summary;
        if (act.data) {
            runningNow = act.data.stages.reduce((n, s) => n + s.running, 0);
            completed5m = act.data.stages.reduce((n, s) => n + s.completed_5m, 0);
            const times = act.data.stages
                .map((s) => s.last_completed_at)
                .filter((t): t is string => t !== null);
            lastCompletedIso = times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
            progress = act.data.progress as StageProgress[];
        }
        // Only consider the hero "loaded" once both halves of the snapshot have
        // arrived together — otherwise an empty progress[] from a failed activity
        // fetch could render as a false "done" while coverage says total > 0.
        if (cov.data && act.data) loaded = true;
    }

    onMount(() => {
        let timer: ReturnType<typeof setTimeout>;
        let cancelled = false;
        // Poll fast while work is in flight (momentum matters), but back off on a
        // steady-state install so an idle /admin isn't hitting these aggregates
        // every few seconds forever.
        async function tick(): Promise<void> {
            try {
                await load();
            } catch {
                // expected: a transient fetch failure — keep the last numbers and
                // try again on the next tick instead of ending the poll chain.
            }
            if (cancelled) return;
            timer = setTimeout(() => void tick(), hasWork ? 8000 : 30000);
        }
        void tick();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    });

    /**
     * Setup-view phase labels (§6.2). Deliberately separate from STAGE_META's
     * `label`: the catalog labels name the machinery ("Trickplay previews"),
     * the setup labels name what the operator is waiting for.
     *
     * 🔴 The previews row carries NO "this is the slow one" annotation, and the
     * setup view never presents it as a phase of a default first run. Verified
     * 2026-08-26: `TRICKPLAY_ENABLED` is `defaultValue: false`
     * (`src/lib/config/schema.ts:6262`), so trickplay generation does not run
     * out of the box. See `notStartedRows` below for how it (and any other
     * gated-off stage) is kept out of the progress math instead.
     */
    const SETUP_PHASE_LABEL: Record<string, () => string> = {
        'media-probe-a': m.admin_setup_phase_media_probe,
        'trickplay-generation': m.admin_setup_phase_trickplay,
        'lumastra-intro-analyzer:visual': m.admin_setup_phase_intro,
        'music-analysis': m.admin_setup_phase_music,
        'library-embeddings': m.admin_setup_phase_embeddings,
    };

    interface Props {
        compact?: boolean;
        /**
         * `'setup'` renders the first-run setup view (§6.2) instead of the
         * steady-state hero: phased checklist, a RANGED eta, the three
         * load-bearing reassurance lines, and suppressed per-item failure
         * noise. The parent decides when a first pass is in progress; this
         * component only renders what it is told to.
         */
        variant?: 'default' | 'setup';
        /**
         * Lets the parent (the /admin/tasks page) react to the state this
         * component already computes, instead of duplicating both fetches to
         * work out whether a first pass is still running. Fires on every
         * change, including the initial resolve.
         */
        onstate?: (s: {
            state: 'loading' | 'empty' | 'working' | 'done';
            /** Aggregate across ALL headline stages, stalled ones included. */
            pct: number;
            eligible: number;
            remaining: number;
            /**
             * Same three numbers over the stages that have actually STARTED
             * (see `hasStarted`). 🔴 A first-run gate must use these, never the
             * aggregate above: on a stock install `trickplay-generation` and
             * `library-embeddings` hold eligible rows they can never complete,
             * which pins the aggregate percentage low permanently and leaves
             * `state` stuck on `'working'` forever.
             */
            activePct: number;
            activeEligible: number;
            activeRemaining: number;
            permanentFailed: number;
        }) => void;
    }

    let { compact = false, variant = 'default', onstate }: Props = $props();

    // Headline per-stage rows, ordered + filtered to stages that have any eligible
    // items at all (a stage with 0 eligible rows is not worth a line).
    let progressRows = $derived(
        STAGE_ORDER.map((id) => progress.find((p) => p.stage_id === id)).filter(
            (p): p is StageProgress => !!p && p.eligibleTotal > 0,
        ),
    );

    // Aggregate completeness derived from the per-stage rows (NOT coverage summary
    // buckets). eligibleTotal already excludes not-applicable items; remaining
    // includes failed_transient/obsolete but NOT failed_permanent, so obsolete is
    // consistently treated as not-done here (fixes B3 — obsolete no longer inflates
    // the percentage). failed_permanent items are excluded from the denominator,
    // so a fully-drained stage reads 100% even when it has permanent failures.
    let sumCompleted = $derived(progressRows.reduce((n, p) => n + p.completed, 0));
    let sumEligible = $derived(progressRows.reduce((n, p) => n + p.eligibleTotal, 0));
    // When there is no eligible headline work at all (sumEligible === 0 — e.g. a
    // music-only / Live-TV-only / discovery-only library), there is nothing to
    // process, so the aggregate reads 100% (complete) rather than a misleading 0%.
    let pct = $derived(
        sumEligible > 0 ? Math.min(100, Math.round((sumCompleted / sumEligible) * 100)) : 100,
    );

    // Total permanent failures across stages. Drives the green-vs-neutral done-state
    // split — NOT pct (a done stage reads 100% even with permanent failures, since
    // they are outside the eligible denominator).
    let totalPermanentFailed = $derived(progressRows.reduce((n, p) => n + p.failed_permanent, 0));

    // Aggregate remaining across stages — drives the ETA + "has work" cadence.
    let remaining = $derived(progressRows.reduce((n, p) => n + p.remaining, 0));

    // Four-state machine. load() fetches coverage + stage-activity in one
    // Promise.all, so a non-null summary means progress is populated too (possibly
    // []). Gate `loading` on summary === null only — NEVER on progressRows being
    // empty, or a settled library with no eligible headline-stage rows (music-only,
    // Live-TV-only, discovery-only) would fall through to a permanent blank panel,
    // re-opening the empty gap this always-on hero exists to close.
    let heroState = $derived.by((): 'loading' | 'empty' | 'working' | 'done' => {
        if (!loaded || summary === null) return 'loading';
        if (summary.total === 0) return 'empty';
        if (progressRows.some((p) => p.remaining > 0)) return 'working';
        // Settled: media exists and no eligible headline-stage work remains. This
        // includes libraries with zero eligible headline rows (nothing to process
        // → done at 100%), never a blank panel.
        return 'done';
    });

    // Retained ONLY as the poll-cadence signal (fast while working, slow when idle).
    // No longer gates rendering.
    let hasWork = $derived(heroState === 'working');
    let movingNow = $derived(runningNow > 0 || completed5m > 0);

    // The headline percentage can NEVER read 100 % while work remains: prod
    // showed "100%" with 1 of 218,752 steps outstanding (Math.round). The bar
    // width may round; the number the operator reads may not.
    let pctLabel = $derived(formatPercent(sumCompleted, sumEligible));

    /**
     * Remaining work in stages that are NOT moving: nothing finished in the
     * last 5 minutes and nothing running. On prod the last outstanding step
     * was one trickplay item the stage had declined for ten days, while "1
     * done in last 5 min" came from a different stage — and the headline
     * turned that into "~5 min left", forever. Stalled work is named as
     * stalled, and only moving stages feed the estimate.
     */
    let stalledRemaining = $derived(
        progressRows
            .filter((p) => p.remaining > 0 && p.completed_5m === 0 && p.running === 0)
            .reduce((n, p) => n + p.remaining, 0),
    );
    let movingRemaining = $derived(remaining - stalledRemaining);

    // Rough ETA from recent throughput (completed in the last 5 min). Accuracy
    // is not the point — momentum is — so we keep it coarse and only show it when
    // something is actually moving. Cap at 48h for the aggregate headline only;
    // per-stage ETAs can show days.
    let ratePerMin = $derived(completed5m / 5);
    let etaLabel = $derived.by(() => {
        if (!movingNow || ratePerMin <= 0 || movingRemaining <= 0) return null;
        const mins = Math.ceil(movingRemaining / ratePerMin);
        if (mins > 48 * 60) return null;
        if (mins >= 90) return m.time_remaining_left({ time: `~${Math.round(mins / 60)}h` });
        if (mins < 1) return m.admin_ops_hero_almost_done();
        return m.time_remaining_left({ time: `~${mins} min` });
    });

    let updatedLabel = $derived(
        lastCompletedIso ? relativeTime(lastCompletedIso, now.value) : null,
    );

    // Aggregate "don't need" count across all headline stages — used for the
    // single card-footer line that matches mockup (a).
    let totalNotApplicable = $derived(progress.reduce((sum, p) => sum + p.notApplicable, 0));

    function stagePct(p: StageProgress): number {
        return p.eligibleTotal > 0
            ? Math.min(100, Math.round((p.completed / p.eligibleTotal) * 100))
            : 100;
    }

    /**
     * Compact per-stage ETA label for the collapsed row.
     * Unlike the aggregate headline, renders days when ETA > 48h
     * (the intro-analyzer flagship example: "~3 d").
     */
    function stageEta(p: StageProgress): string | null {
        const rate = p.completed_5m / 5;
        if (rate <= 0 || p.remaining <= 0) return null;
        const mins = Math.ceil(p.remaining / rate);
        if (mins >= 24 * 60 * 2) return `~${Math.round(mins / (24 * 60))}d`;
        if (mins >= 90) return `~${Math.round(mins / 60)}h`;
        if (mins < 1) return 'almost done';
        return `~${mins} min`;
    }

    /**
     * Full ETA sentence for the expanded panel.
     * e.g. "~3 days remaining at the current pace (≈6 episodes/min)"
     */
    function stageEtaSentence(p: StageProgress, unit: string): string | null {
        const rate = p.completed_5m / 5;
        if (rate <= 0 || p.remaining <= 0) return null;
        const mins = Math.ceil(p.remaining / rate);
        const rateStr = rate < 1 ? `<1 ${unit}/min` : `≈${Math.round(rate)} ${unit}/min`;
        if (mins >= 24 * 60 * 2) {
            return `~${Math.round(mins / (24 * 60))} days remaining at the current pace (${rateStr})`;
        }
        if (mins >= 90) {
            return `~${Math.round(mins / 60)} hours remaining at the current pace (${rateStr})`;
        }
        if (mins < 1) {
            return `almost done (${rateStr})`;
        }
        return `~${mins} minutes remaining at the current pace (${rateStr})`;
    }

    // ---------------------------------------------------------------------
    // Setup view (§6.2) — first-run only.
    // ---------------------------------------------------------------------

    /**
     * A stage is only counted as a first-run PHASE once it has shown evidence
     * of actually doing something: a completion, an in-flight item, or a
     * completion inside the last 5 minutes.
     *
     * 🔴 This split is not cosmetic. Verified 2026-08-26, TWO of the five
     * headline stages are seeded with eligible rows but cannot make progress on
     * a stock install:
     *
     *   - `trickplay-generation` — its stage eligibility (`media-item-tasks.ts`,
     *     the `trickplay-generation` entry in `coversStages`) tests only for a
     *     probed video stream; it does NOT consult `TRICKPLAY_ENABLED`, which
     *     defaults to false. Every movie and episode is therefore seeded
     *     eligible, while `generateTrickplayForMediaItem()`
     *     (`trickplay-generator.service.ts:1854`) returns `success: false`
     *     immediately, so coverage is never written.
     *   - `library-embeddings` — scheduled unconditionally, but every embedding
     *     provider key (`VOYAGE_API_KEY` / `OPENAI_API_KEY` / `EMBEDDING_API_KEY`)
     *     defaults to `''`, so each item errors out until an operator supplies one.
     *
     * Folding either into the denominator produces a bar that can never reach
     * 100% and an ETA that is simply false — the exact "fake determinate
     * progress" the ideas doc calls the trust-destroying anti-pattern. So the
     * progress math covers the phases that have started, and the rest are
     * disclosed by name, with no percentage and no estimate, under
     * "Hasn't started yet".
     *
     * This is self-correcting rather than a hardcoded exclusion list: a stage
     * joins the active set the moment it genuinely completes its first item, so
     * an operator who has enabled trickplay sees it counted normally.
     */
    function hasStarted(p: StageProgress): boolean {
        return p.completed > 0 || p.running > 0 || p.completed_5m > 0;
    }

    let setupActiveRows = $derived(progressRows.filter(hasStarted));
    let setupNotStartedRows = $derived(progressRows.filter((p) => !hasStarted(p)));

    let setupCompleted = $derived(setupActiveRows.reduce((n, p) => n + p.completed, 0));
    let setupEligible = $derived(setupActiveRows.reduce((n, p) => n + p.eligibleTotal, 0));
    let setupRemaining = $derived(setupActiveRows.reduce((n, p) => n + p.remaining, 0));
    let setupPct = $derived(
        setupEligible > 0 ? Math.min(100, Math.round((setupCompleted / setupEligible) * 100)) : 0,
    );

    /**
     * Aggregated problem count for the first pass. Both failure kinds are rolled
     * into ONE number that is deliberately NOT rendered while setup runs (§6.3):
     * nobody can act on individual failures while 16,000 items are in flight,
     * and a red badge during setup permanently teaches the operator to ignore
     * red. It surfaces once, at the finish moment.
     */
    let setupProblemCount = $derived(
        progressRows.reduce((n, p) => n + p.failed_permanent + p.failed_transient, 0),
    );

    function formatSpan(mins: number): string {
        if (mins >= 48 * 60) return m.admin_setup_days({ count: Math.round(mins / (24 * 60)) });
        if (mins >= 90) return m.admin_setup_hours({ count: Math.round(mins / 60) });
        return m.admin_setup_minutes({ count: Math.max(1, Math.round(mins / 5) * 5) });
    }

    /**
     * RANGED first-run estimate — never a point estimate (§6.2). A first pass
     * front-loads its cheap work (scanning and identifying are fast; analysis
     * and embeddings are not), so a rate sampled early always flatters the
     * finish time. The upper bound is therefore 2.5x the naive projection, and
     * the lower bound is 0.75x rather than the projection itself, so the honest
     * uncertainty is visible in both directions.
     *
     * Returns null when nothing has completed recently — in which case the view
     * says so in words instead of inventing a number.
     */
    let setupEtaRange = $derived.by((): string | null => {
        const rate = setupActiveRows.reduce((n, p) => n + p.completed_5m, 0) / 5;
        if (rate <= 0 || setupRemaining <= 0) return null;
        const mins = setupRemaining / rate;
        const low = formatSpan(mins * 0.75);
        const high = formatSpan(mins * 2.5);
        // Both bounds landing in the same bucket would read as a point estimate,
        // which is the thing this is here to avoid — widen by one bucket.
        if (low === high) return m.admin_setup_eta_range({ low, high: formatSpan(mins * 4) });
        return m.admin_setup_eta_range({ low, high });
    });

    // Report the state the parent needs so /admin/tasks doesn't duplicate both
    // fetches just to learn whether a first pass is still running.
    $effect(() => {
        onstate?.({
            state: heroState,
            pct,
            eligible: sumEligible,
            remaining,
            activePct: setupPct,
            activeEligible: setupEligible,
            activeRemaining: setupRemaining,
            permanentFailed: totalPermanentFailed,
        });
    });
</script>

{#if variant === 'setup' && heroState !== 'loading'}
    <!--
      First-run setup view (§6.2). Replaces the 78-card catalog while the first
      pass runs: during that window the catalog is noise, and the three
      reassurance lines below are what actually stop a fresh operator from
      concluding the software is broken inside ten minutes.
    -->
    <section
        class="rounded-xl border border-sky-700/40 bg-sky-950/20 p-6"
        aria-label={m.admin_setup_title()}>
        <h2 class="flex items-center gap-2 text-lg font-semibold text-surface-100">
            {#if movingNow}
                <span class="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-sky-400"></span>
            {/if}
            {m.admin_setup_title()}
        </h2>

        {#if summary && summary.total > 0}
            <p class="mt-1 text-sm text-surface-400">
                {m.admin_setup_found({ count: summary.total.toLocaleString() })}
            </p>
        {/if}

        <!-- Aggregate bar + RANGED eta. Never a point estimate. -->
        <div class="mt-4 flex items-baseline justify-between gap-3 text-sm">
            <span class="font-medium text-surface-200">{setupPct}%</span>
            <span class="text-surface-300">
                {setupEtaRange ?? m.admin_setup_eta_unknown()}
            </span>
        </div>
        <div class="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-surface-700">
            <div class="h-full rounded-full bg-sky-500 transition-all" style="width: {setupPct}%">
            </div>
        </div>

        <!-- Phases that have actually started. -->
        {#if setupActiveRows.length > 0}
            <ul class="mt-5 space-y-2.5">
                {#each setupActiveRows as p (p.stage_id)}
                    {@const done = p.remaining === 0}
                    {@const label =
                        SETUP_PHASE_LABEL[p.stage_id]?.() ??
                        STAGE_META[p.stage_id]?.label ??
                        p.stage_id}
                    <li class="flex items-baseline justify-between gap-3 text-sm">
                        <span class="flex items-center gap-2 text-surface-200">
                            <span
                                class="w-3 shrink-0 {done ? 'text-emerald-400' : 'text-sky-400'}"
                                aria-hidden="true">{done ? '✓' : '▶'}</span>
                            {label}
                        </span>
                        <span class="shrink-0 text-xs text-surface-400">
                            {#if done}
                                <span class="text-emerald-400">{m.admin_setup_phase_done()}</span>
                            {:else}
                                {p.completed.toLocaleString()} / {p.eligibleTotal.toLocaleString()}
                            {/if}
                        </span>
                    </li>
                {/each}
            </ul>
        {/if}

        <!--
          Stages seeded with eligible rows that have never produced a single
          completion. Named honestly, with no percentage and no estimate, and
          excluded from the bar above — see `hasStarted()` for why this matters
          on a stock install (trickplay is off by default; embeddings need a key).
        -->
        {#if setupNotStartedRows.length > 0}
            <div class="mt-5 border-t border-sky-800/30 pt-4">
                <h3 class="text-xs font-medium uppercase tracking-wide text-surface-500">
                    {m.admin_setup_not_started_heading()}
                </h3>
                <ul class="mt-2 space-y-1.5">
                    {#each setupNotStartedRows as p (p.stage_id)}
                        <li class="flex items-center gap-2 text-sm text-surface-400">
                            <span class="w-3 shrink-0 text-surface-600" aria-hidden="true">·</span>
                            {SETUP_PHASE_LABEL[p.stage_id]?.() ??
                                STAGE_META[p.stage_id]?.label ??
                                p.stage_id}
                        </li>
                    {/each}
                </ul>
                <p class="mt-2 text-xs text-surface-500">
                    {m.admin_setup_not_started_note()}
                    <a
                        href={resolve('/admin/settings/media')}
                        class="underline hover:text-surface-300"
                        >{m.admin_setup_not_started_settings_link()}</a>
                </p>
            </div>
        {/if}

        <!-- The three load-bearing sentences. -->
        <div class="mt-5 space-y-1.5 border-t border-sky-800/30 pt-4 text-sm">
            <p class="font-medium text-surface-200">{m.admin_setup_reassure_watch()}</p>
            <p class="text-surface-400">{m.admin_setup_reassure_cpu()}</p>
        </div>

        <!--
          §6.3 — the problem COUNT is deliberately withheld until the pass
          finishes. Only the fact that problems are being collected is stated,
          with no number and no red.
        -->
        {#if setupProblemCount > 0}
            <p class="mt-3 text-xs text-surface-500">{m.admin_setup_problems_pending()}</p>
        {/if}
    </section>
{:else if compact}
    {#if heroState === 'empty'}
        <div class="flex items-center gap-2 text-sm" aria-label={m.admin_ops_hero_aria_label()}>
            <span class="inline-block h-2 w-2 shrink-0 rounded-full bg-surface-500"></span>
            <span class="text-surface-400">{m.admin_ops_hero_empty_compact()}</span>
            <a href={resolve('/admin/tasks/pipeline')} class="ml-1 text-sky-400 hover:text-sky-300"
                >→ {m.admin_ops_hero_get_started()}</a>
        </div>
    {:else if heroState === 'working'}
        <div class="flex items-center gap-2 text-sm" aria-label={m.admin_ops_hero_aria_label()}>
            <span
                class="inline-block h-2 w-2 shrink-0 rounded-full bg-sky-400 {movingNow
                    ? 'animate-pulse'
                    : ''}"></span>
            <span class="text-surface-300">Processing {pctLabel}</span>
            {#if etaLabel}
                <span class="text-surface-400">· {etaLabel}</span>
            {/if}
            <a href={resolve('/admin/tasks/pipeline')} class="ml-1 text-sky-400 hover:text-sky-300"
                >→ {m.admin_ops_hero_view_details()}</a>
        </div>
    {:else if heroState === 'done'}
        <div class="flex items-center gap-2 text-sm" aria-label={m.admin_ops_hero_aria_label()}>
            {#if totalPermanentFailed === 0}
                <span class="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-400"></span>
                <span class="text-surface-300">✓ {m.admin_ops_hero_done_full()}</span>
            {:else}
                <span class="inline-block h-2 w-2 shrink-0 rounded-full bg-surface-400"></span>
                <span class="text-surface-300"
                    >{m.admin_ops_hero_done_neutral()} · {m.admin_ops_hero_need_review({
                        count: totalPermanentFailed,
                    })}</span>
            {/if}
            <a href={resolve('/admin/tasks/pipeline')} class="ml-1 text-sky-400 hover:text-sky-300"
                >→ {m.admin_ops_hero_view_details()}</a>
        </div>
    {/if}
{:else if heroState === 'empty'}
    <section
        class="rounded-xl border border-surface-700/40 bg-surface-900/20 p-5"
        aria-label={m.admin_ops_hero_aria_label()}>
        <h2 class="text-sm font-semibold text-surface-100">{m.admin_ops_hero_empty_full()}</h2>
    </section>
{:else if heroState === 'done'}
    <section
        class="rounded-xl border p-5 {totalPermanentFailed === 0
            ? 'border-emerald-700/40 bg-emerald-950/20'
            : 'border-surface-700/40 bg-surface-900/30'}"
        aria-label={m.admin_ops_hero_aria_label()}>
        <div class="mb-2 flex items-baseline justify-between gap-3">
            <h2 class="flex items-center gap-2 text-sm font-semibold text-surface-100">
                {#if totalPermanentFailed === 0}
                    ✓ {m.admin_ops_hero_done_full()}
                    {#if updatedLabel}
                        <span class="font-normal text-surface-400"
                            >· {m.admin_ops_hero_updated({ ago: updatedLabel })}</span>
                    {/if}
                {:else}
                    {m.admin_ops_hero_done_neutral()}
                {/if}
            </h2>
            <span class="text-sm font-medium text-surface-200">{pct}%</span>
        </div>

        <div class="h-2 w-full overflow-hidden rounded-full bg-surface-700">
            <div
                class="h-full rounded-full transition-all {totalPermanentFailed === 0
                    ? 'bg-emerald-500'
                    : 'bg-surface-400'}"
                style="width: {pct}%">
            </div>
        </div>

        {#if progressRows.length > 0}
            <ul class="mt-4 space-y-2 border-t border-surface-800/30 pt-4">
                {#each progressRows as p (p.stage_id)}
                    {@const meta = STAGE_META[p.stage_id]}
                    {@const spct = stagePct(p)}
                    <li class="rounded-lg border border-surface-800/20 px-3 py-2">
                        <div class="mb-1 flex items-baseline justify-between gap-3 text-xs">
                            <span class="font-medium text-surface-200"
                                >{pipelineStepName(p.stage_id)}</span>
                            <span class="shrink-0 text-emerald-400">✓ done</span>
                        </div>
                        <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-800">
                            <div
                                class="h-full rounded-full bg-emerald-500 transition-all"
                                style="width: {spct}%">
                            </div>
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}

        <!-- Quiet permanent-failure footnote — mirrors the totalNotApplicable footnote. -->
        {#if totalPermanentFailed > 0}
            <p class="mt-3 text-[11px] text-surface-500">
                ⓘ {m.admin_ops_hero_permanent_failed_footnote({ count: totalPermanentFailed })} ·
                <a
                    href={resolve('/admin/tasks/pipeline')}
                    class="hover:text-surface-300 hover:underline"
                    >{m.admin_ops_hero_view_details()} →</a>
            </p>
        {/if}
    </section>
{:else if heroState === 'working' && summary}
    <section
        class="rounded-xl border border-sky-700/40 bg-sky-950/20 p-5"
        aria-label={m.admin_ops_hero_aria_label()}>
        <div class="mb-2 flex items-baseline justify-between gap-3">
            <h2 class="flex items-center gap-2 text-sm font-semibold text-surface-100">
                {#if movingNow}
                    <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-400"></span>
                {/if}
                {m.admin_ops_hero_title()}
            </h2>
            <span class="text-sm font-medium text-surface-200">{pctLabel}</span>
        </div>

        <div class="h-2 w-full overflow-hidden rounded-full bg-surface-700">
            <div class="h-full rounded-full bg-sky-500 transition-all" style="width: {pct}%"></div>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-surface-400">
            <span class="text-surface-300"
                >{m.admin_ops_hero_steps_scope({
                    done: sumCompleted.toLocaleString(),
                    total: sumEligible.toLocaleString(),
                    stages: progressRows.length,
                })}</span>
            {#if movingNow}
                {#if runningNow > 0}
                    <span class="text-sky-300"
                        >· {m.admin_ops_hero_processing_now({
                            count: runningNow.toLocaleString(),
                        })}</span>
                {/if}
                {#if completed5m > 0}
                    <span
                        >· {m.admin_ops_hero_done_last_5min({
                            count: completed5m.toLocaleString(),
                        })}</span>
                {/if}
                {#if etaLabel}
                    <span class="text-surface-300">· {etaLabel}</span>
                {/if}
                {#if updatedLabel}
                    <span>· {m.admin_ops_hero_updated({ ago: updatedLabel })}</span>
                {/if}
            {:else if stalledRemaining === 0}
                <span class="text-amber-400">· queued — waiting to start</span>
            {/if}
            {#if stalledRemaining > 0}
                <a
                    href={resolve('/admin/tasks/pipeline')}
                    class="text-amber-400 hover:text-amber-300 hover:underline"
                    >· {m.admin_ops_hero_not_progressing({ count: stalledRemaining })}</a>
            {/if}
        </div>

        {#if progressRows.length > 0}
            <ul class="mt-4 space-y-2 border-t border-sky-800/30 pt-4">
                {#each progressRows as p (p.stage_id)}
                    {@const meta = STAGE_META[p.stage_id]}
                    {@const spct = stagePct(p)}
                    {@const eta = stageEta(p)}
                    {@const done = p.remaining === 0}
                    {@const isExpanded = expandedStages.has(p.stage_id)}
                    {@const taskId = meta?.taskId ?? p.stage_id}
                    <li class="rounded-lg border border-sky-800/20 overflow-hidden">
                        <!-- Clickable header row — toggles expand -->
                        <button
                            type="button"
                            class="w-full px-3 py-2 text-left hover:bg-sky-900/20 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                            aria-expanded={isExpanded}
                            onclick={() => toggleExpand(p.stage_id)}>
                            <div class="mb-1 flex items-baseline justify-between gap-3 text-xs">
                                <span
                                    class="flex items-center gap-1.5 font-medium text-surface-200">
                                    <span
                                        class="text-surface-500 transition-transform duration-150 inline-block {isExpanded
                                            ? 'rotate-90'
                                            : ''}"
                                        aria-hidden="true">›</span>
                                    {pipelineStepName(p.stage_id)}
                                </span>
                                <span class="shrink-0 text-surface-400">
                                    {#if done}
                                        <span class="text-emerald-400">✓ done</span>
                                    {:else}
                                        {p.completed.toLocaleString()} of {p.eligibleTotal.toLocaleString()}
                                        {meta?.unit ?? 'items'}
                                        {#if eta}
                                            <span class="ml-1 text-surface-500">{eta}</span>
                                        {/if}
                                    {/if}
                                </span>
                            </div>
                            <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-800">
                                <div
                                    class="h-full rounded-full transition-all {done
                                        ? 'bg-emerald-500'
                                        : 'bg-sky-500'}"
                                    style="width: {spct}%">
                                </div>
                            </div>
                        </button>

                        <!-- Expanded panel — mockup (b) detail -->
                        {#if isExpanded}
                            <div class="border-t border-sky-800/20 px-3 py-3 space-y-3">
                                <!-- Larger bar + N of M {unit}  {pct}% -->
                                <div>
                                    <div
                                        class="mb-1.5 flex items-baseline justify-between text-sm text-surface-200">
                                        <span
                                            >{p.completed.toLocaleString()} of {p.eligibleTotal.toLocaleString()}
                                            {meta?.unit ?? 'items'}</span>
                                        <span class="text-surface-400">{spct}%</span>
                                    </div>
                                    <div
                                        class="h-2.5 w-full overflow-hidden rounded-full bg-surface-800">
                                        <div
                                            class="h-full rounded-full transition-all {done
                                                ? 'bg-emerald-500'
                                                : 'bg-sky-500'}"
                                            style="width: {spct}%">
                                        </div>
                                    </div>
                                </div>

                                <!-- ETA sentence + "Currently analyzing: N {unit}" -->
                                {#if !done}
                                    {@const etaSentence = stageEtaSentence(
                                        p,
                                        meta?.unit ?? 'items',
                                    )}
                                    <div class="space-y-1 text-xs">
                                        <!-- No ETA means no completions in the last 5
                                             minutes, which is NOT the same as not
                                             running: a stage whose items each take
                                             longer than the window (trickplay on a
                                             long film) legitimately scores zero. This
                                             used to fall through to "Queued — not
                                             started yet" on the AGGREGATE `movingNow`,
                                             so a stage sat there claiming it had not
                                             started directly above its own "Currently
                                             analyzing: 2 videos" line. Judge this
                                             stage by this stage's own numbers. -->
                                        {#if etaSentence}
                                            <p class="text-surface-400">{etaSentence}</p>
                                        {:else if p.running > 0}
                                            <p class="text-surface-400">
                                                Running — nothing has finished in the last 5
                                                minutes, so there is no estimate yet.
                                            </p>
                                        {:else if p.remaining > 0}
                                            <p class="text-amber-400">Queued — waiting to start.</p>
                                        {/if}
                                        {#if p.running > 0}
                                            <p class="text-sky-300">
                                                Currently analyzing: {p.running.toLocaleString()}
                                                {meta?.unit ?? 'items'}
                                            </p>
                                        {/if}
                                    </div>
                                {/if}

                                <!-- Plain-language reassurance description -->
                                {#if meta?.description}
                                    <p class="text-xs text-surface-400">{meta.description}</p>
                                {/if}

                                <!-- Skip disclosure with reason -->
                                {#if p.notApplicable > 0}
                                    <p class="text-xs text-surface-500">
                                        {p.notApplicable.toLocaleString()}
                                        {meta?.unit ?? 'items'} were skipped ({meta?.skipReason ??
                                            'not applicable'}).
                                        <a
                                            href={resolve('/admin/tasks/pipeline')}
                                            class="hover:text-surface-300 hover:underline"
                                            >Why? · Details →</a>
                                    </p>
                                {/if}

                                <!-- Advanced row: failed count + stage id + links -->
                                <div
                                    class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-sky-800/20 pt-2 text-xs text-surface-500">
                                    <span class="font-medium text-surface-400">Advanced:</span>
                                    {#if p.failed_transient > 0}
                                        <span class="text-amber-400"
                                            >{m.admin_ops_hero_stage_failed_transient({
                                                count: p.failed_transient,
                                            })}</span>
                                        <span aria-hidden="true">·</span>
                                    {/if}
                                    {#if p.failed_permanent > 0}
                                        <a
                                            href={resolve('/admin/tasks/pipeline')}
                                            class="text-red-400 hover:text-red-300 hover:underline"
                                            >{m.admin_ops_hero_stage_failed_permanent({
                                                count: p.failed_permanent,
                                            })}</a>
                                        <span aria-hidden="true">·</span>
                                    {/if}
                                    <span class="font-mono text-surface-600"
                                        >stage {p.stage_id}</span>
                                    <a
                                        href={resolve(
                                            `/admin/tasks/runs?taskId=${encodeURIComponent(taskId)}`,
                                        )}
                                        class="text-sky-400 hover:text-sky-300 hover:underline"
                                        >View runs →</a>
                                    <button
                                        type="button"
                                        class="text-sky-400 hover:text-sky-300 disabled:opacity-50"
                                        disabled={triggeringTasks.has(taskId)}
                                        onclick={() => void triggerRun(taskId)}>
                                        {triggeringTasks.has(taskId)
                                            ? m.admin_ops_hero_queuing()
                                            : m.admin_ops_hero_run_now()}
                                    </button>
                                </div>
                            </div>
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}

        <!-- Aggregate "don't need" footer line — single sentence matching mockup (a) -->
        {#if totalNotApplicable > 0}
            <p class="mt-3 text-[11px] text-surface-500">
                ⓘ {m.admin_ops_hero_not_applicable({ count: totalNotApplicable.toLocaleString() })} ·
                <a
                    href={resolve('/admin/tasks/pipeline')}
                    class="hover:text-surface-300 hover:underline"
                    >{m.admin_ops_hero_details_link()}</a>
            </p>
        {/if}

        <a
            href={resolve('/admin/tasks/pipeline')}
            class="mt-4 inline-flex items-center gap-1 text-xs font-medium text-sky-400 hover:text-sky-300">
            {m.admin_ops_hero_view_pipeline()}
            <Icon src={ArrowRight} class="h-3.5 w-3.5" />
        </a>
    </section>
{/if}
