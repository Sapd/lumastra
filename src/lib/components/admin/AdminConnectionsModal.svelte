<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  AdminConnectionsModal

  Admin-side, per-user management of a target user's client connections:
    - Device sessions (OAuth device-flow + Jellyfin device tokens) — revoke
    - Jellyfin /j client password — reset (show once) / revoke
    - Subsonic token — reset (show once) / revoke
    - Personal Access Tokens — view / revoke (never minted on behalf)

  Each section renders only when its server feature flag is enabled (read from
  $page.data.features). Reset issues a fresh credential shown ONCE for the admin
  to relay; revokes go through a shared confirm dialog. All server routes are
  admin-gated + audit-logged.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { page } from '$app/stores';
    import {
        Icon,
        ArrowPath,
        Key,
        DevicePhoneMobile,
        MusicalNote,
        CommandLine,
        ClipboardDocument,
        Trash,
    } from 'svelte-hero-icons';
    import { ActionModal } from '$lib/components/admin';
    import * as m from '$lib/paraglide/messages.js';
    import * as adminApi from '$lib/api/admin';
    import type { AdminUserToken } from '$lib/schemas/api-admin-responses';
    import type { UserDeviceInfo } from '$lib/schemas/api-user-responses';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';

    interface Props {
        username: string;
        userId: string;
        formatDate: (dateStr: string | null | undefined) => string;
        onclose: () => void;
        /** Render in place (the user drawer's Access tab) instead of as a dialog. */
        inline?: boolean;
    }

    let { username, userId, formatDate, onclose, inline = false }: Props = $props();

    let features = $derived(($page.data?.features ?? {}) as Record<string, boolean | undefined>);
    let showDevices = $derived(features.deviceAuth === true);
    let showJellyfin = $derived(features.jellyfinCompat === true);
    let showSubsonic = $derived(features.subsonicCompat === true);
    let showPats = $derived(features.userPats === true);
    let anySection = $derived(showDevices || showJellyfin || showSubsonic || showPats);

    // ── devices ───────────────────────────────────────────────────────────────
    let devicesLoading = $state(false);
    let devices = $state<UserDeviceInfo[]>([]);

    // ── jellyfin /j password ────────────────────────────────────────────────
    let jellyfinLoading = $state(false);
    let jellyfinHasPassword = $state(false);
    let jellyfinBusy = $state(false);
    let jellyfinCredential = $state<string | null>(null);

    // ── subsonic token ──────────────────────────────────────────────────────
    let subsonicLoading = $state(false);
    let subsonicHasToken = $state(false);
    let subsonicBusy = $state(false);
    let subsonicCredential = $state<string | null>(null);

    // ── personal access tokens ────────────────────────────────────────────────
    let patsLoading = $state(false);
    let pats = $state<AdminUserToken[]>([]);
    let revokingPatId = $state<number | null>(null);

    // ── shared destructive-confirm dialog ─────────────────────────────────────
    let pending = $state<{
        title: string;
        body: string;
        confirmText: string;
        run: () => Promise<void>;
    } | null>(null);

    async function copy(text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            toasts.success(m.admin_conn_copied());
        } catch {
            toasts.error(m.admin_conn_copy_failed());
        }
    }

    async function loadDevices(): Promise<void> {
        // The modal can switch to another user while this is in flight.
        const forUser = userId;
        devicesLoading = true;
        try {
            const { data, error } = await adminApi.getAdminDevices(forUser);
            if (forUser !== userId) return;
            if (error || !data) {
                toasts.error(error ?? m.admin_conn_load_devices_failed());
                return;
            }
            devices = data.items;
        } finally {
            devicesLoading = false;
        }
    }

    async function loadJellyfin(): Promise<void> {
        jellyfinLoading = true;
        try {
            const { data, error } = await adminApi.getAdminJellyfinPasswordStatus(username);
            if (error || !data) {
                toasts.error(error ?? m.admin_conn_load_jellyfin_failed());
                return;
            }
            jellyfinHasPassword = data.hasPassword;
        } finally {
            jellyfinLoading = false;
        }
    }

    async function loadSubsonic(): Promise<void> {
        subsonicLoading = true;
        try {
            const { data, error } = await adminApi.getAdminSubsonicTokenStatus(username);
            if (error || !data) {
                toasts.error(error ?? m.admin_conn_load_subsonic_failed());
                return;
            }
            subsonicHasToken = data.hasToken;
        } finally {
            subsonicLoading = false;
        }
    }

    async function loadPats(): Promise<void> {
        patsLoading = true;
        try {
            const { data, error } = await adminApi.getAdminUserTokens(userId);
            if (error || !data) {
                toasts.error(error ?? m.admin_conn_load_pats_failed());
                return;
            }
            pats = data.items;
        } finally {
            patsLoading = false;
        }
    }

    onMount(() => {
        if (showDevices) void loadDevices();
        if (showJellyfin) void loadJellyfin();
        if (showSubsonic) void loadSubsonic();
        if (showPats) void loadPats();
    });

    // ── jellyfin actions ──────────────────────────────────────────────────────
    async function doResetJellyfin(): Promise<void> {
        jellyfinBusy = true;
        try {
            const { data, error } = await adminApi.resetAdminJellyfinPassword(username);
            if (error || !data) {
                toasts.error(error ?? m.admin_conn_reset_password_failed());
                return;
            }
            if (!data.password) {
                toasts.error(m.admin_conn_empty_password());
                return;
            }
            jellyfinCredential = data.password;
            jellyfinHasPassword = true;
            toasts.success(m.admin_conn_jellyfin_reset_ok());
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_conn_reset_password_failed()));
        } finally {
            jellyfinBusy = false;
        }
    }

    // Resetting an existing password invalidates the live credential (clients
    // re-pair), so confirm first; first-time generation is non-destructive.
    function resetJellyfin(): void {
        if (jellyfinHasPassword) {
            pending = {
                title: m.admin_conn_reset_jellyfin_title(),
                body: m.admin_conn_reset_jellyfin_body({ username }),
                confirmText: m.admin_conn_confirm_reset(),
                run: doResetJellyfin,
            };
            return;
        }
        void doResetJellyfin();
    }

    function confirmRevokeJellyfin(): void {
        pending = {
            title: m.admin_conn_revoke_jellyfin_title(),
            body: m.admin_conn_revoke_jellyfin_body({ username }),
            confirmText: m.admin_conn_revoke(),
            run: async () => {
                const { error } = await adminApi.deleteAdminJellyfinPassword(username);
                if (error) {
                    toasts.error(error);
                    return;
                }
                jellyfinHasPassword = false;
                jellyfinCredential = null;
                toasts.success(m.admin_conn_jellyfin_revoked());
            },
        };
    }

    // ── subsonic actions ──────────────────────────────────────────────────────
    async function doResetSubsonic(): Promise<void> {
        subsonicBusy = true;
        try {
            const { data, error } = await adminApi.resetAdminSubsonicToken(username);
            if (error || !data) {
                toasts.error(error ?? m.admin_conn_reset_token_failed());
                return;
            }
            if (!data.token) {
                toasts.error(m.admin_conn_empty_token());
                return;
            }
            subsonicCredential = data.token;
            subsonicHasToken = true;
            toasts.success(m.admin_conn_subsonic_reset_ok());
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_conn_reset_token_failed()));
        } finally {
            subsonicBusy = false;
        }
    }

    function resetSubsonic(): void {
        if (subsonicHasToken) {
            pending = {
                title: m.admin_conn_reset_subsonic_title(),
                body: m.admin_conn_reset_subsonic_body({ username }),
                confirmText: m.admin_conn_confirm_reset(),
                run: doResetSubsonic,
            };
            return;
        }
        void doResetSubsonic();
    }

    function confirmRevokeSubsonic(): void {
        pending = {
            title: m.admin_conn_revoke_subsonic_title(),
            body: m.admin_conn_revoke_subsonic_body({ username }),
            confirmText: m.admin_conn_revoke(),
            run: async () => {
                const { error } = await adminApi.deleteAdminSubsonicToken(username);
                if (error) {
                    toasts.error(error);
                    return;
                }
                subsonicHasToken = false;
                subsonicCredential = null;
                toasts.success(m.admin_conn_subsonic_revoked());
            },
        };
    }

    // ── device actions ──────────────────────────────────────────────────────
    function confirmRevokeDevice(d: UserDeviceInfo): void {
        pending = {
            title: m.admin_conn_revoke_device_aria(),
            body: m.admin_conn_revoke_device_body({
                username,
                device: d.deviceName ?? m.admin_conn_unknown_device(),
            }),
            confirmText: m.admin_conn_revoke(),
            run: async () => {
                const { error } = await adminApi.deleteAdminDevice(userId, d.deviceSessionId);
                if (error) {
                    toasts.error(error);
                    return;
                }
                toasts.success(m.admin_conn_device_revoked());
                await loadDevices();
            },
        };
    }

    function confirmRevokeAllDevices(): void {
        pending = {
            title: m.admin_conn_revoke_all_title(),
            body: m.admin_conn_revoke_all_body({ username, count: devices.length }),
            confirmText: m.admin_conn_revoke_all(),
            run: async () => {
                const { data, error } = await adminApi.deleteAllAdminDevices(userId);
                if (error) {
                    toasts.error(error);
                    return;
                }
                // A best-effort sweep answers 200 even when a store failed;
                // never report "all revoked" while a credential survived.
                if (data && data.failedStores.length > 0) {
                    toasts.error(
                        m.admin_conn_revoke_partial({ stores: data.failedStores.join(', ') }),
                    );
                } else {
                    toasts.success(m.admin_conn_all_devices_revoked());
                }
                await loadDevices();
            },
        };
    }

    // ── PAT actions ───────────────────────────────────────────────────────────
    function confirmRevokePat(t: AdminUserToken): void {
        pending = {
            title: m.admin_conn_revoke_pat_title(),
            body: m.admin_conn_revoke_pat_body({ username, name: t.name }),
            confirmText: m.admin_conn_revoke(),
            run: async () => {
                revokingPatId = t.id;
                try {
                    const { error } = await adminApi.deleteAdminUserToken(userId, t.id);
                    if (error) {
                        toasts.error(error);
                        return;
                    }
                    toasts.success(m.admin_conn_token_revoked());
                    await loadPats();
                } finally {
                    revokingPatId = null;
                }
            },
        };
    }

    async function runPending(): Promise<void> {
        if (!pending) return;
        const action = pending;
        try {
            await action.run();
        } catch (e) {
            // A thrown request (network error) used to vanish as an
            // unhandled rejection with no feedback at all.
            toasts.error(getErrorMessage(e, m.toast_unknown_error()));
        } finally {
            pending = null;
        }
    }
</script>

<ActionModal
    title={m.admin_conn_title({ username })}
    confirmText={m.btn_close()}
    confirmColor="blue"
    {inline}
    {onclose}
    onconfirm={onclose}>
    {#if !anySection}
        <p class="text-surface-400 text-sm">
            {m.admin_conn_none_enabled()}
        </p>
    {/if}

    <!-- Devices -->
    {#if showDevices}
        <section class="space-y-2">
            <div class="flex items-center justify-between">
                <h4 class="flex items-center gap-2 text-sm font-semibold text-white">
                    <Icon src={DevicePhoneMobile} class="w-4 h-4 text-surface-300" />
                    {m.admin_conn_devices()}
                </h4>
                {#if devices.length > 0}
                    <button
                        class="text-xs text-red-400 hover:text-red-300"
                        onclick={confirmRevokeAllDevices}>{m.admin_conn_revoke_all()}</button>
                {/if}
            </div>
            {#if devicesLoading}
                <p class="text-surface-400 text-xs flex items-center gap-2">
                    <Icon src={ArrowPath} class="w-3 h-3 animate-spin" />
                    {m.admin_conn_loading()}
                </p>
            {:else if devices.length === 0}
                <p class="text-surface-500 text-xs">{m.admin_conn_no_devices()}</p>
            {:else}
                <ul class="space-y-1">
                    {#each devices as d (d.deviceSessionId)}
                        <li
                            class="flex items-center justify-between gap-2 rounded bg-surface-700/40 px-2 py-1.5">
                            <div class="min-w-0">
                                <div class="truncate text-sm text-white">
                                    {d.deviceName ?? m.admin_conn_unknown_device()}
                                    <span class="ml-1 text-[10px] uppercase text-surface-400"
                                        >{d.deviceType ?? ''}</span>
                                </div>
                                <div class="text-[11px] text-surface-400">
                                    {m.admin_conn_last_used({ date: formatDate(d.lastUsedAt) })}
                                </div>
                            </div>
                            <button
                                class="shrink-0 text-red-400 hover:text-red-300"
                                aria-label={m.admin_conn_revoke_device_aria()}
                                onclick={() => confirmRevokeDevice(d)}>
                                <Icon src={Trash} class="w-4 h-4" />
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
    {/if}

    <!-- Jellyfin /j password -->
    {#if showJellyfin}
        <section class="space-y-2 border-t border-surface-700/50 pt-3">
            <h4 class="flex items-center gap-2 text-sm font-semibold text-white">
                <Icon src={Key} class="w-4 h-4 text-teal-300" />
                {m.admin_conn_jellyfin_title()}
            </h4>
            {#if jellyfinLoading}
                <p class="text-surface-400 text-xs flex items-center gap-2">
                    <Icon src={ArrowPath} class="w-3 h-3 animate-spin" />
                    {m.admin_conn_loading()}
                </p>
            {:else}
                {#if jellyfinCredential}
                    <div class="rounded border border-teal-700/50 bg-teal-900/20 p-2">
                        <div class="text-[11px] text-teal-300">
                            {m.admin_conn_jellyfin_shown_once()}
                        </div>
                        <div class="mt-1 flex items-center gap-2">
                            <code class="flex-1 truncate font-mono text-sm text-white"
                                >{jellyfinCredential}</code>
                            <button
                                class="shrink-0 text-teal-300 hover:text-teal-200"
                                aria-label={m.admin_conn_copy_password()}
                                onclick={() => copy(jellyfinCredential ?? '')}>
                                <Icon src={ClipboardDocument} class="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                {:else}
                    <p class="text-surface-400 text-xs">
                        {jellyfinHasPassword
                            ? m.admin_conn_jellyfin_configured()
                            : m.admin_conn_jellyfin_none()}
                    </p>
                {/if}
                <div class="flex gap-2">
                    <button
                        class="btn btn-sm btn-surface"
                        onclick={resetJellyfin}
                        disabled={jellyfinBusy}>
                        {jellyfinHasPassword
                            ? m.admin_conn_reset_password()
                            : m.admin_conn_generate_password()}
                    </button>
                    {#if jellyfinHasPassword}
                        <button
                            class="btn btn-sm btn-ghost-red"
                            onclick={confirmRevokeJellyfin}
                            disabled={jellyfinBusy}>{m.admin_conn_revoke()}</button>
                    {/if}
                </div>
            {/if}
        </section>
    {/if}

    <!-- Subsonic token -->
    {#if showSubsonic}
        <section class="space-y-2 border-t border-surface-700/50 pt-3">
            <h4 class="flex items-center gap-2 text-sm font-semibold text-white">
                <Icon src={MusicalNote} class="w-4 h-4 text-violet-300" />
                {m.admin_conn_subsonic_title()}
            </h4>
            {#if subsonicLoading}
                <p class="text-surface-400 text-xs flex items-center gap-2">
                    <Icon src={ArrowPath} class="w-3 h-3 animate-spin" />
                    {m.admin_conn_loading()}
                </p>
            {:else}
                {#if subsonicCredential}
                    <div class="rounded border border-violet-700/50 bg-violet-900/20 p-2">
                        <div class="text-[11px] text-violet-300">
                            {m.admin_conn_subsonic_shown_once()}
                        </div>
                        <div class="mt-1 flex items-center gap-2">
                            <code class="flex-1 truncate font-mono text-sm text-white"
                                >{subsonicCredential}</code>
                            <button
                                class="shrink-0 text-violet-300 hover:text-violet-200"
                                aria-label={m.admin_conn_copy_token()}
                                onclick={() => copy(subsonicCredential ?? '')}>
                                <Icon src={ClipboardDocument} class="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                {:else}
                    <p class="text-surface-400 text-xs">
                        {subsonicHasToken
                            ? m.admin_conn_subsonic_configured()
                            : m.admin_conn_subsonic_none()}
                    </p>
                {/if}
                <div class="flex gap-2">
                    <button
                        class="btn btn-sm btn-surface"
                        onclick={resetSubsonic}
                        disabled={subsonicBusy}>
                        {subsonicHasToken
                            ? m.admin_conn_reset_token()
                            : m.admin_conn_generate_token()}
                    </button>
                    {#if subsonicHasToken}
                        <button
                            class="btn btn-sm btn-ghost-red"
                            onclick={confirmRevokeSubsonic}
                            disabled={subsonicBusy}>{m.admin_conn_revoke()}</button>
                    {/if}
                </div>
            {/if}
        </section>
    {/if}

    <!-- Personal Access Tokens -->
    {#if showPats}
        <section class="space-y-2 border-t border-surface-700/50 pt-3">
            <h4 class="flex items-center gap-2 text-sm font-semibold text-white">
                <Icon src={CommandLine} class="w-4 h-4 text-surface-300" />
                {m.admin_conn_pats_title()}
            </h4>
            {#if patsLoading}
                <p class="text-surface-400 text-xs flex items-center gap-2">
                    <Icon src={ArrowPath} class="w-3 h-3 animate-spin" />
                    {m.admin_conn_loading()}
                </p>
            {:else if pats.length === 0}
                <p class="text-surface-500 text-xs">{m.admin_conn_no_pats()}</p>
            {:else}
                <ul class="space-y-1">
                    {#each pats as t (t.id)}
                        <li
                            class="flex items-center justify-between gap-2 rounded bg-surface-700/40 px-2 py-1.5">
                            <div class="min-w-0">
                                <div class="truncate text-sm text-white">{t.name}</div>
                                <div class="text-[11px] text-surface-400">
                                    {(t.scopes ?? []).join(', ') || 'read'}
                                    {#if t.isExpired}· <span class="text-amber-400"
                                            >{m.admin_conn_expired()}</span
                                        >{/if}
                                </div>
                            </div>
                            <button
                                class="shrink-0 text-red-400 hover:text-red-300 disabled:opacity-50"
                                aria-label={m.admin_conn_revoke_token_aria()}
                                disabled={revokingPatId === t.id}
                                onclick={() => confirmRevokePat(t)}>
                                <Icon src={Trash} class="w-4 h-4" />
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
            <p class="text-[11px] text-surface-500">
                {m.admin_conn_pats_note()}
            </p>
        </section>
    {/if}
</ActionModal>

{#if pending}
    <ActionModal
        title={pending.title}
        confirmText={pending.confirmText}
        confirmColor="red"
        onclose={() => (pending = null)}
        onconfirm={runPending}>
        <p class="text-surface-300 text-sm">{pending.body}</p>
    </ActionModal>
{/if}
