<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    /**
     * "Crossfading into/from X" with a draining bar, for an Active Streams
     * card. The server sends the fade time left as of its response; the cards
     * poll every few seconds and a fade lasts about as long, so the bar counts
     * down locally from when the value arrived instead of jumping per poll.
     * Disappears on its own when the fade runs out. A children snippet can
     * instead use the same expiring state to integrate the cue into a card.
     */
    import type { Snippet } from 'svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        crossfade?: {
            role: 'incoming' | 'outgoing';
            otherTrack: { title: string; artistName?: string };
            remainingMs: number;
            durationMs: number;
        };
        class?: string;
        children?: Snippet<[boolean]>;
    }

    let { crossfade, class: className = '', children }: Props = $props();

    // Anchored when a value arrives: each poll delivers a new object, and the
    // pre-effect re-runs only then. `now` is reset with it so time left never
    // jumps above what the server just said.
    let anchor = $state(Date.now());
    let now = $state(Date.now());
    $effect.pre(() => {
        void crossfade;
        const t = Date.now();
        anchor = t;
        now = t;
    });
    let remainingMs = $derived(
        Math.max(0, (crossfade?.remainingMs ?? 0) - Math.max(0, now - anchor)),
    );
    let fraction = $derived(
        crossfade && crossfade.durationMs > 0 ? Math.min(1, remainingMs / crossfade.durationMs) : 0,
    );
    let running = $derived(remainingMs > 0);

    // One timer per fade: it depends on `running` only, not on every tick.
    // Effects run in the browser only, so SSR never starts one.
    $effect(() => {
        if (!running) return;
        const timer = setInterval(() => (now = Date.now()), 200);
        return () => clearInterval(timer);
    });
</script>

{#if children}
    {@render children(running)}
{:else if crossfade && remainingMs > 0}
    <div class="min-w-0 {className}" data-testid="crossfade-indicator">
        <p class="text-xs text-primary-300 truncate">
            <span>
                {crossfade.role === 'incoming'
                    ? m.stream_crossfade_from()
                    : m.stream_crossfade_into()}
            </span>
            {crossfade.otherTrack.title}{crossfade.otherTrack.artistName
                ? ` — ${crossfade.otherTrack.artistName}`
                : ''}
        </p>
        <div class="mt-1 h-0.5 w-full rounded bg-surface-700 overflow-hidden" aria-hidden="true">
            <div class="h-full bg-primary-400" style="width: {fraction * 100}%"></div>
        </div>
    </div>
{/if}
