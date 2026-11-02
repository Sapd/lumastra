<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    /**
     * ControllableDevices - devices of users who granted me remote control
     * (household grant), each opening the web remote as "<device> (<owner>)".
     * Renders nothing when nobody granted me anything.
     */
    import { onMount } from 'svelte';
    import * as m from '$lib/paraglide/messages';
    import * as deviceApi from '$lib/api/device-commands';
    import { deviceHasCommands } from '$lib/utils/device-remote';
    import DeviceRemote from './DeviceRemote.svelte';
    import SettingsGroup from './SettingsGroup.svelte';

    let devices = $state<deviceApi.ControllableDevice[]>([]);
    let loadFailed = $state(false);
    let remoteFor = $state<{ id: string; label: string } | null>(null);

    function label(d: deviceApi.ControllableDevice): string {
        return m.device_controllable_name({
            device: d.deviceName || m.settings_devices_unknown_device(),
            owner: d.ownerUsername,
        });
    }

    async function load(): Promise<void> {
        try {
            const { data, error } = await deviceApi.listControllableDevices();
            if (data && !error) {
                devices = data.items;
                loadFailed = false;
            } else {
                loadFailed = true;
            }
        } catch {
            loadFailed = true;
        }
    }

    // The owner took the grant back (or the device is gone): close the remote
    // and show what is left.
    function onGone(): void {
        remoteFor = null;
        void load();
    }

    onMount(() => {
        void load();
    });
</script>

{#if loadFailed && devices.length === 0}
    <SettingsGroup
        label={m.device_controllable_title()}
        description={m.device_controllable_description()}>
        <p class="py-3 px-4 text-sm text-surface-400" role="status">
            {m.device_controllable_load_failed()}
        </p>
    </SettingsGroup>
{:else if devices.length > 0}
    <SettingsGroup
        label={m.device_controllable_title()}
        description={m.device_controllable_description()}>
        {#each devices as device (device.deviceSessionId)}
            {@const name = label(device)}
            <div class="flex items-center justify-between gap-3 py-3 px-4">
                <div class="min-w-0">
                    <p class="text-sm font-medium truncate">{name}</p>
                    {#if device.isOnline}
                        <p class="text-xs text-surface-400 mt-0.5">
                            {m.settings_devices_online_now()}
                        </p>
                    {/if}
                </div>
                {#if device.isOnline && deviceHasCommands(device.capabilities)}
                    <button
                        type="button"
                        class="btn btn-sm variant-soft-surface"
                        aria-label={m.device_remote_open_label({ device: name })}
                        onclick={() => (remoteFor = { id: device.deviceSessionId, label: name })}>
                        {m.device_remote_button()}
                    </button>
                {/if}
            </div>
        {/each}
    </SettingsGroup>
{/if}

{#if remoteFor}
    <DeviceRemote
        deviceSessionId={remoteFor.id}
        deviceName={remoteFor.label}
        onClose={() => (remoteFor = null)}
        {onGone} />
{/if}
