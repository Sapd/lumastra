<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Reset layout - bypass root layout for maximum performance
    // This page only needs the video player, nothing else.
    //
    // ToastContainer used to be mounted here as well, but the root
    // +layout.svelte still mounts one alongside this @-reset layout —
    // SvelteKit renders both and toasts duplicated. The root's container
    // is sufficient for /watch/* too.
    import '../../../app.css';
    interface Props {
        children?: import('svelte').Snippet;
    }

    let { children }: Props = $props();
</script>

{@render children?.()}
