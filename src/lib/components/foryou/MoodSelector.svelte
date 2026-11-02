<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    MoodSelector Component

    Horizontal scrollable chip list for selecting mood-based recommendations.
    Suggested moods (time-based) are highlighted with primary color.
    Supports multi-select; selected moods show a checkmark indicator.
    Progressively reveals more chips as the user scrolls to the right edge
    (handled by ChipScrollRow).

    @example
    <MoodSelector
        selectedMoods={[]}
        suggestedMoods={['relaxing', 'cozy']}
        availableMoods={moods}
        loading={false}
        onselect={(moods) => handleMoodSelect(moods)}
    />
-->
<script lang="ts">
    import { Icon, Check, ArrowPath, Sparkles, XMark } from 'svelte-hero-icons';
    import ChipScrollRow from '$lib/components/ui/ChipScrollRow.svelte';
    import * as m from '$lib/paraglide/messages';

    export interface MoodInfo {
        key: string;
        displayName: string;
        description: string;
    }

    interface Props {
        /** Currently selected moods (empty = auto/time-based) */
        selectedMoods: string[];
        /** Time-based suggested moods (highlighted with primary color) */
        suggestedMoods: string[];
        /** All available moods with metadata */
        availableMoods: MoodInfo[];
        /** Loading state while fetching recommendations */
        loading: boolean;
        /** Callback when mood selection changes */
        onselect: (moods: string[]) => void;
    }

    let { selectedMoods, suggestedMoods, availableMoods, loading, onselect }: Props = $props();

    // Sort moods: suggested first, then alphabetically
    let sortedMoods = $derived.by(() => {
        const suggested = availableMoods.filter((mood) => suggestedMoods.includes(mood.key));
        const others = availableMoods.filter((mood) => !suggestedMoods.includes(mood.key));
        others.sort((a, b) => a.displayName.localeCompare(b.displayName));
        return [...suggested, ...others];
    });

    let isAuto = $derived(selectedMoods.length === 0);

    function isSelected(moodKey: string): boolean {
        return selectedMoods.includes(moodKey);
    }

    function handleSelect(moodKey: string | null, e?: MouseEvent | KeyboardEvent): void {
        if (loading) return;
        if (moodKey === null) {
            onselect([]);
            return;
        }
        const alreadySelected = isSelected(moodKey);
        let next: string[];
        if (e?.shiftKey) {
            next = alreadySelected
                ? selectedMoods.filter((k) => k !== moodKey)
                : [...selectedMoods, moodKey];
        } else {
            next = alreadySelected && selectedMoods.length === 1 ? [] : [moodKey];
        }
        onselect(next);
    }

    function handleKeydown(e: KeyboardEvent, mood: string | null): void {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleSelect(mood, e);
        }
    }

    function handleClearKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onselect([]);
        }
    }

    function getChipClasses(moodKey: string | null): string {
        const selected = moodKey === null ? isAuto : isSelected(moodKey);
        const isSuggested = moodKey !== null && suggestedMoods.includes(moodKey);

        if (selected) {
            return 'bg-primary-500/20 text-primary-300 ring-1 ring-primary-500/50';
        }
        if (isSuggested && isAuto) {
            return 'bg-primary-500/10 text-primary-200/80 hover:bg-primary-500/20';
        }
        return 'bg-surface-700 text-surface-200 hover:bg-surface-600';
    }
</script>

<div class="flex items-center gap-2">
    <span class="mood-selector-label shrink-0 text-sm font-medium text-surface-300">
        {m.mood_selector_label()}
    </span>
    <div class="min-w-0 flex-1">
        <ChipScrollRow totalCount={sortedMoods.length}>
            {#snippet children(visibleCount)}
                <!-- Screen-reader hint for multi-select; visually hidden -->
                <span class="sr-only">{m.mood_multiselect_hint()}</span>

                <!-- Auto chip (resets to time-based selection) -->
                <div
                    role="button"
                    tabindex={loading ? -1 : 0}
                    aria-pressed={isAuto}
                    data-drag-scroll-allow
                    class="mood-chip shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all {getChipClasses(
                        null,
                    )}"
                    class:opacity-50={loading}
                    class:pointer-events-none={loading}
                    onclick={() => handleSelect(null)}
                    onkeydown={(e) => handleKeydown(e, null)}
                    title={m.mood_auto_description()}>
                    {#if isAuto}
                        <Icon src={Check} class="w-4 h-4" />
                    {:else}
                        <Icon src={Sparkles} class="w-4 h-4" />
                    {/if}
                    <span>{m.mood_auto()}</span>
                </div>

                <!-- Clear all button — visible only when moods are selected -->
                {#if !isAuto}
                    <div
                        role="button"
                        tabindex={loading ? -1 : 0}
                        aria-label={m.mood_clear_selection()}
                        data-drag-scroll-allow
                        class="mood-chip shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all bg-surface-600 text-surface-300 hover:bg-red-500/20 hover:text-red-300"
                        class:opacity-50={loading}
                        class:pointer-events-none={loading}
                        onclick={() => onselect([])}
                        onkeydown={handleClearKeydown}>
                        <Icon src={XMark} class="w-4 h-4" />
                    </div>
                {/if}

                <!-- Mood chips (progressively revealed by ChipScrollRow) -->
                {#each sortedMoods.slice(0, visibleCount) as mood (mood.key)}
                    <div
                        role="button"
                        tabindex={loading ? -1 : 0}
                        aria-pressed={isSelected(mood.key)}
                        data-drag-scroll-allow
                        class="mood-chip shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all {getChipClasses(
                            mood.key,
                        )}"
                        class:opacity-50={loading}
                        class:pointer-events-none={loading}
                        onclick={(e) => handleSelect(mood.key, e)}
                        onkeydown={(e) => handleKeydown(e, mood.key)}
                        title={mood.description}>
                        {#if isSelected(mood.key)}
                            {#if loading}
                                <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                            {:else}
                                <Icon src={Check} class="w-4 h-4" />
                            {/if}
                        {/if}
                        <span>{mood.displayName}</span>
                    </div>
                {/each}
            {/snippet}
        </ChipScrollRow>
    </div>
</div>

<style lang="postcss">
    .mood-chip {
        cursor: pointer;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        user-select: none;
        white-space: nowrap;
    }

    .mood-chip * {
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        user-select: none;
    }

    .mood-chip.pointer-events-none {
        cursor: not-allowed;
    }

    .mood-chip:not(.pointer-events-none):hover {
        transform: translateY(-1px);
    }

    .mood-chip:not(.pointer-events-none):active {
        transform: translateY(0);
    }

    .mood-chip:focus-visible {
        outline: 2px solid var(--color-primary-500);
        outline-offset: 2px;
    }
</style>
