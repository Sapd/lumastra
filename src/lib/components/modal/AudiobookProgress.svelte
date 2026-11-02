<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->
<!--
	@component
	The listener's own place in an audiobook, shown in the detail modal's header.

	- Started: a progress bar, the percentage, the current chapter, and position
	  against length.
	- Finished and not restarted: a "Finished" line.
	- Never started: nothing.

	A finished book with a position is being listened to again, so it shows the bar.
-->
<script lang="ts">
    import { Icon, CheckCircle } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Chapter {
        startMs: number;
        synthetic?: boolean;
    }

    interface Props {
        positionMs: number;
        durationMs: number;
        finished: boolean;
        chapters?: Chapter[] | undefined;
    }

    let { positionMs, durationMs, finished, chapters = undefined }: Props = $props();

    let started = $derived(positionMs > 0 && durationMs > 0);
    let percent = $derived(
        started ? Math.min(100, Math.max(0, Math.round((positionMs / durationMs) * 100))) : 0,
    );

    // Tagged chapters only: the synthetic tail is audio past the last tagged
    // chapter, not a chapter of its own, so it neither counts nor gets a number.
    let chapterPosition = $derived.by(() => {
        const tagged = (chapters ?? []).filter((c) => !c.synthetic);
        if (!started || tagged.length < 2) return null;
        let index = -1;
        for (let i = 0; i < tagged.length; i++) {
            if (tagged[i].startMs <= positionMs) index = i;
            else break;
        }
        if (index < 0) return null;
        return { current: index + 1, total: tagged.length };
    });

    function formatLength(ms: number): string {
        const minutes = Math.max(0, Math.floor(ms / 60_000));
        const h = Math.floor(minutes / 60);
        const min = minutes % 60;
        return h > 0 ? `${h}h ${String(min).padStart(2, '0')}m` : `${min}m`;
    }
</script>

{#if started}
    <div class="audiobook-progress">
        <div
            class="bar"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={percent}
            aria-label={m.modal_audiobook_progress_label({ percent: String(percent) })}>
            <div class="fill" style:width="{percent}%"></div>
        </div>
        <p class="meta">
            <span class="text-surface-100 font-medium">{percent}%</span>
            {#if chapterPosition}
                <span aria-hidden="true">·</span>
                <span
                    >{m.modal_audiobook_progress_chapter({
                        current: String(chapterPosition.current),
                        total: String(chapterPosition.total),
                    })}</span>
            {/if}
            <span class="time"
                >{m.modal_audiobook_progress_time({
                    position: formatLength(positionMs),
                    duration: formatLength(durationMs),
                })}</span>
        </p>
    </div>
{:else if finished}
    <p class="audiobook-finished">
        <Icon src={CheckCircle} class="w-5 h-5" aria-hidden="true" />
        {m.modal_audiobook_series_finished()}
    </p>
{/if}

<style>
    .audiobook-progress {
        margin-top: 1.25rem;
        max-width: 28rem;
    }
    .bar {
        height: 0.375rem;
        border-radius: 9999px;
        background: rgb(var(--color-surface-50-rgb) / 0.12);
        overflow: hidden;
    }
    .fill {
        height: 100%;
        border-radius: inherit;
        background: var(--color-primary-500);
    }
    .meta {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.25rem 0.5rem;
        margin-top: 0.5rem;
        font-size: 0.875rem;
        color: var(--color-surface-300);
        font-variant-numeric: tabular-nums;
    }
    .time {
        margin-left: auto;
        color: var(--color-surface-400);
    }
    .audiobook-finished {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        margin-top: 1.25rem;
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--color-success-400);
    }
    @media (max-width: 419px) {
        .audiobook-progress {
            margin-inline: auto;
        }
        .meta {
            justify-content: center;
        }
        .time {
            margin-left: 0;
        }
    }
</style>
