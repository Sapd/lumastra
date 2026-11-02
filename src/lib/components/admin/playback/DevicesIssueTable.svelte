<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    export interface DeviceWithIssue {
        device_id: string;
        device_name: string | null;
        client_type: string | null;
        user_agent: string | null;
        is_mobile: boolean | null;
        /** Device class (mobile/tablet/tv/desktop/unknown); absent on older servers. */
        form_factor?: string | null;
        total_sessions: number;
        avg_health_score: number;
        rebuffers: number;
        live_sessions: number;
        vod_sessions: number;
    }
</script>

<script lang="ts">
    import HealthScoreBadge from './badges/HealthScoreBadge.svelte';
    import FormFactorIcon from './badges/FormFactorIcon.svelte';
    import SessionDetailDrawer from './SessionDetailDrawer.svelte';
    import SortableHeader, { type SortDirection } from './SortableHeader.svelte';
    import {
        getFriendlyDeviceName,
        getClientTypeLabel,
        getFormFactorLabel,
    } from '$lib/utils/admin/playback-formatters';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        devices: DeviceWithIssue[];
    }

    let { devices }: Props = $props();

    type SortKey = 'name' | 'sessions' | 'health' | 'rebuffers';

    let sortKey = $state<SortKey>('health');
    let sortDir = $state<SortDirection>('asc');

    function formFactorOf(device: DeviceWithIssue): string {
        return device.form_factor ?? (device.is_mobile ? 'mobile' : 'unknown');
    }

    function nameOf(device: DeviceWithIssue): string {
        return getFriendlyDeviceName(device.device_name, device.client_type);
    }

    function sortValue(device: DeviceWithIssue, key: SortKey): number | string {
        switch (key) {
            case 'name':
                return nameOf(device).toLowerCase();
            case 'sessions':
                return device.total_sessions;
            case 'health':
                return device.avg_health_score ?? Number.POSITIVE_INFINITY;
            case 'rebuffers':
                return device.rebuffers;
        }
    }

    let sortedDevices = $derived(
        [...devices].sort((a, b) => {
            const va = sortValue(a, sortKey);
            const vb = sortValue(b, sortKey);
            const cmp =
                typeof va === 'string' && typeof vb === 'string'
                    ? va.localeCompare(vb)
                    : Number(va) - Number(vb);
            return sortDir === 'asc' ? cmp : -cmp;
        }),
    );

    function sortBy(key: SortKey): void {
        if (sortKey === key) {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            return;
        }
        sortKey = key;
        sortDir = key === 'health' || key === 'name' ? 'asc' : 'desc';
    }

    function directionFor(key: SortKey): SortDirection | null {
        return sortKey === key ? sortDir : null;
    }

    let openDeviceId = $state<string | null>(null);

    function openDrawer(deviceId: string): void {
        openDeviceId = deviceId;
    }

    function closeDrawer(): void {
        openDeviceId = null;
    }
</script>

{#if openDeviceId !== null}
    {@const device = devices.find((d) => d.device_id === openDeviceId)}
    <SessionDetailDrawer
        endpoint="/api/admin/playback-quality/device/{encodeURIComponent(openDeviceId)}"
        label={device ? nameOf(device) : openDeviceId}
        onclose={closeDrawer} />
{/if}

<div class="bg-surface-800/50 border border-surface-700 rounded-xl overflow-x-auto">
    <table class="w-full min-w-[40rem]">
        <thead class="bg-surface-700/50">
            <tr>
                <SortableHeader
                    label={m.admin_pbquality_col_device()}
                    align="left"
                    direction={directionFor('name')}
                    onsort={() => sortBy('name')} />
                <th scope="col" class="text-left px-4 py-3 text-surface-400 font-medium">
                    {m.admin_pbquality_col_player()}
                </th>
                <SortableHeader
                    label={m.admin_quality_sessions()}
                    direction={directionFor('sessions')}
                    onsort={() => sortBy('sessions')} />
                <SortableHeader
                    label={m.admin_pbquality_col_health()}
                    direction={directionFor('health')}
                    onsort={() => sortBy('health')} />
                <SortableHeader
                    label={m.admin_quality_rebuffers()}
                    direction={directionFor('rebuffers')}
                    onsort={() => sortBy('rebuffers')} />
            </tr>
        </thead>
        <tbody class="divide-y divide-surface-700">
            {#each sortedDevices as device (device.device_id)}
                {@const isOpen = openDeviceId === device.device_id}
                {@const name = nameOf(device)}
                {@const formFactor = formFactorOf(device)}
                <tr
                    class="hover:bg-surface-700/30 transition-colors focus-within:bg-surface-700/30">
                    <td class="px-4 py-3">
                        <button
                            class="text-left w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded"
                            onclick={() => openDrawer(device.device_id)}
                            aria-expanded={isOpen}
                            aria-label={m.admin_pbquality_view_sessions_for({ name })}>
                            <div class="font-medium flex items-center gap-2">
                                <FormFactorIcon {formFactor} />
                                <span class="truncate max-w-xs" title={device.device_name ?? name}
                                    >{name}</span>
                            </div>
                            <div class="text-xs text-surface-500 mt-0.5 flex items-center gap-2">
                                <span>{getFormFactorLabel(formFactor)}</span>
                                <span
                                    class="font-mono truncate max-w-[10rem]"
                                    title={device.device_id}>{device.device_id.slice(0, 12)}…</span>
                            </div>
                        </button>
                    </td>
                    <td class="px-4 py-3 text-sm text-surface-300">
                        {device.client_type ? getClientTypeLabel(device.client_type) : '—'}
                        {#if device.live_sessions > 0}
                            <div class="text-xs text-surface-500">
                                {m.admin_pbquality_n_live_sessions({ count: device.live_sessions })}
                            </div>
                        {/if}
                    </td>
                    <td class="px-4 py-3 text-center tabular-nums">{device.total_sessions}</td>
                    <td class="px-4 py-3 text-center">
                        <HealthScoreBadge score={device.avg_health_score} variant="text" />
                    </td>
                    <td class="px-4 py-3 text-center tabular-nums">
                        <span class={device.rebuffers > 0 ? 'text-orange-400' : ''}>
                            {device.rebuffers}
                        </span>
                    </td>
                </tr>
            {/each}
        </tbody>
    </table>
</div>
