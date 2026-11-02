<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { DeviceStats } from '$lib/types/personal-stats';
    import {
        Icon,
        DeviceTablet,
        ComputerDesktop,
        DevicePhoneMobile,
        Tv,
        QuestionMarkCircle,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        data: DeviceStats;
    }

    let { data }: Props = $props();

    const DISPLAY_LIMIT = 5;

    type Device = DeviceStats['devices'][number];

    // The server classifies each device (formFactor, shared with the playback
    // admin's classifier). The name heuristics below remain only as a fallback
    // for a payload without it; they called every unrecognised name "desktop".
    function iconFor(device: Device) {
        switch (device.formFactor) {
            case 'tv':
                return Tv;
            case 'tablet':
                return DeviceTablet;
            case 'mobile':
                return DevicePhoneMobile;
            case 'desktop':
                return ComputerDesktop;
            case 'unknown':
                return QuestionMarkCircle;
            default:
                return getDeviceIcon(device.clientName, device.deviceName);
        }
    }

    function typeLabelFor(device: Device): string {
        switch (device.formFactor) {
            case 'tv':
                return m.stats_devices_type_tv();
            case 'tablet':
                return m.stats_devices_type_tablet();
            case 'mobile':
                return m.stats_devices_type_phone();
            case 'desktop':
                return m.stats_devices_type_desktop();
            case 'unknown':
                return m.stats_devices_type_unknown();
            default:
                return getDeviceTypeLabel(device.clientName, device.deviceName);
        }
    }

    // Get icon for device type — tablet/iPad checked before android to avoid android tablet → phone icon
    function getDeviceIcon(clientName: string, deviceName: string) {
        const combined = `${clientName} ${deviceName}`.toLowerCase();
        if (
            combined.includes('tv') ||
            combined.includes('apple tv') ||
            combined.includes('android tv')
        ) {
            return Tv;
        }
        if (combined.includes('ipad') || combined.includes('tablet')) {
            return DeviceTablet;
        }
        if (
            combined.includes('iphone') ||
            combined.includes('android') ||
            combined.includes('mobile')
        ) {
            return DevicePhoneMobile;
        }
        return ComputerDesktop;
    }

    function getDeviceTypeLabel(clientName: string, deviceName: string): string {
        const combined = `${clientName} ${deviceName}`.toLowerCase();
        if (
            combined.includes('tv') ||
            combined.includes('apple tv') ||
            combined.includes('android tv')
        ) {
            return m.stats_devices_type_tv();
        }
        if (combined.includes('ipad') || combined.includes('tablet')) {
            return m.stats_devices_type_tablet();
        }
        if (
            combined.includes('iphone') ||
            combined.includes('android') ||
            combined.includes('mobile')
        ) {
            return m.stats_devices_type_phone();
        }
        return m.stats_devices_type_desktop();
    }

    // Get color based on index — cyan-300 for better contrast (cyan-400 was borderline ~4.0:1)
    function getColor(index: number): string {
        const colors = [
            'text-blue-400',
            'text-purple-400',
            'text-cyan-300',
            'text-green-400',
            'text-orange-400',
        ];
        return colors[index % colors.length];
    }

    function getBarColor(index: number): string {
        const colors = [
            'bg-blue-500',
            'bg-purple-500',
            'bg-cyan-500',
            'bg-green-500',
            'bg-orange-500',
        ];
        return colors[index % colors.length];
    }

    function resolveClientName(name: string): string {
        return name === 'Unknown' ? m.stats_devices_unknown_client() : name;
    }

    function resolveDeviceName(name: string): string {
        return name === 'Unknown' ? m.stats_devices_unknown_device() : name;
    }

    const visibleDevices = $derived(data.devices.slice(0, DISPLAY_LIMIT));
    const hiddenCount = $derived(data.devices.length - visibleDevices.length);
</script>

<div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
    <div class="between mb-4">
        <div>
            <h3 class="text-lg font-bold text-white">
                {m.stats_devices_title()}
            </h3>
            <p class="text-muted">
                {m.stats_devices_count({ count: data.deviceCount })}
            </p>
        </div>
    </div>

    {#if data.devices.length === 0}
        <p class="text-muted text-sm">{m.stats_devices_no_data()}</p>
    {:else}
        <div class="space-y-4">
            {#each visibleDevices as device, index (`${device.clientName}-${device.deviceName}-${index}`)}
                {@const clientLabel = resolveClientName(device.clientName)}
                {@const deviceLabel = resolveDeviceName(device.deviceName)}
                {@const typeLabel = typeLabelFor(device)}
                <div>
                    <div class="between mb-1">
                        <div class="flex items-center gap-2 min-w-0">
                            <Icon
                                src={iconFor(device)}
                                class="w-4 h-4 {getColor(index)} shrink-0"
                                aria-hidden="true" />
                            <span class="sr-only">{typeLabel}:</span>
                            <span class="text-subtitle truncate">{clientLabel}</span>
                            {#if device.deviceName !== 'Unknown'}
                                <span class="text-caption truncate" title={deviceLabel}
                                    >{deviceLabel}</span>
                            {/if}
                        </div>
                        <div class="flex items-center gap-2 text-sm shrink-0">
                            <span class="text-gray-500">{device.totalFormatted}</span>
                            <span class="{getColor(index)} font-medium w-10 text-right"
                                >{device.percentage}%</span>
                        </div>
                    </div>
                    <div
                        class="w-full bg-gray-700 rounded-full h-2"
                        role="progressbar"
                        aria-valuenow={device.percentage}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={m.stats_devices_bar_label({
                            client: clientLabel,
                            device: deviceLabel,
                            percentage: device.percentage,
                        })}>
                        <div
                            class="{getBarColor(
                                index,
                            )} h-2 rounded-full transition-all duration-500"
                            style="width: {device.percentage}%">
                        </div>
                    </div>
                </div>
            {/each}

            {#if hiddenCount > 0}
                <p class="text-caption text-sm">
                    {m.stats_devices_and_more({ count: hiddenCount })}
                </p>
            {/if}
        </div>
    {/if}
</div>
