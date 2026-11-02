<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { getAdminAuditFeed, getAdminAuditActors } from '$lib/api/admin.js';
    import type {
        AdminAuditFeedResponse,
        AdminAuditEventRow,
    } from '$lib/schemas/admin-audit.schema.js';
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { formatAuditAction } from './audit-action-label.js';

    import { appPath } from '$lib/shared/api-urls';

    const PAGE_LIMIT = 50;
    const EXPORT_BASE = appPath('/api/admin/admin-audit?format=csv');

    // Well-known action prefixes that map to human labels
    const ACTION_GROUPS = [
        { prefix: 'user.*', label: m.admin_audit_group_users },
        { prefix: 'task.*', label: m.admin_audit_group_tasks },
        { prefix: 'queue.*', label: m.admin_audit_group_queue },
        { prefix: 'run.*', label: m.admin_audit_group_runs },
        { prefix: 'secret.*', label: m.admin_audit_group_secrets },
        { prefix: 'cache.*', label: m.admin_audit_group_cache },
        { prefix: 'pat.*', label: m.admin_audit_group_pats },
        { prefix: 'service_token.*', label: m.admin_audit_group_service_tokens },
        { prefix: 'plugin.*', label: m.admin_audit_group_plugins },
        { prefix: 'settings.*', label: m.admin_audit_group_settings },
        { prefix: 'licensing.*', label: m.admin_audit_group_licensing },
        { prefix: 'navigation.*', label: m.admin_audit_group_navigation },
        { prefix: 'library_group.*', label: m.admin_audit_group_libraries },
        { prefix: 'play_session.*', label: m.admin_audit_group_play_sessions },
    ] as const;

    const OUTCOME_LABELS: Record<string, () => string> = {
        ok: m.admin_audit_outcome_ok,
        error: m.admin_audit_outcome_error,
        denied: m.admin_audit_outcome_denied,
    };

    let events = $state<AdminAuditEventRow[]>([]);
    /** Cursor for the next page; undefined when there are no more rows. */
    let nextCursor = $state<string | undefined>(undefined);
    let loading = $state(true);
    let loadingMore = $state(false);
    let loadError = $state<string | null>(null);

    let requestVersion = 0;
    onDestroy(() => {
        requestVersion++;
    });

    // Filters
    const selectedActors = new SvelteSet<string>();
    const selectedActionGroups = new SvelteSet<string>();
    // Raw value from the datetime-local input (e.g. '2026-06-22T14:30', no tz).
    let sinceInputValue = $state('');
    const expanded = new SvelteSet<number>();

    // Known actors — populated via a distinct-actors query on mount so that
    // rarely-active admins appear in the filter list from the start, not only
    // after their events scroll into view.
    let knownActors = $state<string[]>([]);

    /**
     * Convert a datetime-local string (e.g. '2026-06-22T14:30', browser-local
     * time, no tz suffix) to a UTC ISO 8601 string. Node.js parses strings
     * without a timezone as UTC, but browsers treat them as local time — so we
     * must pin the interpretation by constructing a Date from the local string
     * and then calling toISOString() which always emits UTC.
     *
     * Returns undefined if the string is empty or invalid.
     */
    function localDatetimeToUtcIso(raw: string): string | undefined {
        if (!raw) return undefined;
        const d = new Date(raw); // browser interprets bare string as local time
        if (Number.isNaN(d.getTime())) return undefined;
        return d.toISOString(); // always UTC, e.g. '2026-06-22T12:30:00.000Z'
    }

    function buildExportUrl(): string {
        const pairs: [string, string][] = [];
        for (const a of selectedActors) pairs.push(['actor', a]);
        for (const g of selectedActionGroups) pairs.push(['action', g]);
        const sinceUtc = localDatetimeToUtcIso(sinceInputValue);
        if (sinceUtc) pairs.push(['since', sinceUtc]);
        const qs = new URLSearchParams(pairs).toString();
        return EXPORT_BASE + (qs ? '&' + qs : '');
    }

    // A plain <a download> never showed the X-Truncated header, so a cut-off
    // compliance export looked complete. Fetch it, warn when it was cut, then
    // hand the file to the browser.
    let exporting = $state(false);
    async function exportCsv(): Promise<void> {
        if (exporting) return;
        exporting = true;
        try {
            const res = await fetch(buildExportUrl(), { credentials: 'same-origin' });
            if (!res.ok) {
                toasts.error(m.admin_audit_export_failed());
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `admin-audit-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            if (res.headers.get('X-Truncated') === 'true') {
                toasts.warning(m.admin_audit_export_truncated());
            }
        } catch {
            toasts.error(m.admin_audit_export_failed());
        } finally {
            exporting = false;
        }
    }

    async function fetchPage(
        version: number,
        cursor?: string,
    ): Promise<AdminAuditFeedResponse | null> {
        const actors = [...selectedActors];
        const actions = [...selectedActionGroups];
        const sinceUtc = localDatetimeToUtcIso(sinceInputValue);
        const { data, error } = await getAdminAuditFeed({
            actors: actors.length > 0 ? actors : undefined,
            actions: actions.length > 0 ? actions : undefined,
            since: sinceUtc,
            cursor,
            limit: PAGE_LIMIT,
        });
        if (version !== requestVersion) return null;
        if (error || !data) {
            loadError = error ?? m.admin_audit_load_error();
            return null;
        }
        loadError = null;
        return data;
    }

    /** Fetch distinct actors from the server for the filter chip bar. */
    async function fetchActors(): Promise<void> {
        const { data } = await getAdminAuditActors();
        if (data?.actors) {
            knownActors = data.actors;
        }
    }

    async function reload(): Promise<void> {
        const version = ++requestVersion;
        loading = true;
        loadingMore = false;
        nextCursor = undefined;
        const resp = await fetchPage(version);
        if (version !== requestVersion) return;
        if (resp) {
            events = resp.items;
            nextCursor = resp.page.nextCursor;
        }
        loading = false;
    }

    async function loadMore(): Promise<void> {
        if (!nextCursor || loadingMore || loading) return;
        const version = requestVersion;
        loadingMore = true;
        const resp = await fetchPage(version, nextCursor);
        if (version !== requestVersion) return;
        if (resp) {
            events = [...events, ...resp.items];
            nextCursor = resp.page.nextCursor;
        }
        loadingMore = false;
    }

    function toggleActor(actor: string): void {
        if (selectedActors.has(actor)) selectedActors.delete(actor);
        else selectedActors.add(actor);
        void reload();
    }

    function toggleActionGroup(group: string): void {
        if (selectedActionGroups.has(group)) selectedActionGroups.delete(group);
        else selectedActionGroups.add(group);
        void reload();
    }

    function toggleExpanded(id: number): void {
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
    }

    function outcomeDotClass(outcome: string): string {
        if (outcome === 'error') return 'bg-red-400';
        if (outcome === 'denied') return 'bg-amber-400';
        return 'bg-emerald-400';
    }

    function formatTime(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    function setRelativeSince(hours: number): void {
        const date = new Date(Date.now() - hours * 60 * 60 * 1000);
        const pad = (value: number) => String(value).padStart(2, '0');
        sinceInputValue = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
        void reload();
    }

    function hasDetail(detail: Record<string, unknown>): boolean {
        return detail != null && Object.keys(detail).length > 0;
    }

    function handleSinceChange(e: Event): void {
        sinceInputValue = (e.target as HTMLInputElement).value;
        void reload();
    }

    onMount(() => {
        // Fetch actors and first event page in parallel.
        void fetchActors();
        void reload();
    });
</script>

<section
    class="rounded-lg border border-surface-700 bg-surface-900/40 p-4"
    aria-label={m.admin_audit_aria_label()}>
    <!-- Filters -->
    <div class="mb-3 space-y-2">
        <!-- Actor filter — populated from seen actors -->
        {#if knownActors.length > 0}
            <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-[11px] text-surface-400">{m.admin_audit_actor_label()}</span>
                {#each knownActors as actor (actor)}
                    <button
                        type="button"
                        aria-pressed={selectedActors.has(actor)}
                        class="inline-flex min-h-9 items-center rounded px-2.5 py-1 text-xs transition-colors sm:min-h-0 sm:px-2 sm:py-0.5 sm:text-[11px] {selectedActors.has(
                            actor,
                        )
                            ? 'bg-cyan-700 text-white'
                            : 'bg-surface-700 text-surface-400 hover:bg-surface-600'}"
                        onclick={() => toggleActor(actor)}>
                        {actor}
                    </button>
                {/each}
            </div>
        {/if}

        <!-- Action group filter -->
        <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[11px] text-surface-400">{m.admin_audit_action_label()}</span>
            {#each ACTION_GROUPS as group (group.prefix)}
                <button
                    type="button"
                    aria-pressed={selectedActionGroups.has(group.prefix)}
                    class="inline-flex min-h-9 items-center rounded px-2.5 py-1 text-xs transition-colors sm:min-h-0 sm:px-2 sm:py-0.5 sm:text-[11px] {selectedActionGroups.has(
                        group.prefix,
                    )
                        ? 'bg-cyan-700 text-white'
                        : 'bg-surface-700 text-surface-400 hover:bg-surface-600'}"
                    onclick={() => toggleActionGroup(group.prefix)}>
                    {group.label()}
                </button>
            {/each}
        </div>

        <!-- Date range picker -->
        <div class="flex flex-wrap items-center gap-2">
            <span class="text-[11px] text-surface-400">{m.admin_audit_since_label()}</span>
            <div
                class="flex items-center gap-1"
                role="group"
                aria-label={m.admin_audit_quick_range_label()}>
                <button
                    type="button"
                    class="inline-flex min-h-9 items-center rounded border border-surface-700 px-2.5 py-1 text-xs text-surface-400 sm:min-h-0 sm:px-2 sm:py-0.5 sm:text-[11px] hover:bg-surface-800 hover:text-surface-200"
                    onclick={() => setRelativeSince(24)}>24h</button>
                <button
                    type="button"
                    class="inline-flex min-h-9 items-center rounded border border-surface-700 px-2.5 py-1 text-xs text-surface-400 sm:min-h-0 sm:px-2 sm:py-0.5 sm:text-[11px] hover:bg-surface-800 hover:text-surface-200"
                    onclick={() => setRelativeSince(24 * 7)}>7d</button>
                <button
                    type="button"
                    class="inline-flex min-h-9 items-center rounded border border-surface-700 px-2.5 py-1 text-xs text-surface-400 sm:min-h-0 sm:px-2 sm:py-0.5 sm:text-[11px] hover:bg-surface-800 hover:text-surface-200"
                    onclick={() => setRelativeSince(24 * 30)}>30d</button>
            </div>
            <input
                type="datetime-local"
                value={sinceInputValue}
                oninput={handleSinceChange}
                title={m.admin_audit_since_tooltip()}
                class="min-h-9 rounded border border-surface-600 bg-surface-800 px-2 py-1 text-xs text-surface-300 sm:min-h-0 sm:py-0.5 sm:text-[11px] focus:outline-none focus:ring-1 focus:ring-cyan-600" />
            {#if sinceInputValue}
                <button
                    type="button"
                    class="min-h-9 px-1 text-xs text-surface-500 hover:text-surface-300 sm:min-h-0 sm:text-[11px]"
                    onclick={() => {
                        sinceInputValue = '';
                        void reload();
                    }}>
                    {m.admin_audit_clear()}
                </button>
            {/if}
        </div>
    </div>

    {#if loading}
        <p class="py-6 text-center text-sm text-surface-400">{m.admin_audit_loading()}</p>
    {:else if loadError}
        <div
            class="flex flex-col items-start gap-2 rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            <span>{loadError}</span>
            <button
                type="button"
                class="rounded border border-red-700/60 bg-red-900/40 px-2.5 py-1 text-xs text-red-100 transition-colors hover:bg-red-900/70"
                onclick={() => void reload()}>
                {m.admin_audit_retry()}
            </button>
        </div>
    {:else if events.length === 0}
        <div
            class="rounded border border-surface-700/40 bg-surface-900/30 py-6 text-center text-sm text-surface-400">
            {m.admin_audit_no_entries()}
        </div>
    {:else}
        <ul class="divide-y divide-surface-800">
            {#each events as ev (ev.id)}
                <li class="py-2">
                    <div class="flex items-start gap-2">
                        <span
                            class="mt-1.5 h-2 w-2 shrink-0 rounded-full {outcomeDotClass(
                                ev.outcome,
                            )}"
                            title={OUTCOME_LABELS[ev.outcome]?.() ?? ev.outcome}></span>
                        <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-2">
                                <span class="text-[11px] tabular-nums text-surface-500">
                                    {formatTime(ev.ts)}
                                </span>
                                <span
                                    class="rounded bg-surface-700 px-1.5 py-0.5 text-[10px] text-surface-300">
                                    {ev.actor}
                                </span>
                                {#if ev.principalKind}
                                    <span
                                        class="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-surface-500"
                                        title={ev.credentialId
                                            ? `${ev.principalKind}:${ev.credentialId}`
                                            : ev.principalKind}>
                                        {ev.principalKind}
                                    </span>
                                {/if}
                                <span class="text-sm text-surface-200" title={ev.action}>
                                    {formatAuditAction(ev.action)}
                                </span>
                                <span class="text-sm text-surface-400" title={ev.target}
                                    >→ {ev.target}</span>
                            </div>
                            {#if hasDetail(ev.detail)}
                                <button
                                    type="button"
                                    class="mt-1 min-h-9 text-xs text-cyan-400 hover:text-cyan-300 sm:min-h-0 sm:text-[11px]"
                                    onclick={() => toggleExpanded(ev.id)}>
                                    {expanded.has(ev.id)
                                        ? m.admin_audit_hide_detail()
                                        : m.admin_audit_show_detail()}
                                </button>
                                {#if expanded.has(ev.id)}
                                    <pre
                                        class="mt-1 max-h-64 overflow-auto rounded bg-surface-950/60 p-2 text-[11px] text-surface-300">{JSON.stringify(
                                            ev.detail,
                                            null,
                                            2,
                                        )}</pre>
                                {/if}
                            {/if}
                        </div>
                    </div>
                </li>
            {/each}
        </ul>

        {#if nextCursor}
            <div class="mt-3 text-center">
                <button
                    type="button"
                    class="rounded border border-surface-600 bg-surface-800 px-4 py-1.5 text-xs text-surface-300 transition-colors hover:bg-surface-700 disabled:opacity-50"
                    onclick={loadMore}
                    disabled={loadingMore}>
                    {loadingMore ? m.admin_audit_loading_more() : m.admin_audit_load_more()}
                </button>
            </div>
        {/if}
    {/if}

    <!-- Export CSV button (always visible) -->
    <div class="mt-4 flex justify-end">
        <button
            type="button"
            onclick={() => void exportCsv()}
            disabled={exporting}
            class="rounded border border-surface-600 bg-surface-800 px-3 py-1.5 text-xs text-surface-300 transition-colors hover:bg-surface-700 disabled:opacity-50">
            {m.admin_audit_export_csv()}
        </button>
    </div>
</section>
