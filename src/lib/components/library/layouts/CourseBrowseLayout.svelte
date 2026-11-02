<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  CourseBrowseLayout — subject → course inline episode list for educational libraries.

  Primary groups: subject (from server groupBy[0]).
  Secondary groups: course (client-side, from custom_metadata.course).
  Each course renders as a flat numbered episode list sorted by lesson_number.
  A "Start course" CTA navigates to the first unwatched lesson (or first lesson
  if none are watched).

  OD-3: always show episode-list view even for single-lesson courses.
-->

<script lang="ts">
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import { SvelteMap } from 'svelte/reactivity';
    import type { BrowseLayoutProps } from './layout-props';
    import type { BrowseItem } from '$lib/shared/browse-layout-utils';
    import { sortByLessonNumber } from '$lib/shared/browse-layout-utils';

    let {
        libraryType,
        template,
        groupedItems,
        isAdmin,
        bulkModeActive,
        selectedIds,
        onToggleSelect,
        onOpenDrawer,
        onNavigate,
        onEditStart,
        editingItemId,
        editCategoryValue,
        onEditSave,
        onEditCancel,
        savingCategory,
        progressMeaning,
    }: BrowseLayoutProps = $props();

    /** subject → course → sorted lessons */
    const subjectCourseMap = $derived.by(() => {
        const result = new SvelteMap<string, SvelteMap<string, BrowseItem[]>>();
        for (const [subject, items] of groupedItems) {
            // Build the course sub-map as SvelteMap with lessons sorted by lesson_number
            const sortedCourseMap = new SvelteMap<string, BrowseItem[]>();
            // Group items by course
            for (const item of items) {
                const course =
                    item.custom_metadata?.course == null ||
                    Array.isArray(item.custom_metadata.course) ||
                    typeof item.custom_metadata.course === 'object'
                        ? 'Uncategorized'
                        : String(item.custom_metadata.course);
                if (!sortedCourseMap.has(course)) sortedCourseMap.set(course, []);
                sortedCourseMap.get(course)!.push(item);
            }
            // Sort each course's lessons by lesson_number
            for (const [course, lessons] of sortedCourseMap) {
                sortedCourseMap.set(course, sortByLessonNumber(lessons));
            }
            result.set(subject, sortedCourseMap);
        }
        return result;
    });

    /** Resolve the first unwatched lesson for the "Start course" CTA.
     *  Falls back to the first lesson if everything is already completed. */
    function startCourseTarget(lessons: BrowseItem[]): string {
        const unwatched = lessons.find(
            (l) => l.completed_count === 0 || l.completed_count < l.episode_count,
        );
        const target = unwatched ?? lessons[0];
        if (!target) return '#';
        // Thread educational context so the watch page renders EducationalShell
        // with the lesson-list rail, next/prev auto-advance, and a breadcrumb back
        // to this browse page. col= is the series UUID (the "course" container).
        const episodeId = target.first_episode_id ?? target.id;
        const params = new URLSearchParams({
            ctx: 'educational',
            col: target.id,
            // returnPath so the EducationalShell back button returns to this browse
            // page rather than the server default of '/browse'.
            returnPath: $page.url.pathname + $page.url.search,
        });
        return `/watch/${episodeId}?${params.toString()}`;
    }

    function formatDuration(seconds: unknown): string {
        const s = parseInt(String(seconds ?? ''), 10);
        if (isNaN(s) || s <= 0) return '';
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        if (h > 0) return `${h}h ${m % 60}m`;
        return `${m}m`;
    }

    function lessonNumber(item: BrowseItem): string {
        const n = parseInt(String(item.custom_metadata?.lesson_number ?? ''), 10);
        return isNaN(n) ? '—' : String(n);
    }
</script>

<div class="space-y-10">
    {#each subjectCourseMap as [subject, courseMap] (subject)}
        <section>
            <!-- Subject header -->
            <h2 class="text-xl font-bold text-white mb-5 border-b border-surface-700 pb-2">
                {subject}
            </h2>

            <div class="space-y-6">
                {#each courseMap as [course, lessons] (course)}
                    <div class="bg-surface-800 rounded-xl overflow-hidden">
                        <!-- Course header row -->
                        <div
                            class="flex items-center justify-between px-5 py-3 bg-surface-750 border-b border-surface-700">
                            <h3 class="text-base font-semibold text-white">{course}</h3>
                            <div class="flex items-center gap-3">
                                <span class="text-xs text-surface-400">
                                    {lessons.length}
                                    {lessons.length === 1
                                        ? (template.cardConfig.clipLabel
                                              .slice(0, -1)
                                              .toLowerCase() ?? 'lesson')
                                        : (template.cardConfig.clipLabel.toLowerCase() ??
                                          'lessons')}
                                </span>
                                <button
                                    class="px-3 py-1.5 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-xs font-medium transition-colors"
                                    onclick={() => void goto(resolve(startCourseTarget(lessons)))}>
                                    Start course
                                </button>
                            </div>
                        </div>

                        <!-- Lesson list -->
                        <ul class="divide-y divide-surface-700">
                            {#each lessons as item, idx (item.id)}
                                {@const isCompleted =
                                    item.episode_count > 0 &&
                                    item.completed_count === item.episode_count}
                                <li
                                    class="flex items-center gap-4 hover:bg-surface-700/50 transition-colors group">
                                    <!-- Main clickable row as a button for ARIA correctness -->
                                    <button
                                        class="flex items-center gap-4 px-5 py-3 flex-1 min-w-0 text-left cursor-pointer"
                                        onclick={() => {
                                            if (bulkModeActive) {
                                                onToggleSelect(item.id);
                                                return;
                                            }
                                            onNavigate(item);
                                        }}>
                                        <!-- Lesson number -->
                                        <span
                                            class="w-7 text-center text-sm font-mono text-surface-400 flex-none">
                                            {lessonNumber(item) !== '—'
                                                ? lessonNumber(item)
                                                : idx + 1}
                                        </span>

                                        <!-- Completion indicator -->
                                        <div class="flex-none w-5">
                                            {#if isCompleted}
                                                <svg
                                                    class="w-5 h-5 text-green-500"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    viewBox="0 0 24 24">
                                                    <path
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                        stroke-width="2.5"
                                                        d="M5 13l4 4L19 7" />
                                                </svg>
                                            {:else if item.completed_count > 0}
                                                <div
                                                    class="w-3 h-3 rounded-full bg-primary-500 mx-auto">
                                                </div>
                                            {:else}
                                                <div
                                                    class="w-3 h-3 rounded-full border border-surface-500 mx-auto">
                                                </div>
                                            {/if}
                                        </div>

                                        <!-- Title + metadata -->
                                        <div class="flex-1 min-w-0">
                                            <p class="text-sm text-white truncate">{item.title}</p>
                                            {#if item.custom_metadata?.instructor}
                                                <p class="text-xs text-surface-400 truncate">
                                                    {String(item.custom_metadata.instructor)}
                                                </p>
                                            {/if}
                                        </div>

                                        <!-- Duration (if available in custom_metadata) -->
                                        {#if item.custom_metadata?.duration}
                                            <span class="text-xs text-surface-500 flex-none">
                                                {formatDuration(item.custom_metadata.duration)}
                                            </span>
                                        {/if}
                                    </button>

                                    <!-- Admin controls (outside the main button to allow stopPropagation) -->
                                    {#if isAdmin && bulkModeActive}
                                        <div class="pr-5 flex-none">
                                            <input
                                                type="checkbox"
                                                class="w-4 h-4 rounded accent-primary-500 cursor-pointer"
                                                checked={selectedIds.has(item.id)}
                                                onchange={() => onToggleSelect(item.id)} />
                                        </div>
                                    {:else if isAdmin}
                                        <div
                                            class="pr-5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-none">
                                            <button
                                                class="text-xs px-1.5 py-0.5 rounded bg-primary-700/90 text-white"
                                                onclick={() => onOpenDrawer(item)}>
                                                Edit
                                            </button>
                                            <button
                                                class="text-xs px-1.5 py-0.5 rounded bg-surface-700 text-surface-300"
                                                onclick={() => onEditStart(item)}>
                                                Quick
                                            </button>
                                        </div>
                                    {/if}
                                </li>

                                <!-- Inline editor for this item (if active) -->
                                {#if editingItemId === item.id}
                                    <li
                                        class="px-5 py-2 bg-surface-700"
                                        role="presentation"
                                        onclick={(e) => e.stopPropagation()}
                                        onkeydown={(e) => e.stopPropagation()}>
                                        <div class="flex gap-2 max-w-sm">
                                            <input
                                                type="text"
                                                class="px-2 py-1 bg-surface-800 border border-surface-600 rounded text-xs text-white flex-1"
                                                placeholder="Course..."
                                                bind:value={editCategoryValue}
                                                onkeydown={(e) => {
                                                    if (e.key === 'Enter') onEditSave(item.id);
                                                    if (e.key === 'Escape') onEditCancel();
                                                }} />
                                            <button
                                                class="px-2 py-1 bg-primary-600 text-white rounded text-xs"
                                                disabled={savingCategory}
                                                onclick={() => onEditSave(item.id)}>
                                                {savingCategory ? '...' : 'OK'}
                                            </button>
                                            <button
                                                class="px-2 py-1 bg-surface-600 text-surface-300 rounded text-xs"
                                                onclick={onEditCancel}>
                                                X
                                            </button>
                                        </div>
                                    </li>
                                {/if}
                            {/each}
                        </ul>
                    </div>
                {/each}
            </div>
        </section>
    {/each}
</div>
