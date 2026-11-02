<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Settings → AudiobookShelf.

  Mirrors the Jellyfin split: configuration here, content in the library
  surfaces. The connection fields come from the config schema (the store that is
  actually read); the ingest knobs come from plugin settings; sync health comes
  from the sync task's run history.
-->

<script lang="ts">
    import { AdminPageHeader, AdminSettingsPage, ActionModal } from '$lib/components/admin';
    import PluginSettingsPanel from '$lib/components/admin/PluginSettingsPanel.svelte';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { resolve } from '$lib/paths';
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    import { checkProviderHealth } from '$lib/api/admin';
    import {
        Icon,
        ExclamationTriangle,
        CheckCircle,
        LinkSlash,
        QuestionMarkCircle,
        ArrowTopRightOnSquare,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime';
    import { formatAgo } from '$lib/utils/admin/formatters';
    import type { PageData, ActionData } from './$types';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();

    /** Which revoke button is mid-submit, so only that row shows a pending state. */
    let revoking = $state<string | null>(null);

    /** userId → hidden form element, submitted programmatically once the
     * ActionModal confirmation below is accepted. Shared by the desktop table
     * row and the mobile card for the same user. */
    let formEls: Record<string, HTMLFormElement> = {};

    /** Set when a revoke is awaiting confirmation; cleared on cancel/confirm. */
    let pendingRevoke = $state<{ userId: string; username: string } | null>(null);

    function fmtDateTime(value: Date | string | null): string {
        if (!value) return '—';
        const d = value instanceof Date ? value : new Date(value);
        return Number.isNaN(d.getTime())
            ? '—'
            : new Intl.DateTimeFormat(getLocale(), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
              }).format(d);
    }

    function fmtRelative(value: Date | string | null): string | null {
        if (!value) return null;
        const d = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(d.getTime())) return null;
        return formatAgo(Math.max(0, Date.now() - d.getTime()));
    }

    function fmtDuration(ms: number | null): string {
        if (ms === null) return '—';
        if (ms < 1000) return m.admin_abs_duration_ms({ ms });
        if (ms < 60_000) return m.admin_abs_duration_s({ s: (ms / 1000).toFixed(1) });
        return m.admin_abs_duration_m_s({
            m: Math.floor(ms / 60_000),
            s: Math.round((ms % 60_000) / 1000),
        });
    }

    const RUN_STATE_LABELS: Record<string, () => string> = {
        completed: m.admin_abs_run_state_completed,
        pending: m.admin_abs_run_state_pending,
        active: m.admin_abs_run_state_active,
        cancelling: m.admin_abs_run_state_cancelling,
        failed: m.admin_abs_run_state_failed,
        cancelled: m.admin_abs_run_state_cancelled,
    };

    function fmtRunState(state: string): string {
        return (RUN_STATE_LABELS[state] ?? (() => state))();
    }

    const lastRun = $derived(data.syncRuns[0] ?? null);

    /** Most recent run that actually completed, for the connection summary's
     * "last successful sync" — `lastRun` can be a failed/in-progress run. */
    const lastSuccessfulRun = $derived(data.syncRuns.find((r) => r.state === 'completed') ?? null);

    /**
     * Whether the dismissal safety rail tripped on the last run.
     *
     * The rail reports itself as an ERROR STRING from the sweep rather than as a
     * counter, and its whole purpose is that it SUPPRESSED removals — so a
     * tripped rail looks like a clean sync (`dismissed: 0`, run `completed`)
     * unless the strings are read. An operator has to be able to see it, because
     * until they raise the cap or fix the upstream server, books that really did
     * disappear stay visible forever.
     */
    const railTripped = $derived(
        (lastRun?.counters?.errors ?? []).some((e) => /dismiss|removal|threshold|cap/i.test(e)),
    );

    const lastRunErrors = $derived(lastRun?.counters?.errors ?? []);

    // -------------------------------------------------------------------
    // Connection status summary
    // -------------------------------------------------------------------

    const audioUrl = $derived(String(data.values?.AUDIOURL ?? '').trim());

    let testState = $state<'idle' | 'loading' | 'success' | 'error'>('idle');
    let testInfo = $state('');
    // A test result belongs to the URL it ran against: a saved URL change used
    // to leave the previous server's "Connected" badge on screen.
    let testedUrl = $state('');
    $effect(() => {
        if (audioUrl !== testedUrl && testState !== 'loading') {
            testState = 'idle';
            testInfo = '';
        }
    });

    type ConnectionState = 'not-configured' | 'connected' | 'error' | 'unknown';

    const connectionState = $derived.by<ConnectionState>(() => {
        if (!audioUrl) return 'not-configured';
        if (testState === 'success') return 'connected';
        if (testState === 'error') return 'error';
        if (lastRun && lastRun.state === 'failed') return 'error';
        if (lastSuccessfulRun) return 'connected';
        return 'unknown';
    });

    async function testConnection(): Promise<void> {
        testState = 'loading';
        testInfo = '';
        testedUrl = audioUrl;
        const { data: result, error } = await checkProviderHealth('audiobookshelf');
        if (error || !result) {
            testState = 'error';
            testInfo = error || m.admin_abs_connection_error();
            return;
        }
        if (result.healthy) {
            testState = 'success';
            const info = result.serverInfo;
            const parts: string[] = [`${result.latencyMs}ms`];
            if (info?.version) parts.push(`v${String(info.version)}`);
            if (info?.serverName) parts.push(String(info.serverName));
            testInfo = parts.join(' · ');
        } else {
            testState = 'error';
            testInfo = result.error || m.admin_abs_connection_error();
        }
    }

    function requestRevoke(userId: string, username: string): void {
        pendingRevoke = { userId, username };
    }

    function confirmRevoke(): void {
        if (!pendingRevoke) return;
        formEls[pendingRevoke.userId]?.requestSubmit();
        pendingRevoke = null;
    }
</script>

<svelte:head>
    <title>AudiobookShelf - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/settings/audiobookshelf']}
        title={m.admin_abs_page_title()}
        description={m.admin_abs_page_description()} />

    <!-- Connection status. Answers "is this even reachable" before the operator
         reads sync health below — the URL and last successful sync come from
         data already on the page; the Test connection action reuses the same
         provider-health endpoint the connection field's own badge uses. -->
    <section class="card card-glass p-5">
        <header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-3">
            <h2 class="text-lg font-semibold text-white">
                {m.admin_abs_connection_status_title()}
            </h2>
            <button
                type="button"
                class="inline-flex items-center gap-1.5 self-start px-2.5 py-1 text-xs font-medium rounded-md transition-colors
                    {testState === 'loading'
                    ? 'bg-surface-600 text-surface-300 cursor-wait'
                    : testState === 'success'
                      ? 'bg-green-800/50 text-green-300 hover:bg-green-800/70'
                      : testState === 'error'
                        ? 'bg-red-800/50 text-red-300 hover:bg-red-800/70'
                        : 'bg-surface-600 text-surface-200 hover:bg-surface-500'}"
                disabled={!audioUrl || testState === 'loading'}
                onclick={testConnection}>
                {#if testState === 'loading'}
                    <span
                        class="w-3 h-3 border-2 border-surface-400 border-t-transparent rounded-full animate-spin"
                    ></span>
                    {m.admin_abs_connection_test_testing()}
                {:else if testState === 'error'}
                    <span class="w-2 h-2 rounded-full bg-red-400"></span>
                    {m.admin_abs_connection_test_retry()}
                {:else}
                    {m.admin_abs_connection_test_button()}
                {/if}
            </button>
        </header>

        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="flex flex-col gap-1.5 min-w-0">
                <span
                    class="inline-flex items-center gap-1.5 self-start rounded-md px-2 py-0.5 text-xs font-medium
                        {connectionState === 'connected'
                        ? 'bg-green-800/50 text-green-300'
                        : connectionState === 'error'
                          ? 'bg-red-800/50 text-red-300'
                          : connectionState === 'not-configured'
                            ? 'bg-surface-700 text-surface-300'
                            : 'bg-surface-700 text-surface-300'}">
                    {#if connectionState === 'connected'}
                        <Icon src={CheckCircle} class="w-3.5 h-3.5" />
                        {m.admin_abs_connection_connected()}
                    {:else if connectionState === 'error'}
                        <Icon src={ExclamationTriangle} class="w-3.5 h-3.5" />
                        {m.admin_abs_connection_error()}
                    {:else if connectionState === 'not-configured'}
                        <Icon src={LinkSlash} class="w-3.5 h-3.5" />
                        {m.admin_abs_connection_not_configured()}
                    {:else}
                        <Icon src={QuestionMarkCircle} class="w-3.5 h-3.5" />
                        {m.admin_abs_connection_unknown()}
                    {/if}
                </span>

                {#if audioUrl}
                    <p class="text-sm text-surface-300 break-all">
                        <span class="text-surface-500">{m.admin_abs_connection_url_label()}:</span>
                        {audioUrl}
                    </p>
                {:else}
                    <p class="text-sm text-surface-400">{m.admin_abs_connection_no_url()}</p>
                {/if}

                <p class="text-sm text-surface-400">
                    <span class="text-surface-500"
                        >{m.admin_abs_connection_last_success_label()}:</span>
                    {#if lastSuccessfulRun?.completedAt}
                        {fmtDateTime(lastSuccessfulRun.completedAt)}
                        {#if fmtRelative(lastSuccessfulRun.completedAt)}
                            <span class="text-surface-500"
                                >({fmtRelative(lastSuccessfulRun.completedAt)})</span>
                        {/if}
                    {:else}
                        {m.admin_abs_connection_last_success_none()}
                    {/if}
                </p>

                {#if testInfo}
                    <p
                        class="text-xs {testState === 'success'
                            ? 'text-green-400'
                            : 'text-red-400'}">
                        {testInfo}
                    </p>
                {/if}
            </div>
        </div>
    </section>

    <!-- Sync health. Second panel because "did the last sync work?" is the
         question this page exists to answer; the connection form below is only
         touched when the answer is no. -->
    <section class="card card-glass p-5">
        <header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4">
            <div>
                <h2 class="text-lg font-semibold text-white">{m.admin_abs_sync_health_title()}</h2>
                <p class="text-sm text-surface-400 mt-0.5">
                    {m.admin_abs_sync_health_subtitle({
                        count: data.libraryCount,
                        minutes: String(data.syncIntervalMinutes ?? '—'),
                    })}
                </p>
            </div>
            <a
                href={resolve('/admin/library/sources')}
                class="btn btn-sm btn-ghost self-start whitespace-nowrap">
                {m.admin_abs_manage_libraries()}
                <Icon src={ArrowTopRightOnSquare} class="w-4 h-4 ml-1" />
            </a>
        </header>

        {#if data.libraryCount === 0}
            <div class="rounded-lg border border-surface-600 bg-surface-800/50 p-4 text-sm">
                <p class="text-surface-200">{m.admin_abs_no_library_title()}</p>
                <p class="text-surface-400 mt-1">
                    {m.admin_abs_no_library_body()}
                    <a href={resolve('/admin/library/sources')} class="underline hover:text-white"
                        >{m.admin_abs_no_library_link()}</a>
                    {m.admin_abs_no_library_suffix()}
                </p>
            </div>
        {:else if !lastRun}
            <div class="rounded-lg border border-surface-600 bg-surface-800/50 p-4 text-sm">
                <p class="text-surface-200">{m.admin_abs_no_run_title()}</p>
                <p class="text-surface-400 mt-1">
                    {m.admin_abs_no_run_intro({ minutes: data.syncIntervalMinutes ?? 15 })}
                    {m.admin_abs_no_run_trigger_before()}
                    <code class="text-xs">{data.syncTaskId}</code>
                    {m.admin_abs_no_run_trigger_between()}
                    <a href={resolve('/admin/tasks')} class="underline hover:text-white"
                        >{m.admin_tasks_page()}</a
                    >{m.admin_abs_no_run_trigger_after()}
                </p>
            </div>
        {:else}
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <!-- "Not imported" rather than "Unreadable": `unmatched` means the
                     book could not be turned into a row THIS cycle (its expanded
                     fetch failed or was malformed) and stays eligible next cycle —
                     not that anything is unreadable. -->
                {#each [{ label: m.admin_abs_stat_added(), value: lastRun.counters?.added }, { label: m.admin_abs_stat_updated(), value: lastRun.counters?.updated }, { label: m.admin_abs_stat_hidden(), value: lastRun.counters?.dismissed }, { label: m.admin_abs_stat_not_imported(), value: lastRun.counters?.unmatched }] as stat (stat.label)}
                    <div class="rounded-lg bg-surface-800/60 p-3">
                        <p class="text-xs uppercase tracking-wide text-surface-500">{stat.label}</p>
                        <p class="text-xl font-semibold text-white mt-0.5">
                            {stat.value ?? '—'}
                        </p>
                    </div>
                {/each}
            </div>

            <dl class="text-sm space-y-2">
                <div class="flex flex-col sm:flex-row sm:gap-2">
                    <dt class="text-surface-500 sm:w-28 sm:shrink-0">
                        {m.admin_abs_last_sync_label()}
                    </dt>
                    <dd class="text-surface-200">
                        {fmtDateTime(lastRun.completedAt ?? lastRun.startedAt)}
                        {#if fmtRelative(lastRun.completedAt ?? lastRun.startedAt)}
                            <span class="text-surface-500"
                                >({fmtRelative(lastRun.completedAt ?? lastRun.startedAt)})</span>
                        {/if}
                        {#if !lastRun.completedAt}
                            <span class="text-amber-400">{m.admin_abs_running_suffix()}</span>
                        {/if}
                    </dd>
                </div>
                <div class="flex flex-col sm:flex-row sm:gap-2">
                    <dt class="text-surface-500 sm:w-28 sm:shrink-0">{m.admin_abs_took_label()}</dt>
                    <dd class="text-surface-200">{fmtDuration(lastRun.durationMs)}</dd>
                </div>
                <div class="flex flex-col sm:flex-row sm:gap-2">
                    <dt class="text-surface-500 sm:w-28 sm:shrink-0">
                        {m.admin_abs_result_label()}
                    </dt>
                    <dd>
                        {#if lastRun.state === 'completed'}
                            <span class="inline-flex items-center gap-1 text-green-400">
                                <Icon src={CheckCircle} class="w-4 h-4" />
                                {m.admin_abs_run_state_completed()}
                            </span>
                        {:else}
                            <span class="inline-flex items-center gap-1 text-red-400">
                                <Icon src={ExclamationTriangle} class="w-4 h-4" />
                                {fmtRunState(lastRun.state)}
                            </span>
                        {/if}
                    </dd>
                </div>
            </dl>

            {#if lastRun.counters === null && lastRun.state !== 'active'}
                <!-- No counters means the run ended without reporting them.
                     Rendering zeros here would look exactly like a clean no-op.
                     Deliberately does NOT claim the sweep itself failed: a run can
                     also end this way after the sweep returned (the task's
                     total-failure guard throws, and a thrown run stores a null
                     `result`), and asserting a cause we cannot see would send the
                     operator looking in the wrong place. -->
                <p class="mt-3 text-sm text-amber-400">
                    {m.admin_abs_no_counters_message()}
                    {#if lastRun.errorMessage}
                        <span class="block text-surface-300 mt-1">{lastRun.errorMessage}</span>
                    {:else}
                        <span class="block text-surface-300 mt-1">
                            {m.admin_abs_no_counters_check_prefix()}
                            <a
                                href={resolve('/admin/tasks/runs')}
                                class="underline hover:text-white"
                                >{m.admin_abs_tasks_runs_link()}</a>
                            {m.admin_abs_no_counters_check_suffix()}
                        </span>
                    {/if}
                </p>
            {/if}

            {#if railTripped}
                <div class="mt-4 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                    <p class="flex items-center gap-2 text-amber-200 font-medium">
                        <Icon src={ExclamationTriangle} class="w-4 h-4" />
                        {m.admin_abs_rail_tripped_title()}
                    </p>
                    <p class="text-surface-300 mt-1">
                        {m.admin_abs_rail_tripped_body({ percent: data.dismissalPercent ?? '—' })}
                    </p>
                </div>
            {/if}

            {#if lastRunErrors.length > 0}
                <details class="mt-4">
                    <summary class="text-sm text-surface-400 cursor-pointer hover:text-white">
                        {m.admin_abs_warnings_summary({ count: lastRunErrors.length })}
                    </summary>
                    <ul class="mt-2 space-y-1 text-xs text-surface-400 font-mono">
                        {#each lastRunErrors as err, i (i)}
                            <li class="break-words">{err}</li>
                        {/each}
                    </ul>
                </details>
            {/if}
        {/if}
    </section>

    <!-- Per-user credentials. Each linked user has a distinct API key minted on
         the AudiobookShelf server under their own account — that is what makes
         per-user progress sync possible, and it is also a live credential that
         an operator must be able to withdraw. -->
    <section class="card card-glass p-5">
        <header class="mb-4">
            <h2 class="text-lg font-semibold text-white">{m.admin_abs_listeners_title()}</h2>
            <p class="text-sm text-surface-400 mt-0.5">
                {m.admin_abs_listeners_description()}
            </p>
        </header>

        {#if form?.revokeError}
            <p class="mb-3 text-sm text-red-400">{form.revokeError}</p>
        {:else if form?.revoked}
            <p class="mb-3 text-sm text-green-400">{m.admin_abs_revoke_success()}</p>
        {/if}

        {#if data.linkedUsers.length === 0}
            <p class="text-sm text-surface-400">
                {m.admin_abs_listeners_empty()}
            </p>
        {:else}
            <!-- One hidden form per user, submitted programmatically once the
                 confirm modal below is accepted. Shared by both the desktop table
                 row and the mobile card for the same user. -->
            {#each data.linkedUsers as user (user.userId)}
                <form
                    method="POST"
                    action="?/revoke"
                    class="hidden"
                    bind:this={formEls[user.userId]}
                    use:enhance={() => {
                        revoking = user.userId;
                        return async ({ update }) => {
                            await update();
                            revoking = null;
                        };
                    }}>
                    <input type="hidden" name="userId" value={user.userId} />
                </form>
            {/each}

            <!-- Desktop/tablet: table. -->
            <div class="hidden sm:block overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="text-left text-xs uppercase tracking-wide text-surface-500">
                            <th class="pb-2 pr-4">{m.admin_abs_col_user()}</th>
                            <th class="pb-2 pr-4">{m.admin_abs_col_linked()}</th>
                            <!-- "Last used" is deliberately NOT a column.
                                 `plugin_user_credentials.last_accessed_at` is only
                                 written by the audited secret getters; the connector
                                 reads keys through `getUserRaw`, which skips the
                                 audit on purpose because it runs in a per-cycle loop
                                 over every linked user (see the rationale in
                                 `tasks/secrets.ts`). So the column read "—" for
                                 every listener no matter how much they listened,
                                 which states something false — that the key is
                                 unused — rather than "we do not track this". -->
                            <th class="pb-2"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each data.linkedUsers as user (user.userId)}
                            <tr class="border-t border-surface-700/60">
                                <td class="py-2 pr-4">
                                    <span class="text-surface-100">{user.username}</span>
                                    {#if user.jellyfinUsername && user.jellyfinUsername !== user.username}
                                        <span class="text-xs text-surface-500 block"
                                            >{m.admin_abs_matches_user({
                                                username: user.jellyfinUsername,
                                            })}</span>
                                    {/if}
                                    {#if !user.revocable}
                                        <!-- Without the upstream key id, unlink can only drop
                                             the local row; the key stays live upstream. Say so
                                             before the click, not in a log afterwards. -->
                                        <span class="text-xs text-amber-400 block">
                                            {m.admin_abs_key_not_stored()}
                                        </span>
                                    {/if}
                                </td>
                                <td class="py-2 pr-4 text-surface-300"
                                    >{fmtDateTime(user.mintedAt)}</td>
                                <td class="py-2 text-right">
                                    <button
                                        type="button"
                                        class="btn btn-sm btn-ghost text-red-400 hover:text-red-300"
                                        disabled={revoking === user.userId}
                                        onclick={() => requestRevoke(user.userId, user.username)}>
                                        {revoking === user.userId
                                            ? m.admin_abs_revoking()
                                            : m.admin_abs_revoke_button()}
                                    </button>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>

            <!-- Phones: stacked cards instead of a squeezed table. -->
            <ul class="sm:hidden space-y-3">
                {#each data.linkedUsers as user (user.userId)}
                    <li class="rounded-lg border border-surface-700/60 bg-surface-800/40 p-3">
                        <p class="text-surface-100 font-medium break-words">{user.username}</p>
                        {#if user.jellyfinUsername && user.jellyfinUsername !== user.username}
                            <p class="text-xs text-surface-500 mt-0.5">
                                {m.admin_abs_matches_user({ username: user.jellyfinUsername })}
                            </p>
                        {/if}
                        {#if !user.revocable}
                            <p class="text-xs text-amber-400 mt-1">
                                {m.admin_abs_key_not_stored()}
                            </p>
                        {/if}
                        <p class="text-xs text-surface-400 mt-2">
                            {m.admin_abs_col_linked()}: {fmtDateTime(user.mintedAt)}
                        </p>
                        <div class="mt-3">
                            <button
                                type="button"
                                class="btn btn-sm btn-ghost text-red-400 hover:text-red-300"
                                disabled={revoking === user.userId}
                                onclick={() => requestRevoke(user.userId, user.username)}>
                                {revoking === user.userId
                                    ? m.admin_abs_revoking()
                                    : m.admin_abs_revoke_button()}
                            </button>
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}
    </section>

    <!-- Ingest knobs. Separate from the connection block below because they live
         in a different STORE: these persist to `plugin_settings` (which the sweep
         and the scheduler read), while the connection lives in the config system.
         Saving invalidates the page load so the header's "syncing every N minutes"
         and the dismissal percentage reflect the new values immediately rather
         than showing stale numbers next to a success toast. -->
    <PluginSettingsPanel
        pluginId="audiobookshelf-media-source"
        heading={m.admin_abs_ingest_heading()}
        description={m.admin_abs_ingest_description()}
        onSaved={() => void invalidateAll()} />

    <!-- Connection, rendered by the generic settings surface. Includes the
         reachability badge via the AUDIOURL `healthCheckProvider` uiHint. -->
    <AdminSettingsPage
        {data}
        {form}
        icon={adminPageIcons['/admin/settings/audiobookshelf']}
        heading={m.admin_abs_connection_heading()}
        description={m.admin_abs_connection_description()} />
</div>

{#if pendingRevoke}
    <ActionModal
        title={m.admin_abs_confirm_revoke_title()}
        confirmText={m.admin_abs_confirm_revoke_confirm()}
        confirmColor="red"
        onclose={() => (pendingRevoke = null)}
        onconfirm={confirmRevoke}>
        <p class="text-sm text-surface-300">
            {m.admin_abs_confirm_revoke_body({ username: pendingRevoke.username })}
        </p>
    </ActionModal>
{/if}
