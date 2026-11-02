<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        size?: 'sm' | 'md';
    }

    let { size = 'sm' }: Props = $props();

    const sizeClasses = $derived(size === 'md' ? 'px-2 py-1 text-xs' : 'px-1.5 py-0.5 text-[10px]');
</script>

<span
    class="inline-flex items-center rounded-full bg-green-500 font-bold leading-none text-white {sizeClasses}"
    aria-label={m.temporal_live_aria()}>{m.temporal_live()}</span>
