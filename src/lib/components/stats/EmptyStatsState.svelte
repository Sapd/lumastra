<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ChartBar, PlayCircle } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        sessionCount?: number;
        minRequired?: number;
    }

    let { sessionCount = 0, minRequired = 1 }: Props = $props();
</script>

<div class="bg-gray-800/50 rounded-xl p-8 border border-gray-700/50 text-center">
    <div class="w-16 h-16 bg-gray-700 rounded-full center mx-auto mb-4">
        <Icon src={ChartBar} class="w-8 h-8 text-gray-500" aria-hidden="true" />
    </div>

    <h3 class="text-xl font-bold text-white mb-2">{m.stats_empty_title()}</h3>

    <p class="text-gray-400 mb-6 max-w-md mx-auto">
        {#if sessionCount === 0}
            {m.stats_empty_start_watching()}
        {:else}
            {m.stats_empty_session_count({
                count: sessionCount,
                required: minRequired,
            })}
        {/if}
    </p>

    <a href={resolve('/')} class="btn btn-lg btn-blue font-medium">
        <Icon src={PlayCircle} class="w-5 h-5" />
        {m.stats_empty_start_button()}
    </a>
</div>
