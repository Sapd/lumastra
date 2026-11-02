<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  "What changed?" — a correlation view for "it worked last week": recent
  admin-caused changes (config saves, task pause/resume, licensing, cache
  clears, plugin installs) overlaid against the earliest failure the system
  has recorded in the last 24h, so an operator can see what happened around
  that time without hunting through the full audit log.

  Reads GET /api/admin/system/change-timeline (the real admin audit trail,
  filtered to the actions that plausibly explain a regression) and, as a
  best-effort correlation anchor, the existing failure-patterns endpoint.
  States no causation — it only shows how close in time two real events are.

  App-version history is NOT overlaid: there is no persisted record of which
  version was running when (see the change-timeline schema's module doc for
  why), so the footer says that plainly instead of inventing a version row.
-->
<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { formatDurationMs } from '$lib/utils/admin/formatters.js';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import {
        ChangeTimelineResponseSchema,
        type ChangeTimelineResponse,
        type ChangeTimelineEvent,
        type ChangeTimelineEventKind,
    } from '$lib/schemas/admin-change-timeline.schema.js';
    import {
        FailurePatternsResponseSchema,
        type FailurePatternsResponse,
    } from '$lib/schemas/task-system-failure-detection.schema.js';

    const MAX_SHOWN = 8;
    const SINCE_HOURS = 168;

    let changes = $state<ChangeTimelineResponse | null>(null);
    let failurePatterns = $state<FailurePatternsResponse | null>(null);
    // The failure lookup failed: the heading must say it could not check, not
    // that no failures happened.
    let patternsFailed = $state(false);
    let loadError = $state<string | null>(null);
    let destroyed = false;

    async function load(): Promise<void> {
        const [changesRes, patternsRes] = await Promise.all([
            apiGet(
                `/api/admin/system/change-timeline?sinceHours=${SINCE_HOURS}`,
                ChangeTimelineResponseSchema,
            ),
            apiGet(
                '/api/admin/task-system/failures/patterns?sinceHours=24',
                FailurePatternsResponseSchema,
            ),
        ]);
        if (destroyed) return;
        if (changesRes.error || !changesRes.data) {
            loadError = changesRes.error ?? m.admin_changes_load_failed();
            return;
        }
        changes = changesRes.data;
        // Correlation is a bonus, not required: the timeline still renders when
        // the patterns fetch fails, but the heading says so.
        failurePatterns = patternsRes.data ?? null;
        patternsFailed = !!patternsRes.error || !patternsRes.data;
        loadError = null;
    }

    onMount(() => {
        void load();
    });
    onDestroy(() => {
        destroyed = true;
    });

    const anchorTs = $derived.by<string | null>(() => {
        const patterns = failurePatterns?.patterns ?? [];
        if (patterns.length === 0) return null;
        return patterns.reduce(
            (earliest, p) => (p.firstSeen < earliest ? p.firstSeen : earliest),
            patterns[0].firstSeen,
        );
    });

    const shownEvents = $derived.by<ChangeTimelineEvent[]>(() =>
        (changes?.events ?? []).slice(0, MAX_SHOWN),
    );

    function kindLabel(kind: ChangeTimelineEventKind): string {
        switch (kind) {
            case 'settings':
                return m.admin_changes_kind_settings();
            case 'task-pause':
                return m.admin_changes_kind_task_pause();
            case 'task-resume':
                return m.admin_changes_kind_task_resume();
            case 'task-settings':
                return m.admin_changes_kind_task_settings();
            case 'licensing':
                return m.admin_changes_kind_licensing();
            case 'cache':
                return m.admin_changes_kind_cache();
            case 'plugin':
                return m.admin_changes_kind_plugin();
            case 'secret':
                return m.admin_changes_kind_secret();
            default:
                return m.admin_changes_kind_other();
        }
    }

    function eventDetail(ev: ChangeTimelineEvent): string | null {
        if (ev.kind === 'settings' && ev.changedLabels && ev.changedLabels.length > 0) {
            return ev.changedLabels.join(', ') + (ev.changedLabelsTruncated ? '…' : '');
        }
        if (
            (ev.kind === 'task-pause' ||
                ev.kind === 'task-resume' ||
                ev.kind === 'task-settings') &&
            ev.taskName
        ) {
            return ev.taskName;
        }
        return ev.target !== 'config' && ev.target !== '*' ? ev.target : null;
    }

    function relativeToAnchor(ev: ChangeTimelineEvent): string | null {
        const anchor = anchorTs;
        if (!anchor) return null;
        const diffMs = new Date(anchor).getTime() - new Date(ev.ts).getTime();
        const duration = formatDurationMs(Math.abs(diffMs));
        return diffMs >= 0
            ? m.admin_changes_before_anchor({ duration })
            : m.admin_changes_after_anchor({ duration });
    }

    function eventTime(iso: string): string {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
    }
</script>

<section
    class="rounded-lg border border-surface-700 bg-surface-900/40 p-4 space-y-3"
    aria-label={m.admin_changes_title()}>
    <div>
        <h2 class="text-sm font-semibold uppercase tracking-wide text-surface-300">
            {m.admin_changes_title()}
        </h2>
        <p class="mt-1 text-xs text-surface-500">{m.admin_changes_description()}</p>
    </div>

    {#if loadError}
        <p class="text-sm text-red-300">{loadError}</p>
    {:else if changes}
        <p class="text-sm text-surface-300">
            {#if anchorTs}
                {m.admin_changes_anchor_heading({ time: eventTime(anchorTs) })}
            {:else if patternsFailed}
                {m.admin_changes_failures_unavailable_heading()}
            {:else}
                {m.admin_changes_no_anchor_heading()}
            {/if}
        </p>

        {#if shownEvents.length === 0}
            <p class="text-xs text-surface-500">
                {m.admin_changes_empty({ days: Math.round(changes.window.sinceHours / 24) })}
            </p>
        {:else}
            <ul class="space-y-2">
                {#each shownEvents as ev (ev.id)}
                    <li
                        class="rounded border border-surface-800 bg-surface-950/40 px-3 py-2 text-xs">
                        <div class="flex items-baseline justify-between gap-3">
                            <span class="font-medium text-surface-200">{kindLabel(ev.kind)}</span>
                            <span class="text-surface-500">{eventTime(ev.ts)}</span>
                        </div>
                        {#if eventDetail(ev)}
                            <p class="mt-0.5 text-surface-400">{eventDetail(ev)}</p>
                        {/if}
                        <div
                            class="mt-0.5 flex items-center justify-between gap-3 text-surface-500">
                            <span>{m.admin_changes_actor({ actor: ev.actor })}</span>
                            {#if relativeToAnchor(ev)}
                                <span>{relativeToAnchor(ev)}</span>
                            {/if}
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}

        <div class="flex items-center justify-between gap-3 pt-1">
            <p class="text-[11px] text-surface-500">{m.admin_changes_version_gap()}</p>
            <a
                href={resolve('/admin/system/audit-log')}
                class="shrink-0 text-xs font-medium text-sky-400 hover:text-sky-300">
                {m.admin_changes_view_full_log()}
            </a>
        </div>
    {/if}
</section>
