<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Seekbar decoration for an active crossfade; place it AFTER the progress
  fill. The store promotes the incoming track at fade start, so the real fill
  jumps straight to the incoming track's position — deliberately: an
  animated "rewind" from the old position read as the bar sliding backwards.
  The jump itself is softened by a dissolve: a copy of the OLD fill (at the
  outgoing track's position) fades out in place over OUT_MS, revealing the
  new fill underneath — a fade, not a motion. The rest lives at the incoming
  fill's leading edge:

  - a glowing spark on the edge, which pulses on every beat of a
    beat-matched fade;
  - a soft amber glow trailing ahead of the edge, with a shimmer running
    through it — the new track "flowing in".

  Opacity follows a sin(pi*t) envelope of crossfadeProgress (JS), so the
  effect grows out of and dissolves back into the plain bar and nothing is
  visible when it unmounts at the end of the fade. The shimmer and beat pulse
  are CSS animations and are disabled under prefers-reduced-motion.
-->
<script lang="ts" module>
    import { browser } from '$app/environment';
    import { musicPlayerStore } from '$lib/stores/music-player.store';

    /** Duration of the old fill's dissolve at the jump. */
    const OUT_MS = 600;

    /** Outgoing fill ratio + when the fade began. Captured from a synchronous
     *  store subscription: the store flips isCrossfading BEFORE it promotes
     *  the incoming track, so the last non-fading progress is the outgoing
     *  track's. Module-level (the store is a singleton) so a bar mounted
     *  mid-dissolve — the full-screen player opened right at the jump —
     *  joins it at the right point instead of replaying it. */
    let outgoing = $state<{ ratio: number; startedAt: number } | null>(null);
    let capturing = false;

    function ensureCapturing(): void {
        // Never on the server: a module-level subscription there would
        // outlive the request.
        if (capturing || !browser) return;
        capturing = true;
        let lastIdleProgress = 0;
        musicPlayerStore.subscribe((s) => {
            if (!s.isCrossfading) {
                lastIdleProgress = s.progress;
                if (outgoing !== null) outgoing = null;
            } else if (outgoing === null) {
                outgoing = { ratio: lastIdleProgress, startedAt: performance.now() };
            }
        });
    }
</script>

<script lang="ts">
    interface Props {
        /** Round the ends (the full-screen bar is pill-shaped). */
        rounded?: boolean;
    }

    let { rounded = false }: Props = $props();

    ensureCapturing();

    /** How far into the dissolve this instance mounted (ms); null once it
     *  is over, so a late mount does not show the old fill at all. Read once
     *  per fade: the CSS animation runs from there on its own. */
    const dissolveElapsed = $derived.by(() => {
        if (!outgoing) return null;
        const elapsed = performance.now() - outgoing.startedAt;
        return elapsed < OUT_MS ? elapsed : null;
    });

    /** Width of the glow ahead of the incoming fill, as a fraction of the bar. */
    const GLOW_SPAN = 0.22;

    const t = $derived(Math.max(0, Math.min(1, $musicPlayerStore.crossfadeProgress)));
    const envelope = $derived(Math.sin(t * Math.PI));
    const edge = $derived(Math.max(0, Math.min(1, $musicPlayerStore.progress)));
    const beat = $derived(
        $musicPlayerStore.crossfadeTotalBeats > 0 ? $musicPlayerStore.crossfadeCurrentBeat : null,
    );
</script>

{#if $musicPlayerStore.isCrossfading}
    {#if outgoing && dissolveElapsed !== null}
        <!-- Old fill dissolving in place at the jump. -->
        <div
            class="xfade-old-fill pointer-events-none absolute top-0 bottom-0 left-0 bg-primary-500"
            class:rounded-full={rounded}
            style="width: {outgoing.ratio *
                100}%; animation-duration: {OUT_MS}ms; animation-delay: -{dissolveElapsed}ms;">
        </div>
    {/if}
    <!-- Glow + shimmer ahead of the incoming fill's edge. -->
    <div
        class="xfade-glow pointer-events-none absolute top-0 bottom-0 overflow-hidden"
        class:rounded-full={rounded}
        style="left: {edge * 100}%; width: {Math.min(GLOW_SPAN, 1 - edge) *
            100}%; opacity: {envelope};">
        <div class="xfade-shimmer absolute inset-0"></div>
    </div>
    {#if !$musicPlayerStore.alwaysShowBeatPulse}
        <!-- Spark on the edge; re-keyed per beat so its pulse restarts. -->
        <div
            class="pointer-events-none absolute top-1/2"
            style="left: {edge * 100}%; opacity: {Math.min(1, envelope * 1.6)};">
            {#key beat}
                <div
                    class="xfade-spark h-2 w-2 rounded-full"
                    class:xfade-spark-beat={beat !== null}>
                </div>
            {/key}
        </div>
    {/if}
{/if}

<style>
    .xfade-old-fill {
        animation-name: xfade-old-out;
        animation-timing-function: ease-out;
        animation-fill-mode: forwards;
    }

    @keyframes xfade-old-out {
        from {
            opacity: 1;
        }
        to {
            opacity: 0;
        }
    }

    .xfade-shimmer {
        background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(251, 191, 36, 0) 35%,
            rgba(255, 236, 179, 0.55) 50%,
            rgba(251, 191, 36, 0) 65%,
            transparent 100%
        );
        background-size: 40% 100%;
        background-repeat: no-repeat;
        animation: xfade-sweep 1.6s linear infinite;
    }

    @keyframes xfade-sweep {
        from {
            background-position: -40% 0;
        }
        to {
            background-position: 140% 0;
        }
    }

    .xfade-spark {
        /* Centering lives here, not in utility classes, so the beat pulse
           keyframes (which set transform) keep it centred. */
        transform: translate(-50%, -50%);
        background: #fde68a;
        box-shadow:
            0 0 6px 2px rgba(251, 191, 36, 0.8),
            0 0 14px 4px rgb(var(--color-primary-500-rgb) / 0.45);
    }

    .xfade-glow {
        background: linear-gradient(90deg, rgba(251, 191, 36, 0.55), rgba(251, 191, 36, 0));
    }

    .xfade-spark-beat {
        animation: xfade-beat 0.45s ease-out;
    }

    @keyframes xfade-beat {
        from {
            transform: translate(-50%, -50%) scale(1.8);
        }
        to {
            transform: translate(-50%, -50%) scale(1);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .xfade-shimmer,
        .xfade-spark-beat {
            animation: none;
        }
    }
</style>
