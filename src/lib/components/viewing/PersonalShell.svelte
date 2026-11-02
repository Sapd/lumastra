<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  PersonalShell — AGPL home_video / personal viewing shell.

  Immersive-ish player + a slim event-context strip (date filmed, event name).
  Rail = event clip strip for home_video (grouped by event).
  Auto-advances to the next clip in the event on ended.
  Personal type (no event grouping) just shows a minimal player with next/prev clip.

  No ratings, resources, quiz, or social chrome.
-->

<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import PlayerSurface from '$lib/components/player/PlayerSurface.svelte';
    import type { VideoPlayerProps } from '$lib/components/player/player-controller.svelte';
    import type { PersonalViewingContext } from '$lib/types/viewing-context';

    interface ClipEntry {
        id: string;
        title: string;
        thumbnailUrl?: string;
    }

    interface Props extends VideoPlayerProps {
        viewingContext: PersonalViewingContext;
        eventClips?: ClipEntry[];
        eventTitle?: string | null;
    }

    let {
        viewingContext,
        eventClips = [],
        eventTitle,
        onback,
        onended,
        ...playerProps
    }: Props = $props();

    let showClipRail = $state(false);

    function handleBack(): void {
        goto(resolve(viewingContext.returnPath));
    }

    function handleEnded(): void {
        if (viewingContext.nextId) {
            goto(resolve(buildClipUrl(viewingContext.nextId)));
        } else {
            onended?.();
        }
    }

    function buildClipUrl(id: string): string {
        const params = new URLSearchParams({
            ctx: 'personal',
            event: viewingContext.eventGroupId,
            returnPath: viewingContext.returnPath,
        });
        return `/watch/${id}?${params.toString()}`;
    }

    function handleNextClip(): void {
        if (viewingContext.nextId) goto(resolve(buildClipUrl(viewingContext.nextId)));
    }

    function handlePrevClip(): void {
        if (viewingContext.prevId) goto(resolve(buildClipUrl(viewingContext.prevId)));
    }
</script>

<div class="personal-shell">
    <!-- Thin header strip: event context + nav -->
    <div class="personal-shell__header">
        <button class="personal-shell__back" onclick={handleBack}>
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true">
                <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
        </button>

        <!-- Event context info -->
        {#if viewingContext.eventName || viewingContext.dateFiled}
            <span class="personal-shell__sep" aria-hidden="true">·</span>
            {#if viewingContext.eventName}
                <span class="personal-shell__event-name">{viewingContext.eventName}</span>
            {/if}
            {#if viewingContext.dateFiled}
                <span class="personal-shell__date">{viewingContext.dateFiled}</span>
            {/if}
        {/if}

        <!-- Clip position nav -->
        {#if viewingContext.prevId || viewingContext.nextId}
            <div class="personal-shell__nav">
                <button
                    class="personal-shell__nav-btn"
                    onclick={handlePrevClip}
                    disabled={!viewingContext.prevId}
                    aria-label="Previous clip">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                </button>
                <span class="personal-shell__clip-pos">
                    {viewingContext.position + 1}{eventClips.length > 0
                        ? ` / ${eventClips.length}`
                        : ''}
                </span>
                <button
                    class="personal-shell__nav-btn"
                    onclick={handleNextClip}
                    disabled={!viewingContext.nextId}
                    aria-label="Next clip">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                    </svg>
                </button>
            </div>
        {/if}

        <!-- Event clips toggle -->
        {#if eventClips.length > 1}
            <button
                class="personal-shell__clips-toggle"
                onclick={() => (showClipRail = !showClipRail)}
                aria-expanded={showClipRail}>
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true">
                    <rect x="2" y="3" width="6" height="18" rx="1" />
                    <rect x="10" y="3" width="6" height="18" rx="1" />
                    <rect x="18" y="3" width="4" height="18" rx="1" />
                </svg>
                {eventClips.length} clips
            </button>
        {/if}
    </div>

    <!-- Main layout: player + optional clip rail -->
    <div class="personal-shell__main">
        <div class="personal-shell__player">
            <PlayerSurface {...playerProps} onback={handleBack} onended={handleEnded} />
        </div>

        <!-- Event clip strip rail (shown when toggled) -->
        {#if showClipRail && eventClips.length > 1}
            <aside class="personal-shell__clip-rail" aria-label="Event clips">
                <p class="personal-shell__clip-rail-title">
                    {eventTitle ?? viewingContext.eventName ?? 'Event clips'}
                </p>
                <ul class="personal-shell__clip-list">
                    {#each eventClips as clip (clip.id)}
                        {@const isCurrent = clip.id === playerProps.playbackInfo.itemId}
                        <li
                            class="personal-shell__clip-item"
                            class:personal-shell__clip-item--current={isCurrent}>
                            <button
                                class="personal-shell__clip-btn"
                                onclick={() => goto(resolve(buildClipUrl(clip.id)))}
                                aria-current={isCurrent ? 'true' : undefined}>
                                {#if clip.thumbnailUrl}
                                    <img
                                        src={clip.thumbnailUrl}
                                        alt=""
                                        class="personal-shell__clip-thumb"
                                        loading="lazy" />
                                {:else}
                                    <div class="personal-shell__clip-thumb-placeholder">
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="16"
                                            height="16"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="1.5"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            aria-hidden="true">
                                            <polygon points="5 3 19 12 5 21 5 3" />
                                        </svg>
                                    </div>
                                {/if}
                                <span class="personal-shell__clip-title">{clip.title}</span>
                            </button>
                        </li>
                    {/each}
                </ul>
            </aside>
        {/if}
    </div>
</div>

<style>
    .personal-shell {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100dvh;
        background: #000;
        overflow: hidden;
    }

    .personal-shell__header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.4rem 1rem;
        background: rgba(0, 0, 0, 0.85);
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        flex-shrink: 0;
        font-size: 0.8rem;
        color: rgba(255, 255, 255, 0.6);
    }

    .personal-shell__back {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        background: none;
        border: none;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.7);
        font-size: 0.8rem;
        padding: 0.2rem 0.4rem;
        border-radius: 4px;
        transition:
            color 0.15s,
            background 0.15s;
    }

    .personal-shell__back:hover {
        color: white;
        background: rgba(255, 255, 255, 0.1);
    }

    .personal-shell__sep {
        color: rgba(255, 255, 255, 0.3);
    }

    .personal-shell__event-name {
        color: rgba(255, 255, 255, 0.85);
        font-weight: 500;
        max-width: 22ch;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .personal-shell__date {
        color: rgba(255, 255, 255, 0.5);
        font-size: 0.75rem;
    }

    .personal-shell__nav {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        margin-left: auto;
    }

    .personal-shell__nav-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        background: none;
        border: 1px solid rgba(255, 255, 255, 0.12);
        cursor: pointer;
        color: rgba(255, 255, 255, 0.65);
        width: 28px;
        height: 28px;
        border-radius: 4px;
        transition:
            color 0.15s,
            background 0.15s,
            border-color 0.15s;
    }

    .personal-shell__nav-btn:hover:not(:disabled) {
        color: white;
        border-color: rgba(255, 255, 255, 0.35);
        background: rgba(255, 255, 255, 0.07);
    }

    .personal-shell__nav-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
    }

    .personal-shell__clip-pos {
        font-size: 0.7rem;
        color: rgba(255, 255, 255, 0.5);
        font-variant-numeric: tabular-nums;
        min-width: 3.5ch;
        text-align: center;
    }

    .personal-shell__clips-toggle {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        background: none;
        border: 1px solid rgba(255, 255, 255, 0.12);
        cursor: pointer;
        color: rgba(255, 255, 255, 0.65);
        font-size: 0.75rem;
        padding: 0.2rem 0.5rem;
        border-radius: 4px;
        transition:
            color 0.15s,
            background 0.15s,
            border-color 0.15s;
    }

    .personal-shell__clips-toggle:hover {
        color: white;
        border-color: rgba(255, 255, 255, 0.3);
        background: rgba(255, 255, 255, 0.07);
    }

    .personal-shell__main {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .personal-shell__player {
        flex: 1;
        min-width: 0;
        overflow: hidden;
    }

    .personal-shell__clip-rail {
        width: 260px;
        flex-shrink: 0;
        background: rgba(0, 0, 0, 0.9);
        border-left: 1px solid rgba(255, 255, 255, 0.07);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .personal-shell__clip-rail-title {
        font-size: 0.75rem;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.7);
        padding: 0.75rem 1rem 0.5rem;
        margin: 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }

    .personal-shell__clip-list {
        list-style: none;
        margin: 0;
        padding: 0.25rem 0;
        overflow-y: auto;
        flex: 1;
    }

    .personal-shell__clip-item--current {
        background: rgb(var(--color-primary-500-rgb) / 0.1);
        border-left: 2px solid rgb(var(--color-primary-500-rgb));
    }

    .personal-shell__clip-btn {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        width: 100%;
        padding: 0.5rem 0.75rem;
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        transition: background 0.1s;
    }

    .personal-shell__clip-btn:hover {
        background: rgba(255, 255, 255, 0.06);
    }

    .personal-shell__clip-thumb {
        width: 56px;
        height: 36px;
        object-fit: cover;
        border-radius: 3px;
        flex-shrink: 0;
        background: #111;
    }

    .personal-shell__clip-thumb-placeholder {
        width: 56px;
        height: 36px;
        border-radius: 3px;
        flex-shrink: 0;
        background: rgba(255, 255, 255, 0.06);
        display: flex;
        align-items: center;
        justify-content: center;
        color: rgba(255, 255, 255, 0.3);
    }

    .personal-shell__clip-title {
        font-size: 0.78rem;
        color: rgba(255, 255, 255, 0.8);
        line-height: 1.3;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
    }
</style>
