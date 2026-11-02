<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import LazyMount from './LazyMount.svelte';
    import DeferredWidget from './DeferredWidget.svelte';
    let { load, onclose }: { load: () => Promise<{ text: string }>; onclose?: () => void } =
        $props();
</script>

<LazyMount minHeight="520px">
    <DeferredWidget {load} minHeight="520px">
        {#snippet controls()}
            {#if onclose}<button type="button" onclick={onclose}>Close</button>{/if}
        {/snippet}
        {#snippet children(value)}<p>{value.text}</p>{/snippet}
    </DeferredWidget>
</LazyMount>
