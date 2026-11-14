<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  EducationalShell — AGPL educational viewing shell.

  Player main column + compact collapsible lesson-list rail (reuses LessonRail).
  Around the video: subject→course breadcrumb, next/prev lesson auto-advance,
  per-lesson watch-state completion tracking, custom metadata (instructor,
  difficulty) shown belowFold.

  No enrollment, no quiz, no certificate — those are the private LessonShell.
  This is the OSS path for educational library items.
-->

<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import PlayerSurface from '$lib/components/player/PlayerSurface.svelte';
    import LessonRail from './LessonRail.svelte';
    import type { VideoPlayerProps } from '$lib/components/player/player-controller.svelte';
    import type { EducationalViewingContext } from '$lib/types/viewing-context';

    interface LessonEntry {
        id: string;
        title: string;
        lessonNumber?: number | null;
        completed: boolean;
        inProgress: boolean;
    }

    interface Props extends VideoPlayerProps {
        viewingContext: EducationalViewingContext;
        collectionTitle?: string;
        /**
         * @deprecated Use viewingContext.lessons — the server populates it with titles.
         * Kept for callers that pre-date the viewingContext.lessons field.
         */
        lessons?: LessonEntry[];
        instructor?: string | null;
        difficulty?: string | null;
        subject?: string | null;
        course?: string | null;
    }

    let {
        viewingContext,
        collectionTitle,
        lessons: legacyLessons = [],
        instructor,
        difficulty,
        subject,
        course,
        onback,
        onended,
        ...playerProps
    }: Props = $props();

    // Derive the lesson list from viewingContext.lessons (populated by the server),
    // falling back to any directly-passed lessons for back-compat.
    // viewingContext.lessons has no completion state — mark all as not completed
    // (completion tracking is a LessonShell feature).
    let lessons = $derived(
        viewingContext.lessons && viewingContext.lessons.length > 0
            ? viewingContext.lessons.map((l) => ({
                  id: l.id,
                  title: l.title,
                  lessonNumber: l.lessonNumber,
                  completed: false,
                  inProgress: l.id === playerProps.playbackInfo.itemId,
              }))
            : legacyLessons,
    );

    let railCollapsed = $state(false);

    function handleBack(): void {
        goto(resolve(viewingContext.returnPath));
    }

    function handleEnded(): void {
        // Auto-advance to next lesson on video end
        if (viewingContext.nextId) {
            goto(
                resolve(
                    `/watch/${viewingContext.nextId}?ctx=educational&col=${viewingContext.collectionId}&returnPath=${encodeURIComponent(viewingContext.returnPath)}`,
                ),
            );
        } else {
            onended?.();
        }
    }

    function handleNextLesson(): void {
        if (viewingContext.nextId) {
            goto(
                resolve(
                    `/watch/${viewingContext.nextId}?ctx=educational&col=${viewingContext.collectionId}&returnPath=${encodeURIComponent(viewingContext.returnPath)}`,
                ),
            );
        }
    }

    function handlePrevLesson(): void {
        if (viewingContext.prevId) {
            goto(
                resolve(
                    `/watch/${viewingContext.prevId}?ctx=educational&col=${viewingContext.collectionId}&returnPath=${encodeURIComponent(viewingContext.returnPath)}`,
                ),
            );
        }
    }

    function handleSelectLesson(id: string): void {
        goto(
            resolve(
                `/watch/${id}?ctx=educational&col=${viewingContext.collectionId}&returnPath=${encodeURIComponent(viewingContext.returnPath)}`,
            ),
        );
    }
</script>

<div class="educational-shell">
    <!-- Breadcrumb bar above player -->
    <div class="educational-shell__breadcrumb">
        <button class="educational-shell__back-btn" onclick={handleBack}>
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
        <span class="educational-shell__breadcrumb-sep" aria-hidden="true">›</span>
        {#if subject}
            <span class="educational-shell__breadcrumb-part">{subject}</span>
            <span class="educational-shell__breadcrumb-sep" aria-hidden="true">›</span>
        {/if}
        {#if course}
            <span class="educational-shell__breadcrumb-part">{course}</span>
        {:else if collectionTitle}
            <span class="educational-shell__breadcrumb-part">{collectionTitle}</span>
        {/if}

        <!-- Prev / Next lesson nav -->
        <div class="educational-shell__lesson-nav">
            <button
                class="educational-shell__nav-btn"
                onclick={handlePrevLesson}
                disabled={!viewingContext.prevId}
                aria-label="Previous lesson">
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
                Prev
            </button>
            <span class="educational-shell__lesson-pos">
                {#if viewingContext.position >= 0 && lessons.length > 0}
                    {viewingContext.position + 1} / {lessons.length}
                {/if}
            </span>
            <button
                class="educational-shell__nav-btn"
                onclick={handleNextLesson}
                disabled={!viewingContext.nextId}
                aria-label="Next lesson">
                Next
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
    </div>

    <!-- Main content row: player + lesson rail -->
    <div class="educational-shell__content">
        <!-- Player column -->
        <div class="educational-shell__player">
            <PlayerSurface {...playerProps} onback={handleBack} onended={handleEnded}>
                {#snippet belowFold()}
                    <!-- Below-fold metadata strip -->
                    <div class="educational-shell__below-fold">
                        {#if instructor || difficulty}
                            <div class="educational-shell__meta">
                                {#if instructor}
                                    <span class="educational-shell__meta-item">
                                        <span class="educational-shell__meta-label"
                                            >Instructor:</span>
                                        {instructor}
                                    </span>
                                {/if}
                                {#if difficulty}
                                    <span class="educational-shell__meta-item">
                                        <span class="educational-shell__meta-label">Level:</span>
                                        <span
                                            class="educational-shell__difficulty educational-shell__difficulty--{difficulty.toLowerCase()}">
                                            {difficulty}
                                        </span>
                                    </span>
                                {/if}
                            </div>
                        {/if}

                        <!-- Next lesson CTA -->
                        {#if viewingContext.nextId}
                            <button class="educational-shell__next-cta" onclick={handleNextLesson}>
                                Next Lesson
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
                        {/if}
                    </div>
                {/snippet}
            </PlayerSurface>
        </div>

        <!-- Lesson rail -->
        {#if lessons.length > 0}
            <LessonRail
                {lessons}
                currentId={playerProps.playbackInfo.itemId}
                {collectionTitle}
                onSelectLesson={handleSelectLesson}
                isCollapsed={railCollapsed}
                onToggleCollapse={() => (railCollapsed = !railCollapsed)} />
        {/if}
    </div>
</div>

<style>
    .educational-shell {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100dvh;
        background: #000;
        overflow: hidden;
    }

    .educational-shell__breadcrumb {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.5rem 1rem;
        background: rgba(0, 0, 0, 0.9);
        border-bottom: 1px solid rgba(255, 255, 255, 0.07);
        flex-shrink: 0;
        font-size: 0.8rem;
        color: rgba(255, 255, 255, 0.6);
        overflow: hidden;
    }

    .educational-shell__back-btn {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        background: none;
        border: none;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.7);
        font-size: 0.8rem;
        padding: 0.25rem 0.4rem;
        border-radius: 4px;
        flex-shrink: 0;
        transition:
            color 0.15s,
            background 0.15s;
    }

    .educational-shell__back-btn:hover {
        color: white;
        background: rgba(255, 255, 255, 0.1);
    }

    .educational-shell__breadcrumb-sep {
        color: rgba(255, 255, 255, 0.3);
    }

    .educational-shell__breadcrumb-part {
        color: rgba(255, 255, 255, 0.8);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 18ch;
    }

    .educational-shell__lesson-nav {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-left: auto;
        flex-shrink: 0;
    }

    .educational-shell__nav-btn {
        display: flex;
        align-items: center;
        gap: 0.2rem;
        background: none;
        border: 1px solid rgba(255, 255, 255, 0.15);
        cursor: pointer;
        color: rgba(255, 255, 255, 0.7);
        font-size: 0.75rem;
        padding: 0.2rem 0.5rem;
        border-radius: 4px;
        transition:
            color 0.15s,
            background 0.15s,
            border-color 0.15s;
    }

    .educational-shell__nav-btn:hover:not(:disabled) {
        color: white;
        border-color: rgba(255, 255, 255, 0.4);
        background: rgba(255, 255, 255, 0.07);
    }

    .educational-shell__nav-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
    }

    .educational-shell__lesson-pos {
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.5);
        min-width: 4ch;
        text-align: center;
        font-variant-numeric: tabular-nums;
    }

    .educational-shell__content {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .educational-shell__player {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .educational-shell__below-fold {
        padding: 0.75rem 1rem;
        background: rgba(0, 0, 0, 0.8);
        border-top: 1px solid rgba(255, 255, 255, 0.07);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        flex-shrink: 0;
    }

    .educational-shell__meta {
        display: flex;
        gap: 1.5rem;
        font-size: 0.8rem;
        color: rgba(255, 255, 255, 0.7);
    }

    .educational-shell__meta-item {
        display: flex;
        align-items: center;
        gap: 0.3rem;
    }

    .educational-shell__meta-label {
        color: rgba(255, 255, 255, 0.45);
        font-size: 0.75rem;
    }

    .educational-shell__difficulty {
        text-transform: capitalize;
        padding: 0.1rem 0.4rem;
        border-radius: 3px;
        font-size: 0.7rem;
        font-weight: 500;
    }

    .educational-shell__difficulty--beginner {
        background: rgba(74, 222, 128, 0.15);
        color: rgb(74, 222, 128);
    }

    .educational-shell__difficulty--intermediate {
        background: rgba(251, 191, 36, 0.15);
        color: rgb(251, 191, 36);
    }

    .educational-shell__difficulty--advanced {
        background: rgba(248, 113, 113, 0.15);
        color: rgb(248, 113, 113);
    }

    .educational-shell__next-cta {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.4rem 1rem;
        background: rgb(99, 102, 241);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        color: white;
        font-size: 0.8rem;
        font-weight: 500;
        flex-shrink: 0;
        transition: background 0.15s;
    }

    .educational-shell__next-cta:hover {
        background: rgb(79, 82, 221);
    }
</style>
