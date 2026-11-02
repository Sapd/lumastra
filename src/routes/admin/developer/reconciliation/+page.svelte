<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Developer → Reconciliation log — ex-media-browser "Quarantine" tab,
  ported verbatim as its own Developer-only page (admin IA redesign, spec
  §3.7). No operator badge anywhere links here; it's a raw diagnostic feed
  for developers, not an operator queue.
-->
<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { Icon, ExclamationTriangle, ArchiveBox, CheckCircle } from 'svelte-hero-icons';
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { resolve } from '$lib/paths';
    import { getQuarantineEntries, resolveQuarantineEntry } from '$lib/api/admin';
    import type { QuarantineResponse, QuarantineEntry } from '$lib/schemas/api-admin-responses';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import { toasts } from '$lib/stores/toast.store';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages.js';

    const QUARANTINE_LIST_LIMIT = 200;
    type QuarantineResolution = 'reattached' | 'dismissed' | 'recreated';

    function quarantineVerbLabel(verb: QuarantineResolution): string {
        return verb === 'reattached'
            ? m.media_quarantine_reattached()
            : verb === 'dismissed'
              ? m.media_quarantine_dismissed()
              : m.media_quarantine_recreated();
    }

    function quarantineFormatDate(d: string | Date | null | undefined): string {
        if (!d) return '—';
        return new Date(d).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    let quarantineData = $state<QuarantineResponse | null>(null);
    let quarantineLoading = $state(false);
    let quarantineLoadAttempted = $state(false);
    let quarantineLoadError = $state(false);
    let quarantineResolveTarget = $state<QuarantineEntry | null>(null);
    let quarantineResolveVerb = $state<QuarantineResolution | ''>('');
    let quarantineResolving = $state(false);
    let quarantineResolveTriggerEl = $state<HTMLButtonElement | undefined>(undefined);
    let quarantineDialogFirstEl = $state<HTMLButtonElement | undefined>(undefined);

    onMount(() => {
        void loadQuarantineEntries();
    });

    async function loadQuarantineEntries(): Promise<void> {
        if (quarantineLoading) return;
        quarantineLoading = true;
        quarantineLoadError = false;
        try {
            const result = await getQuarantineEntries({ limit: QUARANTINE_LIST_LIMIT });
            if (result.data) {
                quarantineData = result.data;
            } else {
                // Distinguish "fetch failed" (result.error set, data still
                // possibly stale) from "no data yet" by tracking it explicitly
                // as a load error rather than letting the {#each quarantineData.items} throw.
                quarantineLoadError = true;
                toasts.error(getErrorMessage(result.error, m.admin_media_err_load_quarantine()));
            }
        } finally {
            quarantineLoading = false;
            quarantineLoadAttempted = true;
        }
    }

    function removeQuarantineEntryLocally(id: string): void {
        if (!quarantineData) return;
        const items = quarantineData.items.filter((e) => e.id !== id);
        const nextUnresolved = Math.max(0, quarantineData.counts.unresolved - 1);
        quarantineData = {
            ...quarantineData,
            items,
            counts: { ...quarantineData.counts, unresolved: nextUnresolved },
        };
    }

    async function handleQuarantineResolve(): Promise<void> {
        if (!quarantineResolveTarget || !quarantineResolveVerb) return;
        const targetId = quarantineResolveTarget.id;
        quarantineResolving = true;
        try {
            const result = await resolveQuarantineEntry(targetId, quarantineResolveVerb);
            if (!result.error) {
                toasts.success(
                    m.media_toast_entry_resolved({
                        verb: quarantineVerbLabel(quarantineResolveVerb),
                    }),
                );
                quarantineResolveTarget = null;
                quarantineResolveVerb = '';
                // Restore focus to the row's resolve button before clearing the
                // ref, so keyboard focus doesn't silently fall to <body>.
                quarantineResolveTriggerEl?.focus();
                quarantineResolveTriggerEl = undefined;
                // Optimistically remove, then reconcile against the server. The
                // reload may resurrect a row if the source re-synced the payload
                // — that is the authoritative state.
                removeQuarantineEntryLocally(targetId);
                await loadQuarantineEntries();
            } else if (result.status === 404) {
                // Another admin already resolved this entry (atomic UPDATE …
                // WHERE resolved_at IS NULL → 404). Close the now-phantom dialog
                // and reload so the stale row disappears from the table.
                toasts.error(getErrorMessage(result.error, m.admin_media_err_resolve_entry()));
                quarantineResolveTarget = null;
                quarantineResolveVerb = '';
                quarantineResolveTriggerEl?.focus();
                quarantineResolveTriggerEl = undefined;
                removeQuarantineEntryLocally(targetId);
                await loadQuarantineEntries();
            } else {
                toasts.error(getErrorMessage(result.error, m.admin_media_err_resolve_entry()));
            }
        } finally {
            quarantineResolving = false;
        }
    }

    function openQuarantineResolve(entry: QuarantineEntry, trigger?: HTMLButtonElement): void {
        quarantineResolveTriggerEl = trigger;
        quarantineResolveTarget = entry;
        quarantineResolveVerb = '';
        tick().then(() => {
            quarantineDialogFirstEl?.focus();
        });
    }

    function closeQuarantineResolve(): void {
        if (quarantineResolving) return;
        quarantineResolveTarget = null;
        quarantineResolveVerb = '';
        quarantineResolveTriggerEl?.focus();
        quarantineResolveTriggerEl = undefined;
    }

    function handleQuarantineDialogKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            closeQuarantineResolve();
        }
    }
</script>

<svelte:head>
    <title>{m.admin_nav_page_developer_reconciliation()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/developer/reconciliation']}
        title={m.admin_nav_page_developer_reconciliation()}
        description={m.admin_nav_desc_developer_reconciliation()} />

    {#if quarantineLoading && !quarantineData}
        <p class="text-sm text-surface-500 py-8 text-center">
            {m.media_loading_quarantine()}
        </p>
    {:else if quarantineLoadError && !quarantineData}
        <!-- Persistent load failure: the auto-load doesn't retry on its own,
             so surface an explicit Retry control. -->
        <div class="flex flex-col items-center gap-3 py-16 text-center">
            <Icon src={ExclamationTriangle} class="w-10 h-10 text-orange-400" />
            <p class="text-surface-300 font-medium">
                {m.admin_media_err_load_quarantine()}
            </p>
            <button
                type="button"
                class="px-3 py-1.5 text-sm rounded-lg bg-surface-700 hover:bg-surface-600 text-surface-300 transition-colors disabled:opacity-50"
                disabled={quarantineLoading}
                onclick={() => void loadQuarantineEntries()}>
                {m.btn_retry()}
            </button>
        </div>
    {:else if quarantineData}
        <!-- Summary -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div
                class="flex flex-col items-center justify-center p-4 rounded-xl border bg-surface-800/50 border-{quarantineData
                    .counts.unresolved > 0
                    ? 'orange'
                    : 'cyan'}-500/30">
                <Icon
                    src={ArchiveBox}
                    class="w-6 h-6 mb-1 text-{quarantineData.counts.unresolved > 0
                        ? 'orange'
                        : 'cyan'}-400" />
                <span
                    class="text-2xl font-bold text-{quarantineData.counts.unresolved > 0
                        ? 'orange'
                        : 'cyan'}-400">{quarantineData.counts.unresolved}</span>
                <span class="text-xs text-surface-400 mt-0.5">{m.media_status_unresolved()}</span>
            </div>
        </div>

        {#if quarantineLoadError}
            <!-- A reload failed after data was already shown. quarantineData is
                 still populated so the page falls into this branch and the
                 dedicated error state above never renders — surface a banner so
                 the failure isn't silently swallowed and the shown data isn't
                 mistaken for fresh. -->
            <div
                role="alert"
                class="flex items-center gap-2 px-3 py-2 rounded-lg border border-orange-500/40 bg-orange-500/10 text-sm text-orange-300">
                <Icon src={ExclamationTriangle} class="w-4 h-4 shrink-0" />
                <span>{m.admin_media_err_reload_quarantine_stale()}</span>
            </div>
        {/if}

        <div class="flex items-center gap-3">
            <button
                type="button"
                class="px-3 py-1.5 text-sm rounded-lg bg-surface-700 hover:bg-surface-600 text-surface-300 transition-colors disabled:opacity-50"
                disabled={quarantineLoading}
                onclick={() => void loadQuarantineEntries()}>
                {m.media_button_refresh()}
            </button>
        </div>

        {#if quarantineData.items.length === 0}
            <div class="flex flex-col items-center gap-3 py-16 text-center">
                <Icon src={CheckCircle} class="w-12 h-12 text-green-400" />
                <p class="text-surface-300 font-medium">
                    {m.media_no_unresolved_quarantine()}
                </p>
                <p class="text-surface-500 text-sm">
                    {m.media_all_payloads_triaged()}
                </p>
            </div>
        {:else}
            <div class="overflow-x-auto rounded-xl border border-surface-700">
                <table class="w-full text-sm">
                    <thead class="bg-surface-800/60">
                        <tr>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.media_label_provider_external()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.media_col_type()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.media_label_parent_tmdb()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.media_label_expected_series()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.media_label_reason()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.media_label_source()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.media_label_created()}</th>
                            <th class="px-4 py-3 text-right"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each quarantineData.items as entry (entry.id)}
                            <tr class="border-t border-surface-700/50 hover:bg-surface-800/30">
                                <td
                                    class="px-4 py-2.5 font-mono text-xs text-surface-300 max-w-[180px] truncate"
                                    title="{entry.provider}:{entry.externalId}">
                                    {entry.provider}:{entry.externalId}
                                </td>
                                <td class="px-4 py-2.5 text-xs text-surface-400">
                                    {entry.mediaType}
                                </td>
                                <td class="px-4 py-2.5 font-mono text-xs text-surface-400">
                                    {entry.parentTmdbId ?? '—'}
                                </td>
                                <td
                                    class="px-4 py-2.5 font-mono text-xs text-surface-400 max-w-[140px] truncate">
                                    {#if entry.expectedSeriesId}
                                        <a
                                            href="{resolve('/')}?modal={entry.expectedSeriesId}"
                                            class="hover:text-yellow-400 underline underline-offset-2"
                                            title={entry.expectedSeriesId}>
                                            {entry.expectedSeriesId.slice(0, 8)}…
                                        </a>
                                    {:else}
                                        <span class="text-surface-600">—</span>
                                    {/if}
                                </td>
                                <td
                                    class="px-4 py-2.5 text-surface-400 text-xs max-w-[220px] truncate"
                                    title={entry.reason}>
                                    {entry.reason}
                                </td>
                                <td
                                    class="px-4 py-2.5 font-mono text-xs text-surface-500 max-w-[120px] truncate"
                                    title={entry.source}>
                                    {entry.source}
                                </td>
                                <td class="px-4 py-2.5 text-surface-500 text-xs whitespace-nowrap">
                                    {quarantineFormatDate(entry.createdAt)}
                                </td>
                                <td class="px-4 py-2.5 text-right">
                                    <button
                                        type="button"
                                        class="px-2.5 py-1 text-xs rounded-lg bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/20 transition-colors"
                                        onclick={(e) =>
                                            openQuarantineResolve(
                                                entry,
                                                e.currentTarget as HTMLButtonElement,
                                            )}>
                                        {m.admin_media_resolve()}
                                    </button>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
            <p class="text-xs text-surface-600">
                {m.media_quarantine_showing_entries({
                    count: quarantineData.items.length,
                })}
            </p>
            {#if quarantineData.counts.unresolved > quarantineData.items.length || quarantineData.items.length >= QUARANTINE_LIST_LIMIT}
                <!-- Honest count: the summary badge counts the whole table but
                     the list below is capped, so flag the hidden remainder. -->
                <p class="text-xs text-amber-400">
                    {m.admin_ops_reidentify_showing({
                        start: 1,
                        end: quarantineData.items.length,
                        total: quarantineData.counts.unresolved,
                    })}
                    · {m.audit_truncated_warning({ limit: QUARANTINE_LIST_LIMIT })}
                </p>
            {/if}
        {/if}
    {:else}
        <div class="text-center py-8 text-surface-500 text-sm">
            {m.media_failed_load_quarantine()}
        </div>
    {/if}
</div>

<!-- Quarantine resolve dialog -->
{#if quarantineResolveTarget}
    <div
        class="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        style="z-index: {Z.MODAL}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quarantine-dialog-title"
        tabindex="-1"
        onclick={(e) => {
            if (e.target === e.currentTarget) closeQuarantineResolve();
        }}
        onkeydown={handleQuarantineDialogKeydown}>
        <div
            role="document"
            class="bg-surface-900 border border-surface-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 space-y-4">
            <div class="flex items-start justify-between">
                <h2 id="quarantine-dialog-title" class="text-lg font-semibold">
                    {m.media_resolve_quarantine()}
                </h2>
                <button
                    bind:this={quarantineDialogFirstEl}
                    type="button"
                    class="text-surface-500 hover:text-surface-300 text-xl leading-none disabled:opacity-50"
                    aria-label={m.btn_close()}
                    disabled={quarantineResolving}
                    onclick={closeQuarantineResolve}>
                    ×
                </button>
            </div>

            <div class="space-y-1 text-sm">
                <div class="flex items-center gap-2">
                    <span class="text-surface-500">{m.media_label_id_colon()}</span>
                    <span class="font-mono text-xs text-surface-300"
                        >{quarantineResolveTarget.provider}:{quarantineResolveTarget.externalId}</span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-surface-500">{m.media_label_reason_colon()}</span>
                    <span class="text-surface-400 text-xs">{quarantineResolveTarget.reason}</span>
                </div>
            </div>

            <div class="space-y-1.5">
                <label class="block text-sm text-surface-400" for="quarantine-resolve-verb">
                    {m.admin_media_resolution_label()}
                    <span class="text-red-400">*</span>
                </label>
                <select
                    id="quarantine-resolve-verb"
                    class="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-sm text-surface-200 focus:outline-none focus:border-yellow-500"
                    bind:value={quarantineResolveVerb}>
                    <option value="">{m.media_quarantine_select_resolution()}</option>
                    <option value="reattached">{m.media_quarantine_reattached()}</option>
                    <option value="dismissed">{m.media_quarantine_dismissed()}</option>
                    <option value="recreated">{m.media_quarantine_recreated()}</option>
                </select>
                {#if quarantineResolveVerb === 'recreated'}
                    <!-- Destructive-implication warning for the "recreated" verb:
                         it is a record-keeping label, not an automated action,
                         and marks the entry permanently resolved. -->
                    <p
                        class="flex items-start gap-1.5 text-xs text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded-lg px-2.5 py-2">
                        <Icon
                            src={ExclamationTriangle}
                            class="w-3.5 h-3.5 mt-0.5 shrink-0"
                            aria-hidden="true" />
                        <span>{m.media_quarantine_recreated()}</span>
                    </p>
                {/if}
            </div>

            <div class="flex justify-end gap-3 pt-2">
                <button
                    type="button"
                    class="px-4 py-2 text-sm rounded-lg bg-surface-700 hover:bg-surface-600 text-surface-300 transition-colors"
                    onclick={closeQuarantineResolve}
                    disabled={quarantineResolving}>
                    {m.btn_cancel()}
                </button>
                <button
                    type="button"
                    class="px-4 py-2 text-sm rounded-lg bg-yellow-500 hover:bg-yellow-400 text-surface-900 font-medium transition-colors disabled:opacity-50"
                    onclick={handleQuarantineResolve}
                    disabled={quarantineResolving || !quarantineResolveVerb}>
                    {quarantineResolving
                        ? m.admin_media_resolving()
                        : m.admin_media_confirm_resolve()}
                </button>
            </div>
        </div>
    </div>
{/if}
