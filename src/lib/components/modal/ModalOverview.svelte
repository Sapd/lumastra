<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';

    let {
        overview,
        parts = null,
        id,
    }: {
        overview: string;
        parts?: { label: string; text: string }[] | null;
        id: string;
    } = $props();

    let expandedText = $state<string>();
    const expanded = $derived(expandedText === overview);
    let overflowing = $state(false);

    // Measure the natural content, including combined episode labels. Character
    // counts cannot predict wrapping, font size or the width of a split pane.
    function measureOverview(content: HTMLElement): () => void {
        function measure(): void {
            const style = getComputedStyle(content);
            const limit =
                Number(style.getPropertyValue('--overview-lines')) * parseFloat(style.lineHeight);
            overflowing = content.scrollHeight > limit + 1;
        }

        const observer = new ResizeObserver(measure);
        observer.observe(content);
        // Height-only viewport changes can change the line budget even when the
        // natural content size stays the same (particularly while expanded).
        window.addEventListener('resize', measure);
        measure();
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', measure);
        };
    }
</script>

<div class="overview">
    <div {id} class="description" class:collapsed={!expanded}>
        <div class="overview-content" {@attach measureOverview}>
            {#if parts}
                {#each parts as part, index (index)}
                    <div class="overview-part">
                        <span class="part-label">{part.label}</span>
                        <p>{part.text}</p>
                    </div>
                {/each}
            {:else}
                {overview}
            {/if}
        </div>
    </div>
    {#if overflowing}
        <button
            type="button"
            class="overview-toggle"
            aria-controls={id}
            aria-expanded={expanded}
            onclick={() => (expandedText = expanded ? undefined : overview)}>
            {expanded ? m.section_show_less() : m.section_show_more()}
        </button>
    {/if}
</div>

<style>
    .overview {
        --overview-lines: 4;
        flex-shrink: 0;
        min-width: 0;
        font-size: 0.875rem;
        line-height: 1.75;
        color: var(--color-surface-300);
    }
    .description {
        overflow-wrap: anywhere;
    }
    .collapsed {
        max-height: calc(var(--overview-lines) * 1lh);
        overflow: hidden;
    }
    .overview-part + .overview-part {
        margin-top: 0.5rem;
    }
    .part-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-primary-400);
    }
    p {
        margin: 0;
    }
    .overview-toggle {
        display: block;
        margin-top: 0.5rem;
        padding: 0.25rem 0;
        border: 0;
        background: transparent;
        color: var(--color-primary-300);
        font-size: 0.75rem;
        cursor: pointer;
    }
    .overview-toggle:hover {
        color: var(--color-primary-200);
    }
    .overview-toggle:focus-visible {
        outline: 2px solid var(--color-primary-500);
        outline-offset: 2px;
        border-radius: 2px;
    }
    @media (max-width: 639px) {
        .overview {
            --overview-lines: 3;
        }
    }
    @media (min-width: 640px) and (min-height: 720px) {
        .overview {
            --overview-lines: 6;
        }
    }
    @media (min-width: 1024px) and (min-height: 900px) {
        .overview {
            --overview-lines: 10;
        }
    }
</style>
