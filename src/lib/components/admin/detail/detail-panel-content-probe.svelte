<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

Test fixture for DetailPanel.svelte.test.ts — reports its own mount/destroy
so the test can assert the shell never remounts tab content on an unrelated
prop change (the "SSE-patch-safe" contract: only genuinely new content
remounts, never a re-render of the same object).
-->
<script lang="ts">
    import { onMount, onDestroy } from 'svelte';

    interface Props {
        tab: string;
        onContentMount?: () => void;
        onContentDestroy?: () => void;
    }

    let { tab, onContentMount, onContentDestroy }: Props = $props();

    onMount(() => onContentMount?.());
    onDestroy(() => onContentDestroy?.());
</script>

<div data-testid="tab-content">{tab}</div>
