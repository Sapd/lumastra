<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import * as m from '$lib/paraglide/messages';

    const context = $derived($musicPlayerStore.playbackContext);
    const eligible = $derived(
        Boolean($musicPlayerStore.currentTrack) &&
            !$musicPlayerStore.currentTrack?.isRadio &&
            !$musicPlayerStore.autoplaySeed &&
            (context !== null || $musicPlayerStore.queue.some((item) => item.source === 'user')),
    );
    const remaining = $derived(
        $musicPlayerStore.queue.filter((item) =>
            context?.type === 'album'
                ? item.sessionId === context.sessionId
                : item.source === 'user',
        ).length,
    );
</script>

{#if eligible}
    <div
        class="flex flex-wrap items-center justify-between gap-3 border-b border-primary-500/30 bg-primary-500/5 px-4 py-3">
        <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-primary-300">
                {context?.name ?? m.music_queue_view_label()}
            </p>
            <p class="text-xs text-surface-400">
                {#if context?.type === 'album' && remaining === 0}
                    {m.music_queue_last_track()}
                {:else}
                    {m.music_queue_tracks_remaining({ count: remaining })}
                {/if}
            </p>
        </div>
        <button
            class="shrink-0 rounded-md bg-primary-500/20 px-3 py-2 text-xs font-medium text-primary-300 transition-colors hover:bg-primary-500/30 hover:text-primary-200"
            onclick={() => musicPlayerStore.switchToSmartQueue()}>
            {m.music_queue_smart_queue()}
        </button>
    </div>
    {#if context && 'href' in context && context.href}
        <a class="block px-4 py-2 text-sm text-primary-400" href={context.href}>Open mix</a>
    {/if}
{/if}
