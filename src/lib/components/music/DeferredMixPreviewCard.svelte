<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import type { ComponentProps } from 'svelte';
    import type MixPreviewCard from './MixPreviewCard.svelte';
    import { modals } from '$lib/stores/modal.store';
    import * as m from '$lib/paraglide/messages';
    import DeferredWidget from '$lib/components/ui/DeferredWidget.svelte';
    const props: ComponentProps<typeof MixPreviewCard> = $props();
    function close(): void {
        if (props.modalId) void modals.closeById(props.modalId);
        else props.onclose();
    }
</script>

<!-- The modal host opens immediately, preserving Escape/backdrop/focus while loading. -->
<DeferredWidget load={() => import('./MixPreviewCard.svelte')} minHeight="300px">
    {#snippet controls()}
        <button
            type="button"
            class="btn variant-soft float-right"
            aria-label={m.btn_close()}
            onclick={close}>{m.btn_close()}</button>
    {/snippet}
    {#snippet children(widget)}<widget.default {...props} />{/snippet}
</DeferredWidget>
