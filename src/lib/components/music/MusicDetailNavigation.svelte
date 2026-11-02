<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { Icon, ChevronLeft } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import MusicNavigation from './MusicNavigation.svelte';

    const { destination, label }: { destination: string; label: string } = $props();
</script>

<div class="space-y-3">
    <MusicNavigation />
    <a
        href={resolve(destination)}
        class="inline-flex min-h-11 items-center gap-1 rounded text-sm font-medium text-surface-300 transition-colors hover:text-surface-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-300">
        <Icon src={ChevronLeft} class="h-4 w-4" aria-hidden="true" />
        {label}
    </a>
</div>
