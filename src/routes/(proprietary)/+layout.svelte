<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import '$lib/components/app-shell';
    import type { Snippet } from 'svelte';

    let { children }: { children: Snippet } = $props();
</script>

{@render children()}
