<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        getPlayMethodLabel,
        getPlayMethodColor,
        getPlayMethodBg,
    } from '$lib/utils/admin/playback-formatters';

    interface Props {
        method: string;
    }

    let { method }: Props = $props();

    let label = $derived(getPlayMethodLabel(method));
    let colorClass = $derived(getPlayMethodColor(method));
    let bgClass = $derived(getPlayMethodBg(method));
</script>

<span class="px-2 py-1 rounded-full text-xs border {bgClass} {colorClass}">
    {label}
</span>
