<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<!--
  Declarative bridge into the shared modal stack: while this component is
  mounted, MixPreviewCard is open in ModalContainer — the same shell as the
  album/artist modals (blurred backdrop, click-outside + Escape to close, focus
  trap, mini-player-aware sizing, correct stacking with other modals).

  Callers keep their `{#if preview}<MixPreview … />{/if}` shape: unmounting
  closes the modal, and a close from inside the modal (X, backdrop, Escape)
  calls `onclose` so the caller can clear its state / URL.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { modals } from '$lib/stores/modal.store';
    import type MixPreviewCard from './MixPreviewCard.svelte';
    import DeferredMixPreviewCard from './DeferredMixPreviewCard.svelte';

    type CardProps = Omit<import('svelte').ComponentProps<typeof MixPreviewCard>, 'modalId'>;

    const props: CardProps = $props();

    onMount(() => {
        let settled = false;
        // The live props object is handed to the stack as-is: ModalContainer
        // spreads it, so loading → tracks → error updates reach the card.
        const { id } = modals.open(DeferredMixPreviewCard, props, {
            kind: 'music',
            ariaLabel: props.title,
            onClosed: () => {
                if (settled) return;
                settled = true;
                props.onclose();
            },
        });
        return () => {
            if (settled) return;
            settled = true;
            void modals.closeById(id);
        };
    });
</script>
