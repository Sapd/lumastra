<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { page } from '$app/stores';
    import { afterNavigate } from '$app/navigation';
    import * as m from '$lib/paraglide/messages';
    import {
        Icon,
        ServerStack,
        Heart,
        MusicalNote,
        ChevronDown,
        CheckCircle,
        Link,
    } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { toasts } from '$lib/stores/toast.store';
    import SettingsGroup from './SettingsGroup.svelte';
    import InlineConfirm from './InlineConfirm.svelte';
    import JellyfinConnectModal from '$lib/components/jellyfin-connect/JellyfinConnectModal.svelte';
    import SubsonicConnectModal from '$lib/components/subsonic-connect/SubsonicConnectModal.svelte';
    import SyncActivityList from './SyncActivityList.svelte';
    import SyncJobProgress from './SyncJobProgress.svelte';
    import {
        getMalStatus,
        initiateMalAuthorize,
        unlinkMal as apiUnlinkMal,
        getMalActivity,
        getTraktStatus,
        initiateTraktAuthorize,
        unlinkTrakt as apiUnlinkTrakt,
        getTraktActivity,
        getDirection,
        setDirection,
        startSync,
        cancelSync,
        getSyncStatus,
        getJellyfinActivity,
        importJellyfinWatchlist,
    } from '$lib/api/integrations.js';
    import type {
        SyncActivityItem,
        Direction,
        SyncStatus,
    } from '$lib/schemas/api-integrations-responses';

    const NON_TERMINAL_SYNC_STATES = new Set(['pending', 'active', 'cancelling']);
    function isNonTerminalSyncState(state: SyncStatus['state']): boolean {
        return !!state && NON_TERMINAL_SYNC_STATES.has(state);
    }

    const username = $derived($page.data?.user?.username ?? '');
    const showJellyfin = $derived($page.data?.features?.jellyfinCompat === true);
    const showSubsonic = $derived($page.data?.features?.subsonicCompat === true);

    let showJellyfinModal = $state(false);
    let showSubsonicModal = $state(false);

    // MAL state
    let malLinked = $state(false);
    let malAuthFailed = $state(false);
    // Seeded from the SSR flag so the MyAnimeList card renders on first paint
    // (in a loading state) instead of popping in after the status request and
    // shoving everything below it down.
    let malConfigured = $state(untrack(() => $page.data?.malConfigured === true));
    let malUsername = $state('');
    let malLoading = $state(untrack(() => $page.data?.malConfigured === true));
    let malLinking = $state(false);
    let malActivity = $state<SyncActivityItem[]>([]);

    // MAL watch-sync direction + manual sync
    let malDirection = $state<Direction>('both');
    let malDirectionSaving = $state(false);
    let malSyncStatus = $state<SyncStatus | null>(null);
    let malSyncRunId = $state<string | null>(null);
    let malSyncBusy = $state(false);
    let malPollHandle: ReturnType<typeof setInterval> | null = null;

    async function loadMalActivity(): Promise<void> {
        try {
            const { data } = await getMalActivity();
            if (data) malActivity = data.items;
        } catch {
            /* ignore */
        }
    }

    async function loadMalDirection(): Promise<void> {
        try {
            const { data } = await getDirection('mal');
            if (data) malDirection = data.direction;
        } catch {
            /* ignore */
        }
    }

    function stopMalPolling(): void {
        if (malPollHandle !== null) {
            clearInterval(malPollHandle);
            malPollHandle = null;
        }
    }

    function startMalPolling(): void {
        if (malPollHandle !== null) return;
        malPollHandle = setInterval(() => {
            void (async () => {
                try {
                    const { data } = await getSyncStatus('mal');
                    if (data) {
                        malSyncStatus = data;
                        if (!isNonTerminalSyncState(data.state)) stopMalPolling();
                    }
                } catch {
                    /* ignore transient polling errors; keep polling */
                }
            })();
        }, 1500);
    }

    async function loadMalSyncStatus(): Promise<void> {
        try {
            const { data } = await getSyncStatus('mal');
            if (data) {
                malSyncStatus = data;
                if (isNonTerminalSyncState(data.state)) {
                    // Rehydrate the tracked run id after a reload so the
                    // Cancel button (which posts malSyncRunId) targets the
                    // run the server is actually reporting, not a stale
                    // in-memory value that was reset to null on page load.
                    if (data.runId) malSyncRunId = data.runId;
                    startMalPolling();
                }
            }
        } catch {
            /* ignore */
        }
    }

    async function changeMalDirection(next: Direction): Promise<void> {
        const previous = malDirection;
        malDirection = next;
        malDirectionSaving = true;
        try {
            const { error } = await setDirection('mal', next);
            if (error) {
                malDirection = previous;
                toasts.error(m.settings_connections_direction_update_failed());
            }
        } catch {
            malDirection = previous;
            toasts.error(m.settings_connections_direction_update_failed());
        } finally {
            malDirectionSaving = false;
        }
    }

    async function startMalSync(direction: 'pull' | 'push'): Promise<void> {
        malSyncBusy = true;
        try {
            const { data, error } = await startSync('mal', direction);
            if (error || !data) {
                toasts.error(error || m.settings_connections_sync_start_failed());
                return;
            }
            malSyncRunId = data.runId;
            malSyncStatus = { state: 'pending', processed: 0, recentActivity: [] };
            startMalPolling();
        } catch {
            toasts.error(m.settings_connections_sync_start_failed());
        } finally {
            malSyncBusy = false;
        }
    }

    async function importMalHistory(): Promise<void> {
        await startMalSync('pull');
    }

    async function exportMalHistory(): Promise<void> {
        await startMalSync('push');
    }

    async function cancelMalSync(): Promise<void> {
        if (!malSyncRunId) {
            toasts.error(m.settings_connections_sync_cancel_failed());
            return;
        }
        try {
            const { data, error } = await cancelSync('mal', malSyncRunId);
            if (error) {
                toasts.error(m.settings_connections_sync_cancel_failed());
            } else if (data && !data.accepted) {
                // The run was already terminal (or otherwise not
                // cancellable) by the time the request landed — surface it
                // and re-poll so the panel reflects reality instead of
                // silently doing nothing.
                toasts.error(m.settings_connections_sync_cancel_failed());
                void loadMalSyncStatus();
            }
        } catch {
            toasts.error(m.settings_connections_sync_cancel_failed());
        }
    }

    async function checkMalStatus(): Promise<void> {
        malLoading = true;
        try {
            const { data } = await getMalStatus();
            if (data) {
                malAuthFailed = data.auth_failed === true;
                malLinked = !!data.linked && !malAuthFailed;
                malConfigured = data.configured ?? false;
                malUsername = (data.malUsername as string | undefined) ?? '';
                if (malLinked) {
                    void loadMalActivity();
                    void loadMalDirection();
                    void loadMalSyncStatus();
                }
            }
        } catch {
            /* ignore */
        } finally {
            malLoading = false;
        }
    }

    async function startMalLink(): Promise<void> {
        malLinking = true;
        try {
            const { data, error } = await initiateMalAuthorize();
            if (error || !data?.authUrl) {
                toasts.error(error || m.settings_connections_mal_authorize_failed());
                return;
            }
            window.location.href = data.authUrl;
        } catch {
            toasts.error(m.settings_connections_mal_authorize_failed());
        } finally {
            malLinking = false;
        }
    }

    async function unlinkMal(): Promise<void> {
        malLoading = true;
        try {
            const { error } = await apiUnlinkMal();
            if (!error) {
                malLinked = false;
                malUsername = '';
                stopMalPolling();
                malSyncStatus = null;
                malSyncRunId = null;
                toasts.success(m.settings_connections_mal_unlinked());
            } else {
                toasts.error(m.settings_connections_mal_unlink_failed());
            }
        } catch {
            toasts.error(m.settings_connections_mal_unlink_failed());
        } finally {
            malLoading = false;
        }
    }

    // Trakt state
    let traktLinked = $state(false);
    let traktAuthFailed = $state(false);
    let traktConfigured = $state(false);
    let traktUsername = $state('');
    let traktLoading = $state(false);
    let traktLinking = $state(false);
    let traktActivity = $state<SyncActivityItem[]>([]);

    // Trakt watch-sync direction + manual sync
    let traktDirection = $state<Direction>('both');
    let traktDirectionSaving = $state(false);
    let traktSyncStatus = $state<SyncStatus | null>(null);
    let traktSyncRunId = $state<string | null>(null);
    let traktSyncBusy = $state(false);
    let traktPollHandle: ReturnType<typeof setInterval> | null = null;

    async function loadTraktActivity(): Promise<void> {
        try {
            const { data } = await getTraktActivity();
            if (data) traktActivity = data.items;
        } catch {
            /* ignore */
        }
    }

    async function loadTraktDirection(): Promise<void> {
        try {
            const { data } = await getDirection('trakt');
            if (data) traktDirection = data.direction;
        } catch {
            /* ignore */
        }
    }

    function stopTraktPolling(): void {
        if (traktPollHandle !== null) {
            clearInterval(traktPollHandle);
            traktPollHandle = null;
        }
    }

    function startTraktPolling(): void {
        if (traktPollHandle !== null) return;
        traktPollHandle = setInterval(() => {
            void (async () => {
                try {
                    const { data } = await getSyncStatus('trakt');
                    if (data) {
                        traktSyncStatus = data;
                        if (!isNonTerminalSyncState(data.state)) stopTraktPolling();
                    }
                } catch {
                    /* ignore transient polling errors; keep polling */
                }
            })();
        }, 1500);
    }

    async function loadTraktSyncStatus(): Promise<void> {
        try {
            const { data } = await getSyncStatus('trakt');
            if (data) {
                traktSyncStatus = data;
                if (isNonTerminalSyncState(data.state)) {
                    // Rehydrate the tracked run id after a reload so the
                    // Cancel button (which posts traktSyncRunId) targets the
                    // run the server is actually reporting, not a stale
                    // in-memory value that was reset to null on page load.
                    if (data.runId) traktSyncRunId = data.runId;
                    startTraktPolling();
                }
            }
        } catch {
            /* ignore */
        }
    }

    async function changeTraktDirection(next: Direction): Promise<void> {
        const previous = traktDirection;
        traktDirection = next;
        traktDirectionSaving = true;
        try {
            const { error } = await setDirection('trakt', next);
            if (error) {
                traktDirection = previous;
                toasts.error(m.settings_connections_direction_update_failed());
            }
        } catch {
            traktDirection = previous;
            toasts.error(m.settings_connections_direction_update_failed());
        } finally {
            traktDirectionSaving = false;
        }
    }

    async function startTraktSync(direction: 'pull' | 'push'): Promise<void> {
        traktSyncBusy = true;
        try {
            const { data, error } = await startSync('trakt', direction);
            if (error || !data) {
                toasts.error(error || m.settings_connections_sync_start_failed());
                return;
            }
            traktSyncRunId = data.runId;
            traktSyncStatus = { state: 'pending', processed: 0, recentActivity: [] };
            startTraktPolling();
        } catch {
            toasts.error(m.settings_connections_sync_start_failed());
        } finally {
            traktSyncBusy = false;
        }
    }

    async function importTraktHistory(): Promise<void> {
        await startTraktSync('pull');
    }

    async function exportTraktHistory(): Promise<void> {
        await startTraktSync('push');
    }

    async function cancelTraktSync(): Promise<void> {
        if (!traktSyncRunId) {
            toasts.error(m.settings_connections_sync_cancel_failed());
            return;
        }
        try {
            const { data, error } = await cancelSync('trakt', traktSyncRunId);
            if (error) {
                toasts.error(m.settings_connections_sync_cancel_failed());
            } else if (data && !data.accepted) {
                // The run was already terminal (or otherwise not
                // cancellable) by the time the request landed — surface it
                // and re-poll so the panel reflects reality instead of
                // silently doing nothing.
                toasts.error(m.settings_connections_sync_cancel_failed());
                void loadTraktSyncStatus();
            }
        } catch {
            toasts.error(m.settings_connections_sync_cancel_failed());
        }
    }

    async function checkTraktStatus(): Promise<void> {
        traktLoading = true;
        try {
            const { data } = await getTraktStatus();
            if (data) {
                traktAuthFailed = data.auth_failed === true;
                traktLinked = !!data.linked && !traktAuthFailed;
                traktConfigured = data.configured ?? false;
                traktUsername = (data.traktUsername as string | undefined) ?? '';
                if (traktLinked) {
                    void loadTraktActivity();
                    void loadTraktDirection();
                    void loadTraktSyncStatus();
                }
            }
        } catch {
            /* ignore */
        } finally {
            traktLoading = false;
        }
    }

    async function startTraktLink(): Promise<void> {
        traktLinking = true;
        try {
            const { data, error } = await initiateTraktAuthorize();
            if (error || !data?.authUrl) {
                toasts.error(error || m.settings_connections_trakt_authorize_failed());
                return;
            }
            window.location.href = data.authUrl;
        } catch {
            toasts.error(m.settings_connections_trakt_authorize_failed());
        } finally {
            traktLinking = false;
        }
    }

    async function unlinkTrakt(): Promise<void> {
        traktLoading = true;
        try {
            const { error } = await apiUnlinkTrakt();
            if (!error) {
                traktLinked = false;
                traktUsername = '';
                stopTraktPolling();
                traktSyncStatus = null;
                traktSyncRunId = null;
                toasts.success(m.settings_connections_trakt_unlinked());
            } else {
                toasts.error(m.settings_connections_trakt_unlink_failed());
            }
        } catch {
            toasts.error(m.settings_connections_trakt_unlink_failed());
        } finally {
            traktLoading = false;
        }
    }

    // Jellyfin sync activity (read-only panel; data-driven — only rendered when non-empty)
    let jellyfinActivity = $state<SyncActivityItem[]>([]);

    const showJellyfinWatchlistImport = $derived($page.data?.features?.jellyfinSync === true);
    let jellyfinWatchlistImportBusy = $state(false);

    async function importJellyfinFavoritesToWatchlist(): Promise<void> {
        jellyfinWatchlistImportBusy = true;
        try {
            const { data, error } = await importJellyfinWatchlist();
            if (error || !data) {
                toasts.error(m.settings_connections_jellyfin_import_watchlist_failed());
                return;
            }
            toasts.success(
                m.settings_connections_jellyfin_import_watchlist_success({
                    imported: data.imported,
                    total: data.total,
                }),
            );
        } catch {
            toasts.error(m.settings_connections_jellyfin_import_watchlist_failed());
        } finally {
            jellyfinWatchlistImportBusy = false;
        }
    }

    async function loadJellyfinActivity(): Promise<void> {
        try {
            const { data } = await getJellyfinActivity();
            if (data) jellyfinActivity = data.items;
        } catch {
            /* ignore */
        }
    }

    function linkFailureMessage(reason: string | null): string {
        switch (reason) {
            case 'session':
                return m.connections_reason_session();
            case 'configuration':
                return m.connections_reason_configuration();
            case 'denied':
                return m.connections_reason_denied();
            case 'state':
                return m.connections_reason_state();
            case 'token':
                return m.connections_reason_token();
            case 'profile':
                return m.connections_reason_profile();
            case 'storage':
                return m.connections_reason_storage();
            default:
                return m.connections_reason_unknown();
        }
    }

    onMount(() => {
        // Surface the MAL OAuth round-trip result (spec a11y #6 returns here).
        const params = new URLSearchParams($page.url.search);
        const malLink = params.get('mal_link');
        if (malLink === 'success') toasts.success(m.settings_connections_mal_linked());
        else if (malLink === 'error') toasts.error(linkFailureMessage(params.get('reason')));
        void checkMalStatus();

        const traktLink = params.get('trakt_link');
        if (traktLink === 'success') toasts.success(m.settings_connections_trakt_linked());
        else if (traktLink === 'error') toasts.error(linkFailureMessage(params.get('reason')));
        void checkTraktStatus();

        if (showJellyfin) void loadJellyfinActivity();
    });

    // Deep-link support: `?connect=<id>` opens a connect modal directly (e.g.
    // from a bookmark or a settings search result). Runs in afterNavigate,
    // not onMount: clicking a search result while already on this section
    // only changes the query string, and SvelteKit does not remount the
    // component in that case, so onMount would never re-fire. Mirrors the
    // `?settings=<id>` pattern on /admin/settings/plugins/+page.svelte. Strip
    // the param immediately so a refresh or Back after closing the modal
    // doesn't reopen it.
    afterNavigate(({ to }) => {
        if (!to) return;
        const connect = to.url.searchParams.get('connect');
        if (!connect) return;
        if (connect === 'jellyfin' && showJellyfin) {
            showJellyfinModal = true;
        } else if (connect === 'subsonic' && showSubsonic) {
            showSubsonicModal = true;
        }
        const url = new URL(to.url);
        url.searchParams.delete('connect');
        window.history.replaceState(window.history.state, '', url);
    });

    onDestroy(() => {
        stopMalPolling();
        stopTraktPolling();
    });
</script>

<!--
  One card per thing you can connect. Apps that sign IN to this server (Jellyfin,
  Subsonic) come first; services this server syncs OUT to (MyAnimeList, Trakt)
  follow, and share one layout so the two cannot drift apart again.
-->
{#if showJellyfin || showJellyfinWatchlistImport}
    <SettingsGroup
        label={m.settings_connections_jellyfin_label()}
        description={m.settings_connections_jellyfin_description()}>
        {#if showJellyfin}
            <div class="flex flex-wrap items-center justify-between gap-3 py-3 px-4">
                <div class="flex items-center gap-3 min-w-0">
                    <Icon src={ServerStack} class="w-5 h-5 text-surface-400 shrink-0" />
                    <div class="min-w-0">
                        <span class="text-sm">{m.settings_connections_connect_client()}</span>
                        <p class="text-xs text-surface-400 mt-0.5">
                            {m.settings_connections_connect_client_hint()}
                            <a
                                href={resolve('/settings/sessions')}
                                class="text-primary-400 hover:text-primary-300 underline underline-offset-2 whitespace-nowrap"
                                >{m.settings_connections_see_connected()}</a>
                        </p>
                    </div>
                </div>
                <button
                    class="btn btn-sm variant-filled-primary"
                    onclick={() => (showJellyfinModal = true)}>
                    {m.settings_connections_connect()}
                </button>
            </div>
        {/if}
        {#if showJellyfinWatchlistImport}
            <div class="flex flex-wrap items-center justify-between gap-3 py-3 px-4">
                <div class="flex items-center gap-3 min-w-0">
                    <Icon src={Heart} class="w-5 h-5 text-surface-400 shrink-0" />
                    <div class="min-w-0">
                        <span class="text-sm"
                            >{m.settings_connections_jellyfin_import_title()}</span>
                        <p class="text-xs text-surface-400 mt-0.5">
                            {m.settings_connections_jellyfin_import_hint()}
                        </p>
                    </div>
                </div>
                <button
                    class="btn btn-sm variant-soft-surface"
                    disabled={jellyfinWatchlistImportBusy}
                    onclick={importJellyfinFavoritesToWatchlist}>
                    {m.settings_connections_import()}
                </button>
            </div>
        {/if}
        {#if showJellyfin && jellyfinActivity.length > 0}
            {@render activity(
                jellyfinActivity,
                'Jellyfin',
                m.settings_connections_jellyfin_activity_description(),
            )}
        {/if}
    </SettingsGroup>
{/if}

{#if showSubsonic}
    <SettingsGroup
        label={m.settings_connections_music_label()}
        description={m.settings_connections_music_description()}>
        <div class="flex flex-wrap items-center justify-between gap-3 py-3 px-4">
            <div class="flex items-center gap-3 min-w-0">
                <Icon src={MusicalNote} class="w-5 h-5 text-surface-400 shrink-0" />
                <div class="min-w-0">
                    <span class="text-sm">{m.settings_connections_connect_music()}</span>
                    <p class="text-xs text-surface-400 mt-0.5">
                        {m.settings_connections_connect_music_hint()}
                    </p>
                </div>
            </div>
            <button
                class="btn btn-sm variant-filled-primary"
                onclick={() => (showSubsonicModal = true)}>
                {m.settings_connections_connect()}
            </button>
        </div>
    </SettingsGroup>
{/if}

<!-- Recent activity, collapsed: ten lines of "↑ ✓ The Order · S1E10" used to sit
     open under every service, with no key to what the arrows meant. -->
{#snippet activity(items: SyncActivityItem[], provider: string, hint?: string)}
    <details class="group">
        <summary
            class="flex items-center justify-between gap-2 py-3 px-4 cursor-pointer text-sm list-none">
            <span>{m.settings_connections_recent_activity()}</span>
            <Icon
                src={ChevronDown}
                class="w-4 h-4 text-surface-400 transition-transform group-open:rotate-180" />
        </summary>
        <p class="px-4 text-xs text-surface-400">
            {[hint, m.settings_connections_activity_legend({ provider })].filter(Boolean).join(' ')}
        </p>
        <SyncActivityList {items} />
    </details>
{/snippet}

{#snippet syncService(p: {
    provider: string;
    label: string;
    description: string;
    loading: boolean;
    linked: boolean;
    authFailed: boolean;
    linking: boolean;
    accountName: string;
    direction: Direction;
    directionSaving: boolean;
    syncBusy: boolean;
    syncStatus: SyncStatus | null;
    items: SyncActivityItem[];
    onLink: () => void;
    onUnlink: () => void | Promise<void>;
    onDirection: (d: Direction) => void;
    onImport: () => void;
    onExport: () => void | Promise<void>;
    onCancel: () => void;
})}
    <SettingsGroup label={p.label} description={p.description}>
        <div class="flex flex-wrap items-center justify-between gap-3 py-3 px-4">
            <div class="flex items-center gap-3 min-w-0">
                <Icon
                    src={p.linked ? CheckCircle : Link}
                    class="w-5 h-5 shrink-0 {p.linked ? 'text-success-500' : 'text-surface-400'}" />
                {#if p.loading}
                    <span class="text-sm text-surface-400">{m.settings_connections_loading()}</span>
                {:else if p.authFailed}
                    <span class="text-sm text-warning-400">{m.connections_reconnect_needed()}</span>
                {:else if p.linked}
                    <span class="text-sm"
                        >{m.settings_connections_linked_as({ username: p.accountName })}</span>
                {:else}
                    <span class="text-sm">{m.settings_connections_not_linked()}</span>
                {/if}
            </div>
            {#if p.linked}
                <InlineConfirm
                    triggerLabel={m.settings_connections_unlink()}
                    confirmLabel={m.settings_connections_confirm()}
                    busy={p.loading}
                    onConfirm={p.onUnlink} />
            {:else}
                <button
                    class="btn btn-sm variant-filled-primary"
                    onclick={p.onLink}
                    disabled={p.linking || p.loading}>
                    {p.linking
                        ? m.settings_connections_redirecting()
                        : p.authFailed
                          ? m.connections_reconnect()
                          : m.settings_connections_link_account()}
                </button>
            {/if}
        </div>
        {#if p.linked}
            <div class="flex flex-wrap items-center justify-between gap-3 py-3 px-4">
                <div class="min-w-0">
                    <span class="text-sm">{m.settings_connections_direction_label()}</span>
                    <p class="text-xs text-surface-400 mt-0.5">
                        {p.direction === 'pull'
                            ? m.settings_connections_direction_hint_pull({ provider: p.provider })
                            : p.direction === 'push'
                              ? m.settings_connections_direction_hint_push({
                                    provider: p.provider,
                                })
                              : m.settings_connections_direction_hint_both({
                                    provider: p.provider,
                                })}
                    </p>
                </div>
                <select
                    class="select select-sm w-auto max-w-full text-sm"
                    aria-label={m.settings_connections_direction_label()}
                    value={p.direction}
                    disabled={p.directionSaving}
                    onchange={(e) => p.onDirection(e.currentTarget.value as Direction)}>
                    <option value="both">{m.settings_connections_direction_both()}</option>
                    <option value="pull"
                        >{m.settings_connections_direction_pull({ provider: p.provider })}</option>
                    <option value="push"
                        >{m.settings_connections_direction_push({ provider: p.provider })}</option>
                </select>
            </div>
            <div class="py-3 px-4">
                <span class="text-sm">{m.settings_connections_transfer_label()}</span>
                <p class="text-xs text-surface-400 mt-0.5 mb-2">
                    {m.settings_connections_transfer_hint()}
                </p>
                <div class="flex flex-wrap items-center gap-2">
                    <button
                        class="btn btn-sm variant-soft-surface"
                        disabled={p.syncBusy}
                        onclick={p.onImport}>
                        {m.settings_connections_import_history({ provider: p.provider })}
                    </button>
                    <InlineConfirm
                        triggerLabel={m.settings_connections_export_history({
                            provider: p.provider,
                        })}
                        confirmLabel={m.settings_connections_export_confirm({
                            provider: p.provider,
                        })}
                        variant="primary"
                        busy={p.syncBusy}
                        onConfirm={p.onExport} />
                </div>
            </div>
            <SyncJobProgress status={p.syncStatus} onCancel={p.onCancel} />
            {#if p.items.length > 0}
                {@render activity(p.items, p.provider)}
            {/if}
        {/if}
    </SettingsGroup>
{/snippet}

{#if malConfigured || malLinked || malAuthFailed}
    {@render syncService({
        provider: 'MyAnimeList',
        label: m.settings_connections_mal_label(),
        description: m.settings_connections_mal_description(),
        loading: malLoading,
        linked: malLinked,
        authFailed: malAuthFailed,
        linking: malLinking,
        accountName: malUsername,
        direction: malDirection,
        directionSaving: malDirectionSaving,
        syncBusy: malSyncBusy,
        syncStatus: malSyncStatus,
        items: malActivity,
        onLink: startMalLink,
        onUnlink: unlinkMal,
        onDirection: (d) => void changeMalDirection(d),
        onImport: () => void importMalHistory(),
        onExport: exportMalHistory,
        onCancel: cancelMalSync,
    })}
{/if}

{#if traktConfigured || traktLinked || traktAuthFailed}
    {@render syncService({
        provider: 'Trakt',
        label: m.settings_connections_trakt_label(),
        description: m.settings_connections_trakt_description(),
        loading: traktLoading,
        linked: traktLinked,
        authFailed: traktAuthFailed,
        linking: traktLinking,
        accountName: traktUsername,
        direction: traktDirection,
        directionSaving: traktDirectionSaving,
        syncBusy: traktSyncBusy,
        syncStatus: traktSyncStatus,
        items: traktActivity,
        onLink: startTraktLink,
        onUnlink: unlinkTrakt,
        onDirection: (d) => void changeTraktDirection(d),
        onImport: () => void importTraktHistory(),
        onExport: exportTraktHistory,
        onCancel: cancelTraktSync,
    })}
{/if}

{#if showJellyfinModal}
    <JellyfinConnectModal {username} onclose={() => (showJellyfinModal = false)} />
{/if}
{#if showSubsonicModal}
    <SubsonicConnectModal open={showSubsonicModal} onclose={() => (showSubsonicModal = false)} />
{/if}
