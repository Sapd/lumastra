<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        formatHealthScore,
        getHealthScoreColor,
        getHealthScoreBg,
    } from '$lib/utils/admin/playback-formatters';

    interface Props {
        score: number | string | null | undefined;
        variant?: 'pill' | 'text';
    }

    let { score, variant = 'pill' }: Props = $props();

    let formattedScore = $derived(formatHealthScore(score));
    let colorClass = $derived(getHealthScoreColor(score));
    let bgClass = $derived(getHealthScoreBg(score));
</script>

{#if variant === 'text'}
    <span class={colorClass}>
        {formattedScore}
    </span>
{:else}
    <span class="px-2 py-1 rounded-full text-xs {bgClass} {colorClass}">
        {formattedScore}
    </span>
{/if}
