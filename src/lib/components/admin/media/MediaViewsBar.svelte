<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  The media browser's saved views (triage spec §2): one pill per view with its
  live count, grouped as [All, Needs attention] | problem views | [Recently
  added, Files lost]. Exactly one is selected. A problem view with a zero count
  stays visible but dimmed, so "nothing to fix" reads as a fact.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import {
        ISSUE_SEVERITY,
        VIEW_ISSUE,
        type MediaBrowserView,
        type MediaIssueSeverity,
    } from '$lib/shared/media-issues.js';
    import { mediaViewHint, mediaViewLabel, severityDotClass } from './media-issue-presentation.js';

    interface Props {
        /** The views this scope offers, in display order (`viewsForScope`). */
        views: readonly MediaBrowserView[];
        counts: Readonly<Record<string, number>>;
        current: MediaBrowserView;
        onselect: (view: MediaBrowserView) => void;
    }
    let { views, counts, current, onselect }: Props = $props();

    const PRIMARY: readonly MediaBrowserView[] = ['all', 'attention', 'recent'];
    function severityOf(view: MediaBrowserView): MediaIssueSeverity | null {
        if (view === 'attention') return 'warn';
        const kind = VIEW_ISSUE[view];
        return kind ? ISSUE_SEVERITY[kind] : null;
    }
    let primary = $derived(views.filter((view) => PRIMARY.includes(view)));
    let issues = $derived(views.filter((view) => !PRIMARY.includes(view)));
    function pillClass(view: MediaBrowserView): string {
        const selected = view === current;
        if (selected) return 'border-yellow-500 bg-yellow-500 text-surface-950';
        const dim = (counts[view] ?? 0) === 0 && severityOf(view) !== null && view !== 'attention';
        return dim
            ? 'border-surface-700 bg-surface-800/40 text-surface-500 hover:text-surface-300'
            : 'border-surface-700 bg-surface-800/60 text-surface-200 hover:border-surface-500';
    }

    function countClass(view: MediaBrowserView): string {
        if (view === current) return 'bg-surface-950/20 text-surface-950';
        const severity = severityOf(view);
        const n = counts[view] ?? 0;
        if (severity === 'error' && n > 0) return 'bg-red-950 text-red-200';
        if (severity === 'warn' && n > 0) return 'bg-amber-950 text-amber-200';
        return 'bg-surface-700/70 text-surface-300';
    }
</script>

<div class="mb-4 space-y-2">
    <div class="flex flex-wrap items-center gap-2" role="group" aria-label={m.media_views_label()}>
        {#each primary as view (view)}
            {@const severity = severityOf(view)}
            <button
                type="button"
                class="inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors {pillClass(
                    view,
                )}"
                aria-pressed={view === current}
                onclick={() => onselect(view)}>
                {#if severity && view !== current}
                    <span class="h-1.5 w-1.5 rounded-full {severityDotClass(severity)}"></span>
                {/if}
                <span>{mediaViewLabel(view)}</span>
                <span
                    class="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums {countClass(
                        view,
                    )}">{(counts[view] ?? 0).toLocaleString()}</span>
            </button>
        {/each}
        <label class="inline-flex items-center gap-2 text-xs text-surface-300">
            {m.media_redesign_issue_chooser()}
            <select
                aria-label={m.media_redesign_issue_chooser()}
                class="rounded-lg border border-surface-700 bg-surface-800 px-2 py-1.5"
                value={issues.includes(current) ? current : ''}
                onchange={(event) =>
                    onselect((event.currentTarget.value || 'attention') as MediaBrowserView)}>
                <option value="">{m.media_redesign_all_issues()}</option>
                {#each issues as view (view)}
                    <option value={view}
                        >{mediaViewLabel(view)} ({(counts[view] ?? 0).toLocaleString()})</option>
                {/each}
            </select>
        </label>
    </div>
    <p class="text-xs text-surface-400">{mediaViewHint(current)}</p>
</div>
