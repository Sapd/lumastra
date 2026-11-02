<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';

    interface Props {
        value?: 'AllTime' | 'LastMonth' | 'LastWeek';
        label?: string;
        color?: 'blue' | 'green' | 'purple';
        onchange?: () => void;
    }

    let { value = $bindable('AllTime'), label = '', color = 'blue', onchange }: Props = $props();

    const colorClasses = {
        blue: 'focus:ring-blue-500',
        green: 'focus:ring-green-500',
        purple: 'focus:ring-purple-500',
    };
</script>

{#if label}
    <div class="flex items-center gap-2">
        <label for="timeframe-{label}" class="text-sm font-medium text-surface-300">{label}:</label>
        <select
            id="timeframe-{label}"
            bind:value
            onchange={() => onchange?.()}
            class="bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-sm font-medium hover:bg-surface-650 transition-colors focus:ring-2 {colorClasses[
                color
            ]}">
            <option value="AllTime">🕰️ {m.admin_timeframe_all_time()}</option>
            <option value="LastMonth">📅 {m.admin_timeframe_last_month()}</option>
            <option value="LastWeek">🗓️ {m.admin_timeframe_last_week()}</option>
        </select>
    </div>
{:else}
    <select
        bind:value
        onchange={() => onchange?.()}
        aria-label={m.admin_timeframe_selector_label()}
        class="bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-sm font-medium hover:bg-surface-650 transition-colors focus:ring-2 {colorClasses[
            color
        ]}">
        <option value="AllTime">🕰️ {m.admin_timeframe_all_time()}</option>
        <option value="LastMonth">📅 {m.admin_timeframe_last_month()}</option>
        <option value="LastWeek">🗓️ {m.admin_timeframe_last_week()}</option>
    </select>
{/if}
