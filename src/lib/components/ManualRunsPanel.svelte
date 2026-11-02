<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  @component
  App-wide corner panel for the runs the signed-in user started by hand: one
  row per live run with its progress, percent and an ETA, on every page. The
  success / failure notice at the end is a toast raised by the tracker
  (`$lib/stores/manual-runs.svelte`), so it appears wherever the user is.
  Renders nothing while no run is live.
-->
<script lang="ts">
    import { Icon, ArrowPath, ChevronDown, ChevronUp } from 'svelte-hero-icons';
    import { manualRuns, manualRunName } from '$lib/stores/manual-runs.svelte';
    import { EtaEstimator, formatEta } from '$lib/utils/eta-estimator';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages.js';
    import type { ManualRun } from '$lib/schemas/manual-runs';

    const COLLAPSED_KEY = 'v1:manual-runs:collapsed';

    let collapsed = $state(readCollapsed());
    const eta = new EtaEstimator();

    function readCollapsed(): boolean {
        try {
            return localStorage.getItem(COLLAPSED_KEY) === '1';
        } catch {
            return false;
        }
    }

    function toggle(): void {
        collapsed = !collapsed;
        try {
            localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
        } catch {
            /* per-viewer convenience only */
        }
    }

    interface Row {
        run: ManualRun;
        pct: number | null;
        etaSeconds: number | undefined;
    }

    // Recomputed on every poll (the tracker replaces `runs`), which is also
    // exactly when a new progress sample arrives for the ETA.
    const rows = $derived.by((): Row[] => {
        const out = manualRuns.runs.map((run) => {
            const known = run.state === 'active' && run.total && run.processed !== undefined;
            const pct = known
                ? Math.min(100, Math.round(((run.processed ?? 0) / (run.total ?? 1)) * 100))
                : null;
            const etaSeconds = known
                ? eta.update(run.id, run.processed ?? 0, run.total ?? 0)
                : undefined;
            return { run, pct, etaSeconds };
        });
        eta.retain(manualRuns.runs.map((run) => run.id));
        return out;
    });
</script>

{#if rows.length > 0}
    <aside
        class="fixed right-4 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-surface-700 bg-surface-800/95 shadow-xl backdrop-blur"
        style="bottom: calc(1rem + var(--music-bottom-nav-h, 0px) + var(--miniplayer-height, 0px)); z-index: {Z.NAV_POPUP};"
        aria-label={m.manual_runs_panel_title()}>
        <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-white"
            aria-expanded={!collapsed}
            aria-label={collapsed ? m.manual_runs_panel_show() : m.manual_runs_panel_hide()}
            onclick={toggle}>
            <Icon src={ArrowPath} class="h-4 w-4 animate-spin text-teal-400" />
            <span class="flex-1">{m.manual_runs_panel_title()} · {rows.length}</span>
            <Icon src={collapsed ? ChevronUp : ChevronDown} class="h-4 w-4 text-surface-400" />
        </button>
        {#if !collapsed}
            <ul class="max-h-64 space-y-2 overflow-y-auto border-t border-surface-700 px-3 py-2">
                {#each rows as { run, pct, etaSeconds } (run.id)}
                    <li class="space-y-1">
                        <div class="flex items-baseline justify-between gap-2 text-xs">
                            <span class="truncate text-surface-200" title={manualRunName(run)}>
                                {manualRunName(run)}
                            </span>
                            <span class="shrink-0 tabular-nums text-surface-400">
                                {#if pct === null}
                                    {run.state === 'pending' ? m.manual_run_waiting() : ''}
                                {:else}
                                    {pct}%{#if etaSeconds !== undefined}
                                        · {formatEta(etaSeconds)}{/if}
                                {/if}
                            </span>
                        </div>
                        <div
                            class="h-1 w-full overflow-hidden rounded-full bg-surface-700"
                            role="progressbar"
                            aria-label={manualRunName(run)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={pct ?? undefined}>
                            <div
                                class="h-full rounded-full bg-teal-500 transition-all duration-300"
                                class:animate-pulse={pct === null}
                                style="width: {pct ?? 100}%">
                            </div>
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}
    </aside>
{/if}
