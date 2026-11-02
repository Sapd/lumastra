<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import { SvelteDate } from 'svelte/reactivity';
    import {
        Icon,
        DevicePhoneMobile,
        Tv,
        ComputerDesktop,
        PuzzlePiece,
        type IconSource,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import * as userApi from '$lib/api/user';
    import { toasts } from '$lib/stores/toast.store';
    import { getDeviceId } from '$lib/components/player/device-id';
    import InlineConfirm from './InlineConfirm.svelte';
    import DeviceNameEditor from './DeviceNameEditor.svelte';
    import DeviceRemote from './DeviceRemote.svelte';
    import SettingsGroup from './SettingsGroup.svelte';
    import { formatRelativeTime } from '$lib/utils/time-formatting';
    import {
        deviceKind,
        clientLabel,
        olderSessionIds,
        type DeviceKind,
    } from './device-presentation';
    import { deviceHasCommands } from '$lib/utils/device-remote';
    import type { UserDeviceInfo } from '$lib/schemas/api-user-responses';

    interface Props {
        initialSessions?: UserDeviceInfo[];
    }
    let { initialSessions = [] }: Props = $props();

    let sessions = $state<UserDeviceInfo[]>(untrack(() => initialSessions.slice()));
    let revokingDevice = $state<string | null>(null);
    let renamingDevice = $state<string | null>(null);
    let revokingAll = $state(false);
    let liveMessage = $state('');
    let thisDeviceId = $state('');
    let remoteFor = $state<UserDeviceInfo | null>(null);

    onMount(() => {
        thisDeviceId = getDeviceId();
    });

    const otherSessions = $derived(sessions.filter((s) => !isThisDevice(s)));
    const olderIds = $derived(olderSessionIds(sessions));

    const KIND_ICONS: Record<DeviceKind, IconSource> = {
        tv: Tv,
        mobile: DevicePhoneMobile,
        web: ComputerDesktop,
        integration: PuzzlePiece,
        unknown: DevicePhoneMobile,
    };

    /**
     * getDeviceId() is the browser's localStorage *device_id*. This used to compare
     * it against deviceSessionId, which only matched because the web client happens
     * to reuse one value as the other — it was never true for a TV or a phone. Now
     * that the API returns deviceId, compare like with like and fall back to the old
     * comparison for sessions issued without a device_id.
     */
    function isThisDevice(s: UserDeviceInfo): boolean {
        if (!thisDeviceId) return false;
        return s.deviceId ? s.deviceId === thisDeviceId : s.deviceSessionId === thisDeviceId;
    }

    /** A remote makes sense for another device that is online and announces commands. */
    function canOpenRemote(s: UserDeviceInfo): boolean {
        return !!s.isOnline && !isThisDevice(s) && deviceHasCommands(s.capabilities);
    }

    function formatDate(dateStr: string | null): string {
        if (!dateStr) return m.settings_devices_never();
        return new SvelteDate(dateStr).toLocaleString();
    }

    /** "2h ago" — the full date sits in the row's title. */
    function lastActive(s: UserDeviceInfo): string {
        const at = s.lastHeartbeat ?? s.lastUsedAt;
        return at ? formatRelativeTime(at) : m.settings_devices_never();
    }

    async function revokeDevice(id: string, name: string | null): Promise<void> {
        revokingDevice = id;
        try {
            const { error } = await userApi.deleteDevice(id);
            if (!error) {
                sessions = sessions.filter((s) => s.deviceSessionId !== id);
                liveMessage = m.settings_devices_signed_out_one({
                    name: name || m.settings_devices_device(),
                });
                toasts.success(
                    m.settings_devices_logged_out_toast({
                        name: name || m.settings_devices_unknown_device(),
                    }),
                );
            } else {
                toasts.error(error || m.settings_devices_revoke_error());
            }
        } catch {
            toasts.error(m.settings_devices_revoke_error());
        } finally {
            revokingDevice = null;
        }
    }

    async function renameDevice(id: string, name: string | null): Promise<boolean> {
        renamingDevice = id;
        try {
            const { data, error } = await userApi.renameDevice(id, name);
            if (!error && data) {
                // Patch by device, not by session: the name lives on the device, so
                // every session sharing that device_id must show the new name.
                // Keying on deviceSessionId alone left a sibling session stale.
                sessions = sessions.map((s) =>
                    (data.deviceId && s.deviceId === data.deviceId) || s.deviceSessionId === id
                        ? { ...s, deviceName: data.deviceName, isCustomName: data.isCustomName }
                        : s,
                );
                liveMessage = data.isCustomName
                    ? m.settings_devices_renamed_toast({ name: data.deviceName ?? '' })
                    : m.settings_devices_rename_cleared_toast();
                toasts.success(liveMessage);
                return true;
            }
            toasts.error(error || m.settings_devices_rename_error());
            return false;
        } catch {
            toasts.error(m.settings_devices_rename_error());
            return false;
        } finally {
            renamingDevice = null;
        }
    }

    async function revokeAll(): Promise<void> {
        if (otherSessions.length === 0) return;
        revokingAll = true;
        try {
            const { data, error } = await userApi.deleteAllDevices();
            if (!error && (data?.failedStores.length ?? 0) === 0) {
                const kept = sessions.filter(isThisDevice);
                const removed = sessions.length - kept.length;
                sessions = kept;
                liveMessage =
                    removed === 1
                        ? m.settings_devices_signed_out_other_one()
                        : m.settings_devices_signed_out_other_many({ count: removed });
                toasts.success(
                    removed === 1
                        ? m.settings_devices_signed_out_toast_one()
                        : m.settings_devices_signed_out_toast_many({ count: removed }),
                );
            } else {
                toasts.error(error || m.settings_devices_revoke_all_error());
            }
        } catch {
            toasts.error(m.settings_devices_revoke_all_error());
        } finally {
            revokingAll = false;
        }
    }
</script>

<!-- aria-live so the trust-restoring confirmation is heard, not just optimistic -->
<div class="sr-only" aria-live="polite">{liveMessage}</div>

{#snippet othersFooter()}
    {#if otherSessions.length > 1}
        <InlineConfirm
            triggerLabel={m.settings_devices_sign_out_others_label_many({
                count: otherSessions.length,
            })}
            confirmLabel={m.settings_devices_confirm()}
            variant="error"
            busy={revokingAll}
            onConfirm={revokeAll} />
        <span class="text-xs text-surface-500">{m.settings_devices_current_session_stays()}</span>
    {/if}
{/snippet}

<!-- The footer is passed only when it has something in it; an empty one still
     reserved its margin under the card. -->
<SettingsGroup
    label={m.settings_login_devices_heading()}
    description={m.settings_devices_description()}
    footer={otherSessions.length > 1 ? othersFooter : undefined}>
    {#if sessions.length === 0}
        <p class="flex items-center gap-3 py-3 px-4 text-sm text-surface-400">
            <Icon src={DevicePhoneMobile} class="w-6 h-6 shrink-0" />
            {m.settings_devices_empty_title()}
        </p>
    {:else}
        {#each sessions as session (session.deviceSessionId)}
            {@const name = session.deviceName || m.settings_devices_unknown_device()}
            {@const app = clientLabel(session.clientId)}
            <div class="flex flex-wrap items-center justify-between py-3 px-4 gap-x-4 gap-y-2">
                <div class="flex items-center gap-3 min-w-0 flex-1 basis-56">
                    <span class="relative shrink-0">
                        <Icon
                            src={KIND_ICONS[deviceKind(session)]}
                            class="w-6 h-6 text-surface-400" />
                        {#if session.isOnline}
                            <span
                                class="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-success-500 ring-2 ring-surface-800"
                                title={m.settings_devices_online()}
                                aria-label={m.settings_devices_online()}></span>
                        {/if}
                    </span>
                    <div class="min-w-0">
                        <div class="text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span class="truncate font-medium">{name}</span>
                            {#if isThisDevice(session)}
                                <span class="badge variant-soft-primary text-xs px-1.5 py-0.5"
                                    >{m.settings_devices_this_device()}</span>
                            {/if}
                            {#if olderIds.has(session.deviceSessionId)}
                                <span
                                    class="badge text-xs px-1.5 py-0.5 bg-warning-500/15 text-warning-300"
                                    title={m.settings_devices_older_signin_hint()}
                                    >{m.settings_devices_older_signin()}</span>
                            {/if}
                        </div>
                        <p
                            class="text-xs text-surface-400 mt-0.5"
                            title={formatDate(session.lastHeartbeat ?? session.lastUsedAt)}>
                            {[
                                app,
                                session.isOnline
                                    ? m.settings_devices_online_now()
                                    : m.settings_devices_last_active({ date: lastActive(session) }),
                                session.isCustomName ? m.settings_devices_custom_name_hint() : '',
                                session.approvedByDeviceName
                                    ? m.settings_devices_approved_by({
                                          device: session.approvedByDeviceName,
                                      })
                                    : '',
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </p>
                    </div>
                </div>
                <div class="flex flex-wrap items-center justify-end gap-2 shrink-0 max-w-full">
                    {#if canOpenRemote(session)}
                        <button
                            type="button"
                            class="btn btn-sm variant-soft-surface"
                            aria-label={m.device_remote_open_label({ device: name })}
                            onclick={() => (remoteFor = session)}>
                            {m.device_remote_button()}
                        </button>
                    {/if}
                    {#if session.deviceId}
                        <DeviceNameEditor
                            deviceName={session.deviceName}
                            isCustomName={session.isCustomName}
                            canRename
                            busy={renamingDevice === session.deviceSessionId}
                            onSave={(next) => renameDevice(session.deviceSessionId, next)} />
                    {/if}
                    {#if isThisDevice(session)}
                        <span class="text-xs text-surface-500">{m.settings_devices_current()}</span>
                    {:else}
                        <InlineConfirm
                            triggerLabel={m.settings_devices_log_out()}
                            ariaLabel={m.settings_devices_log_out_label({ name })}
                            confirmLabel={m.settings_devices_confirm()}
                            busy={revokingDevice === session.deviceSessionId}
                            onConfirm={() =>
                                revokeDevice(session.deviceSessionId, session.deviceName)} />
                    {/if}
                </div>
            </div>
        {/each}
    {/if}
</SettingsGroup>

{#if remoteFor}
    <DeviceRemote
        deviceSessionId={remoteFor.deviceSessionId}
        deviceName={remoteFor.deviceName || m.settings_devices_unknown_device()}
        onClose={() => (remoteFor = null)} />
{/if}
