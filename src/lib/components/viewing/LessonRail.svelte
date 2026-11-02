<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  LessonRail — shared lesson-list rail primitive (AGPL).

  Used by EducationalShell (AGPL) and may be imported by LessonShell (proprietary)
  since proprietary → core imports are permitted.

  Shows an ordered list of lesson items with completion status. The current lesson
  is highlighted. Clicking a lesson navigates to it.
-->

<script lang="ts">
    interface LessonItem {
        id: string;
        title: string;
        lessonNumber?: number | null;
        completed: boolean;
        inProgress: boolean;
    }

    interface Props {
        lessons: LessonItem[];
        currentId: string;
        collectionTitle?: string;
        onSelectLesson: (id: string) => void;
        isCollapsed?: boolean;
        onToggleCollapse?: () => void;
    }

    let {
        lessons,
        currentId,
        collectionTitle,
        onSelectLesson,
        isCollapsed = false,
        onToggleCollapse,
    }: Props = $props();

    let currentIndex = $derived(lessons.findIndex((l) => l.id === currentId));
    let totalCount = $derived(lessons.length);
    let completedCount = $derived(lessons.filter((l) => l.completed).length);
    let progressPercent = $derived(
        totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0,
    );
</script>

<aside class="lesson-rail" class:lesson-rail--collapsed={isCollapsed} aria-label="Lesson list">
    <!-- Rail header -->
    <div class="lesson-rail__header">
        <div class="lesson-rail__header-info">
            {#if collectionTitle}
                <p class="lesson-rail__collection-title">{collectionTitle}</p>
            {/if}
            <p class="lesson-rail__progress-label">
                {completedCount}/{totalCount} lessons
                {#if currentIndex >= 0}
                    &nbsp;·&nbsp; Lesson {currentIndex + 1} of {totalCount}
                {/if}
            </p>
        </div>
        {#if onToggleCollapse}
            <button
                class="lesson-rail__collapse-btn"
                onclick={onToggleCollapse}
                aria-label={isCollapsed ? 'Expand lesson list' : 'Collapse lesson list'}>
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="lesson-rail__collapse-icon"
                    class:lesson-rail__collapse-icon--rotated={isCollapsed}>
                    <polyline points="15 18 9 12 15 6" />
                </svg>
            </button>
        {/if}
    </div>

    <!-- Progress bar -->
    {#if !isCollapsed}
        <div
            class="lesson-rail__progress-bar"
            role="progressbar"
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}>
            <div class="lesson-rail__progress-fill" style="width: {progressPercent}%"></div>
        </div>

        <!-- Lesson list -->
        <ol class="lesson-rail__list">
            {#each lessons as lesson, idx (lesson.id)}
                {@const isCurrent = lesson.id === currentId}
                <li class="lesson-rail__item" class:lesson-rail__item--current={isCurrent}>
                    <button
                        class="lesson-rail__item-btn"
                        onclick={() => onSelectLesson(lesson.id)}
                        aria-current={isCurrent ? 'true' : undefined}>
                        <!-- Status indicator -->
                        <span class="lesson-rail__status" aria-hidden="true">
                            {#if lesson.completed}
                                <svg
                                    class="lesson-rail__status-icon lesson-rail__status-icon--done"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2.5">
                                    <polyline points="20 6 9 17 4 12" />
                                </svg>
                            {:else if lesson.inProgress || isCurrent}
                                <span
                                    class="lesson-rail__status-dot lesson-rail__status-dot--active"
                                ></span>
                            {:else}
                                <span class="lesson-rail__status-dot"></span>
                            {/if}
                        </span>

                        <!-- Lesson number + title -->
                        <span class="lesson-rail__item-content">
                            <span class="lesson-rail__item-number">
                                {lesson.lessonNumber ?? idx + 1}.
                            </span>
                            <span class="lesson-rail__item-title">{lesson.title}</span>
                        </span>
                    </button>
                </li>
            {/each}
        </ol>
    {/if}
</aside>

<style>
    .lesson-rail {
        display: flex;
        flex-direction: column;
        background: rgba(0, 0, 0, 0.85);
        border-left: 1px solid rgba(255, 255, 255, 0.08);
        width: 280px;
        min-width: 220px;
        max-width: 320px;
        flex-shrink: 0;
        overflow: hidden;
        transition: width 0.2s ease;
    }

    .lesson-rail--collapsed {
        width: 40px;
        min-width: 40px;
    }

    .lesson-rail__header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        gap: 0.5rem;
    }

    .lesson-rail__header-info {
        overflow: hidden;
    }

    .lesson-rail--collapsed .lesson-rail__header-info {
        display: none;
    }

    .lesson-rail__collection-title {
        font-size: 0.75rem;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.9);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin: 0 0 0.2rem;
    }

    .lesson-rail__progress-label {
        font-size: 0.7rem;
        color: rgba(255, 255, 255, 0.5);
        margin: 0;
    }

    .lesson-rail__collapse-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.5);
        padding: 0.25rem;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        border-radius: 4px;
        transition:
            color 0.15s,
            background 0.15s;
    }

    .lesson-rail__collapse-btn:hover {
        color: white;
        background: rgba(255, 255, 255, 0.1);
    }

    .lesson-rail__collapse-icon {
        transition: transform 0.2s;
    }

    .lesson-rail__collapse-icon--rotated {
        transform: rotate(180deg);
    }

    .lesson-rail__progress-bar {
        height: 3px;
        background: rgba(255, 255, 255, 0.1);
        flex-shrink: 0;
    }

    .lesson-rail__progress-fill {
        height: 100%;
        background: rgb(99 102 241); /* indigo-500 */
        transition: width 0.3s ease;
    }

    .lesson-rail__list {
        list-style: none;
        margin: 0;
        padding: 0.25rem 0;
        overflow-y: auto;
        flex: 1;
    }

    .lesson-rail__item {
        border-radius: 0;
    }

    .lesson-rail__item--current {
        background: rgb(var(--color-primary-500-rgb) / 0.15);
        border-left: 2px solid rgb(var(--color-primary-500-rgb));
    }

    .lesson-rail__item-btn {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        width: 100%;
        padding: 0.6rem 1rem;
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        color: rgba(255, 255, 255, 0.8);
        transition:
            background 0.1s,
            color 0.1s;
    }

    .lesson-rail__item-btn:hover {
        background: rgba(255, 255, 255, 0.07);
        color: white;
    }

    .lesson-rail__item--current .lesson-rail__item-btn {
        color: white;
    }

    .lesson-rail__status {
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-top: 1px;
    }

    .lesson-rail__status-icon {
        width: 16px;
        height: 16px;
    }

    .lesson-rail__status-icon--done {
        color: rgb(74, 222, 128); /* green-400 */
    }

    .lesson-rail__status-dot {
        display: block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        border: 1.5px solid rgba(255, 255, 255, 0.35);
        background: transparent;
    }

    .lesson-rail__status-dot--active {
        background: rgb(var(--color-primary-500-rgb));
        border-color: rgb(var(--color-primary-500-rgb));
    }

    .lesson-rail__item-content {
        display: flex;
        align-items: baseline;
        gap: 0.3rem;
        min-width: 0;
    }

    .lesson-rail__item-number {
        font-size: 0.7rem;
        color: rgba(255, 255, 255, 0.4);
        flex-shrink: 0;
        font-variant-numeric: tabular-nums;
    }

    .lesson-rail__item-title {
        font-size: 0.8rem;
        line-height: 1.4;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
    }
</style>
