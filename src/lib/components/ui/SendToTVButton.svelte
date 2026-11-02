<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * SendToTVButton - Send media to another device (TV)
     *
     * Features:
     * - Only shows when at least one online device announces `media.play`
     * - Loads devices asynchronously (doesn't block parent)
     * - Shows device picker popup when clicked
     * - Sends a `media.play` command and follows its status
     *   (design: docs/superpowers/specs/2026-10-16-device-remote-control-design.md)
     */
    import { onDestroy, onMount } from 'svelte';
    import { Icon, Tv, Check } from 'svelte-hero-icons';
    import { popup, type PopupSettings } from '$lib/utils/popup';
    import { Z } from '$lib/utils/z-index';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';
    import * as userApi from '$lib/api/user';
    import * as deviceApi from '$lib/api/device-commands';
    import { trackDeviceCommand } from '$lib/utils/device-command-tracker';
    import {
        commandFailureMessage,
        commandFailureOf,
        deviceSupports,
        isSettled,
        isSuccessful,
        mediaPlayKind,
    } from '$lib/utils/device-remote';
    import type { UserDeviceInfo } from '$lib/schemas/api-user-responses';

    interface Props {
        // Props - Media data
        itemId: string;
        title: string;
        mediaType?: string;
    }

    let { itemId, title, mediaType = 'movie' }: Props = $props();

    // Internal state
    let devices: UserDeviceInfo[] = $state([]);
    let sending = $state(false);
    let sentToDevice = $state<string | null>(null);
    let hasCheckedDevices = $state(false);

    const abort = new AbortController();
    let resetTimer: ReturnType<typeof setTimeout> | null = null;

    // Unique instance ID to prevent popup collisions when same itemId appears multiple times
    const instanceId = Math.random().toString(36).substring(2, 9);
    let popupId = $derived(`send-to-tv-${itemId}-${instanceId}`);
    let popupSettings = $derived<PopupSettings>({
        event: 'click',
        target: popupId,
        placement: 'top',
    });

    let kind = $derived(mediaPlayKind(mediaType));

    // Fetch online devices (non-blocking)
    async function fetchDevices() {
        try {
            const { data, error: devicesError } = await userApi.getDevices({
                onlineOnly: true,
            });
            if (!devicesError && data) {
                devices = data.items;
            }
        } catch (err) {
            console.error('Failed to fetch devices:', err);
            devices = [];
        } finally {
            hasCheckedDevices = true;
        }
    }

    // Send media to device and follow what the device does with it
    async function sendToDevice(deviceSessionId: string, deviceName: string) {
        if (!kind || sending) return;
        try {
            sending = true;
            const result = await deviceApi.sendDeviceCommand(deviceSessionId, {
                type: 'media.play',
                args: { kind, itemId, mode: 'play', resume: true },
            });

            if (result.error || !result.data) {
                toasts.error(commandFailureMessage(commandFailureOf(result), deviceName));
                return;
            }

            sentToDevice = deviceSessionId;
            const command = result.data.command;
            let lastStatus = command.status;
            const settled = await trackDeviceCommand(command, {
                onUpdate: (c) => (lastStatus = c.status),
                poll: async () =>
                    (await deviceApi.getDeviceCommand(deviceSessionId, command.id)).data,
                signal: abort.signal,
            });
            if (abort.signal.aborted) return;

            // The tracker answers with the last command it saw on a timeout, so
            // only a settled one is a verdict; an unsettled one is still on its way.
            if (settled && isSuccessful(settled)) {
                toasts.success(m.send_to_tv_playing_on({ device: deviceName }));
            } else if (settled && isSettled(settled)) {
                toasts.error(m.send_to_tv_error());
            } else if (lastStatus === 'pending') {
                toasts.info(m.send_to_tv_waiting({ device: deviceName }));
            } else {
                toasts.success(m.send_to_tv_success({ device: deviceName }));
            }
        } catch (err) {
            console.error('Failed to send to device:', err);
            toasts.error(m.send_to_tv_error());
        } finally {
            sending = false;
            resetTimer = setTimeout(() => {
                sentToDevice = null;
                // Refresh device list in case status changed
                fetchDevices();
            }, 2000);
        }
    }

    // Fetch devices on mount (non-blocking)
    onMount(() => {
        fetchDevices();
    });

    onDestroy(() => {
        abort.abort();
        if (resetTimer) clearTimeout(resetTimer);
    });

    // Derived - online devices that announce `media.play`
    let targets = $derived(
        devices.filter((d) => d.isOnline !== false && deviceSupports(d.capabilities, 'media.play')),
    );
    let showButton = $derived(hasCheckedDevices && kind !== null && targets.length > 0);
</script>

{#if showButton}
    <button
        class="btn variant-ghost-surface center w-9 h-9 !p-0 rounded-full"
        use:popup={popupSettings}
        title={m.send_to_tv()}
        aria-label={m.send_to_tv()}>
        <Icon src={Tv} class="w-5 h-5" aria-hidden="true" />
    </button>

    <!-- Device picker popup -->
    <div class="card p-4 shadow-xl max-w-xs" style="z-index: {Z.NAV_POPUP}" data-popup={popupId}>
        <div class="space-y-3">
            <h4 class="font-semibold text-sm">
                {m.send_to_tv_select_device()}
            </h4>

            {#if targets.length === 0}
                <p class="text-sm text-surface-400">
                    {m.send_to_tv_no_devices()}
                </p>
            {:else}
                <div class="space-y-2">
                    {#each targets as device (device.deviceSessionId)}
                        <button
                            class="w-full btn variant-soft-surface between gap-2 text-left"
                            onclick={() =>
                                sendToDevice(
                                    device.deviceSessionId,
                                    device.deviceName || m.party_unknown_tv(),
                                )}
                            disabled={sending}>
                            <div class="flex items-center gap-2 min-w-0">
                                <Icon src={Tv} class="w-4 h-4 shrink-0" />
                                <span class="truncate"
                                    >{device.deviceName || m.party_unknown_tv()}</span>
                            </div>
                            {#if sentToDevice === device.deviceSessionId}
                                <Icon src={Check} class="w-4 h-4 text-success-500 shrink-0" />
                            {:else if sending}
                                <span class="loading-spinner w-4 h-4 shrink-0"></span>
                            {/if}
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
        <div class="arrow bg-surface-100 dark:bg-surface-800"></div>
    </div>
{/if}
