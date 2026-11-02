<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
  Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
-->

<script lang="ts">
    import '$lib/components/app-shell';
    import type { Snippet } from 'svelte';

    let { children }: { children: Snippet } = $props();
</script>

{@render children()}
