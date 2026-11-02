<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { useModalData, type ModalDataProps } from '$lib/composables/use-modal-data.svelte';
    let { value }: { value: ModalDataProps } = $props();
    const modal = useModalData(() => value, {
        getSocialEnabled: () => false,
        getIsAgeRestricted: () => true,
    });
    export function getModal() {
        return modal;
    }
</script>

<output data-testid="unwatched">{modal.modalValue.unwatchedEpisodeCount ?? 'unknown'}</output>
<output data-testid="total">{modal.modalValue.episodeCount ?? 'unknown'}</output>
<output data-testid="next">{modal.nextEpisodeId ?? 'none'}</output>
