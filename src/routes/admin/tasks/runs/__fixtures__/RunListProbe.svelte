<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { untrack } from 'svelte';
    let {
        taskId,
        sinceWindow,
        stateFilter,
        onSinceWindowChange,
    }: {
        taskId?: string;
        sinceWindow?: string;
        stateFilter?: string[];
        onSinceWindowChange?: (value: '7d') => void;
    } = $props();
    const mountedTask = untrack(() => taskId);
</script>

<p data-testid="run-list">{JSON.stringify({ taskId, mountedTask, sinceWindow, stateFilter })}</p>
<button onclick={() => onSinceWindowChange?.('7d')}>Seven days</button>
