<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->
<!-- Test stand-in for Tooltip: renders the wrapped trigger, no tooltip. -->
<script lang="ts">
    import type { Snippet } from 'svelte';

    let { children }: { children?: Snippet; [key: string]: unknown } = $props();
</script>

{@render children?.()}
