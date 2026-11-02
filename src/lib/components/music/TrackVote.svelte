<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  TrackVote — reusable thumbs-up / thumbs-down affordance for music tracks.

  Accepts a trackId (internal UUID) and optional initial feedback state.
  Writes explicit feedback through /api/me/music/tracks/{id}/feedback.
  Shows optimistic UI immediately, reverts on error, and fires a toast.

  Usage:
    <TrackVote trackId="uuid" initialFeedback={null} />

  The vote is reflected on the next on-demand sonic taste computation
  automatically — no extra wiring required.
-->

<script lang="ts">
    import { Icon, Heart, HandThumbDown } from 'svelte-hero-icons';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';

    // ── Props ────────────────────────────────────────────────────────────────

    interface Props {
        /** Internal UUID of the track (media_items.id) */
        trackId: string;
        /** Externally-known feedback state (e.g. loaded from server) */
        initialFeedback?: 'liked' | 'disliked' | null;
        /**
         * Size variant.
         * 'sm'  = h-4 w-4 icons, p-1 buttons  (queue items, compact rows)
         * 'md'  = h-5 w-5 icons, p-1.5 buttons (sound-alike modal rows)
         */
        size?: 'sm' | 'md';
        /** Stop click propagation so parent row onClick is not triggered */
        stopPropagation?: boolean;
    }

    let { trackId, initialFeedback = null, size = 'sm', stopPropagation = true }: Props = $props();

    // ── Local state ──────────────────────────────────────────────────────────

    /**
     * Local override: set when the user votes in this session.
     * null = fall back to initialFeedback (server-side value).
     */
    let localFeedback = $state<'liked' | 'disliked' | null | 'unset'>('unset');
    let loading = $state(false);

    /** Effective feedback: local override wins over initialFeedback prop */
    const feedback = $derived<'liked' | 'disliked' | null>(
        localFeedback === 'unset' ? (initialFeedback ?? null) : localFeedback,
    );

    // ── Derived classes ──────────────────────────────────────────────────────

    const iconClass = $derived(size === 'md' ? 'h-5 w-5' : 'h-4 w-4');
    const btnClass = $derived(size === 'md' ? 'rounded p-1.5' : 'rounded p-1');

    // ── Handlers ─────────────────────────────────────────────────────────────

    async function vote(direction: 'liked' | 'disliked', e?: MouseEvent): Promise<void> {
        if (stopPropagation && e) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (loading) return;

        const currentFeedback = feedback;
        // Toggle off if already in this state
        const next: 'liked' | 'disliked' | null = currentFeedback === direction ? null : direction;

        // Optimistic update
        localFeedback = next;
        loading = true;

        try {
            const { setTrackFeedback, clearTrackFeedback } =
                await import('$lib/api/music');
            if (next === 'liked') {
                const result = await setTrackFeedback(trackId, 'liked');
                if (result.error) throw new Error(result.error);
                toasts.success(m.toast_track_liked());
            } else if (next === 'disliked') {
                const result = await setTrackFeedback(trackId, 'disliked');
                if (result.error) throw new Error(result.error);
                toasts.success(m.toast_track_disliked());
            } else {
                const result = await clearTrackFeedback(trackId);
                if (result.error) throw new Error(result.error);
            }
        } catch (err) {
            console.warn('[TrackVote] vote failed', err);
            // Revert optimistic update to the value before we changed it
            localFeedback = currentFeedback;
            toasts.error('Could not record vote — try again');
        } finally {
            loading = false;
        }
    }
</script>

<div class="flex shrink-0 items-center gap-0.5">
    <Tooltip text={m.music_like_track_aria()} position="top">
        <button
            type="button"
            class="{btnClass} transition-colors {feedback === 'liked'
                ? 'text-primary-400'
                : 'text-surface-500 hover:text-white'} disabled:cursor-not-allowed disabled:opacity-40"
            onclick={(e) => vote('liked', e)}
            disabled={loading}
            aria-label={m.music_like_track_aria()}
            aria-pressed={feedback === 'liked'}>
            <Icon src={Heart} class={iconClass} solid={feedback === 'liked'} />
        </button>
    </Tooltip>
    <Tooltip text={m.music_dislike_track_aria()} position="top">
        <button
            type="button"
            class="{btnClass} transition-colors {feedback === 'disliked'
                ? 'text-red-400'
                : 'text-surface-500 hover:text-white'} disabled:cursor-not-allowed disabled:opacity-40"
            onclick={(e) => vote('disliked', e)}
            disabled={loading}
            aria-label={m.music_dislike_track_aria()}
            aria-pressed={feedback === 'disliked'}>
            <Icon src={HandThumbDown} class={iconClass} solid={feedback === 'disliked'} />
        </button>
    </Tooltip>
</div>
