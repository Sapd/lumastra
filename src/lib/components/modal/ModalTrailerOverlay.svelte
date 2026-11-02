<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * Full-bleed trailer overlay mounted over the modal's hero/poster region.
     *
     * Prefers the item's local trailer file (played through the shared
     * preview-session pipeline, sound on); falls back to the YouTube trailer
     * URL when no local trailer exists or the local attempt fails/errors.
     * Claims exclusive preview audio for as long as it's mounted and releases
     * it on unmount (including when the whole modal closes mid-playback).
     */
    import { untrack } from 'svelte';
    import MediaPreviewPlayer from '$lib/components/ui/MediaPreviewPlayer.svelte';
    import { previewAudio, nextPreviewAudioId } from '$lib/stores/preview-audio.svelte';
    import { trailerOverlay } from '$lib/stores/trailer-overlay.svelte';
    import { youtube_parser } from '../../../utility';

    interface Props {
        /** Internal UUID of the PARENT item (movie/series) */
        internalId: string;
        hasLocalTrailer: boolean;
        trailerUrl?: string;
        onClose: () => void;
        /** Open the LOCAL trailer in the full video player (real controls,
         *  seeking, fullscreen). Receives the trailer child's own item UUID.
         *  Button only renders for the local-trailer branch when provided. */
        onOpenInPlayer?: (trailerItemId: string) => void;
    }

    let { internalId, hasLocalTrailer, trailerUrl, onClose, onOpenInPlayer }: Props = $props();

    // The trailer child's own UUID, resolved server-side and reported back by
    // the preview session — needed to hand the FULL player a playable id.
    let trailerItemId = $state<string | null>(null);

    const audioId = nextPreviewAudioId('modal-trailer');
    // Local trailer failed/absent mid-flight → try YouTube in place.
    let useYouTube = $state(false);
    let youtubeId = $derived(trailerUrl ? youtube_parser(trailerUrl) : false);

    $effect(() => {
        if (!hasLocalTrailer) useYouTube = true;
    });

    $effect(() => {
        // untrack: `opened()` increments the store's $state counter — a
        // read-modify-write. Without untrack the effect DEPENDS on the very
        // counter it increments and re-triggers itself forever
        // (effect_update_depth_exceeded, killed all reactivity on open).
        untrack(() => {
            trailerOverlay.opened();
            // Explicit user action: trailer sound owns the exclusive audio slot.
            previewAudio.claim(audioId);
        });
        return () => {
            untrack(() => {
                previewAudio.release(audioId);
                trailerOverlay.closed();
            });
        };
    });

    // Defensive: if the YouTube branch is selected but the URL didn't parse
    // to a valid video id, neither template branch below would render
    // anything — a blank black overlay with no way out but the close
    // button hiding behind it. Close automatically instead. Guarded to fire
    // once so it doesn't loop if state changes after close is requested.
    let closedForUnparseableUrl = false;
    $effect(() => {
        if (useYouTube && youtubeId === false && !closedForUnparseableUrl) {
            closedForUnparseableUrl = true;
            onClose();
        }
    });

    function fallbackOrClose() {
        if (!useYouTube && youtubeId) {
            useYouTube = true;
        } else {
            onClose();
        }
    }
</script>

<div class="absolute inset-0 z-20 bg-black">
    {#if !useYouTube}
        <MediaPreviewPlayer
            itemId={internalId}
            {internalId}
            startPositionSeconds={0}
            trailerPreferred={true}
            trailerRequired={true}
            muted={false}
            audioOwnerId={audioId}
            loop={false}
            objectFit="contain"
            onSessionResolved={(id) => (trailerItemId = id)}
            onNoTrailer={fallbackOrClose}
            onError={fallbackOrClose}
            onEnded={onClose}
            onExpire={onClose} />
    {:else if youtubeId}
        <iframe
            class="h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0`}
            title="Trailer"
            allow="autoplay; encrypted-media"
            allowfullscreen></iframe>
    {/if}
    {#if !useYouTube && trailerItemId && onOpenInPlayer}
        <button
            type="button"
            class="absolute right-14 top-3 z-30 rounded-full bg-surface-900/50 p-2 text-surface-300 backdrop-blur-sm transition-colors hover:bg-surface-600/80 hover:text-surface-100"
            aria-label="Open trailer in full player"
            title="Open in full player"
            onclick={() => onOpenInPlayer(trailerItemId!)}>
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M4 8V6a2 2 0 012-2h2M4 16v2a2 2 0 002 2h2m8-16h2a2 2 0 012 2v2m-4 12h2a2 2 0 002-2v-2" />
            </svg>
        </button>
    {/if}
    <button
        type="button"
        class="absolute right-3 top-3 z-30 rounded-full bg-surface-900/50 p-2 text-surface-300 backdrop-blur-sm transition-colors hover:bg-surface-600/80 hover:text-surface-100"
        aria-label="Close trailer"
        onclick={onClose}>
        <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12" />
        </svg>
    </button>
</div>
