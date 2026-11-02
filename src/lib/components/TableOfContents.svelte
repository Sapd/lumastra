<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { browser } from '$app/environment';
    import { fly } from 'svelte/transition';
    import { Z } from '$lib/utils/z-index';
    import { SvelteMap } from 'svelte/reactivity';

    interface TocItem {
        id: string;
        name: string;
        icon?: string;
        imageUrl?: string;
    }

    interface Props {
        items?: TocItem[];
    }

    let { items = [] }: Props = $props();

    let activeId = $state<string | null>(null);
    let observer: IntersectionObserver | null = null;
    let visibleSections = new SvelteMap<string, number>();
    let scrollProgress = $state(0);
    let labelsRecentlyChanged = $state(false);
    let labelRevealTimeout: ReturnType<typeof setTimeout> | null = null;
    // On desktop the scroll surface is .main-content; on mobile (< lg) the
    // document itself scrolls so we listen on window and measure viewport.
    let scrollContainer: Element | null = null;
    let scrollSource: Element | Window | null = null;

    let desktopMQ: MediaQueryList | null = null;
    const rewireOnBreakpointChange = () => setupScrollListener();

    onMount(() => {
        if (browser) {
            setupObserver();
            setupScrollListener();
            desktopMQ = window.matchMedia('(min-width: 1024px)');
            desktopMQ.addEventListener('change', rewireOnBreakpointChange);
        }
    });

    onDestroy(() => {
        if (observer) {
            observer.disconnect();
        }
        teardownScrollListener();
        if (desktopMQ) {
            desktopMQ.removeEventListener('change', rewireOnBreakpointChange);
        }
        if (labelRevealTimeout) {
            clearTimeout(labelRevealTimeout);
        }
    });

    function isDesktop(): boolean {
        return window.matchMedia('(min-width: 1024px)').matches;
    }

    function setupScrollListener() {
        teardownScrollListener();
        if (isDesktop()) {
            scrollContainer = document.querySelector('.main-content');
            scrollSource = scrollContainer;
        } else {
            scrollContainer = null;
            scrollSource = window;
        }
        if (scrollSource) {
            scrollSource.addEventListener('scroll', scheduleScrollUpdate, {
                passive: true,
            });
            handleScroll();
        }
    }

    function teardownScrollListener() {
        if (scrollSource) {
            scrollSource.removeEventListener('scroll', scheduleScrollUpdate);
            scrollSource = null;
        }
        if (scrollFrame !== null) {
            cancelAnimationFrame(scrollFrame);
            scrollFrame = null;
        }
    }

    // handleScroll reads every section's rect, which forces a layout when the
    // page has pending style changes. Scroll events fire faster than frames, so
    // measure at most once per frame.
    let scrollFrame: number | null = null;
    function scheduleScrollUpdate(): void {
        if (scrollFrame !== null) return;
        scrollFrame = requestAnimationFrame(() => {
            scrollFrame = null;
            handleScroll();
        });
    }

    function handleScroll() {
        if (items.length === 0 || !scrollSource) return;

        // Desktop: measure relative to .main-content.
        // Mobile: measure relative to the viewport (window scroll).
        const viewportTop = scrollContainer ? scrollContainer.getBoundingClientRect().top : 0;
        const viewportHeight = scrollContainer
            ? scrollContainer.getBoundingClientRect().height
            : window.innerHeight;
        const triggerPoint = viewportTop + viewportHeight * 0.2;

        const sectionPositions: { id: string; top: number }[] = [];
        items.forEach((item) => {
            const element = document.querySelector(`[data-toc-id="${item.id}"]`);
            if (element) {
                const rect = element.getBoundingClientRect();
                sectionPositions.push({ id: item.id, top: rect.top });
            }
        });

        if (sectionPositions.length === 0) return;

        let progress = 0;
        for (let i = 0; i < sectionPositions.length; i++) {
            const current = sectionPositions[i];
            const next = sectionPositions[i + 1];

            if (current.top <= triggerPoint) {
                if (next && next.top > triggerPoint) {
                    const sectionHeight = next.top - current.top;
                    const rawProgress = (triggerPoint - current.top) / sectionHeight;
                    const cappedProgress = rawProgress > 0.7 ? (rawProgress - 0.7) / 0.3 : 0;
                    progress = i + cappedProgress;
                    break;
                } else if (!next) {
                    progress = i;
                }
            } else if (i === 0) {
                progress = 0;
                break;
            }
        }

        scrollProgress = Math.max(0, Math.min(progress, items.length - 1));
    }

    function setupObserver() {
        if (!browser) return;

        if (observer) {
            observer.disconnect();
        }

        observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    const id = entry.target.getAttribute('data-toc-id');
                    if (id) {
                        if (entry.isIntersecting) {
                            visibleSections.set(id, entry.intersectionRatio);
                        } else {
                            visibleSections.delete(id);
                        }
                    }
                });

                let maxRatio = 0;
                let mostVisibleId: string | null = null;

                visibleSections.forEach((ratio, id) => {
                    if (ratio > maxRatio) {
                        maxRatio = ratio;
                        mostVisibleId = id;
                    }
                });

                if (!mostVisibleId && visibleSections.size > 0) {
                    const visibleIds = Array.from(visibleSections.keys());
                    const orderedIds = items.map((item) => item.id);
                    for (const id of orderedIds) {
                        if (visibleIds.includes(id)) {
                            mostVisibleId = id;
                            break;
                        }
                    }
                }

                if (mostVisibleId) {
                    activeId = mostVisibleId;
                }
            },
            {
                root: null,
                rootMargin: '-10% 0px -70% 0px',
                threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
            },
        );

        requestAnimationFrame(() => {
            items.forEach((item) => {
                const element = document.querySelector(`[data-toc-id="${item.id}"]`);
                if (element && observer) {
                    observer.observe(element);
                }
            });
        });
    }

    $effect(() => {
        if (browser && items.length > 0) {
            setupObserver();
        }
    });

    $effect(() => {
        if (!browser || activeId === null) return;

        labelsRecentlyChanged = true;
        if (labelRevealTimeout) {
            clearTimeout(labelRevealTimeout);
        }
        labelRevealTimeout = setTimeout(() => {
            labelsRecentlyChanged = false;
            labelRevealTimeout = null;
        }, 1200);
    });

    function scrollToSection(id: string) {
        const element = document.querySelector(`[data-toc-id="${id}"]`);
        if (!element) return;

        const headerOffset = 80;
        const container = isDesktop() ? document.querySelector('.main-content') : null;

        if (container) {
            const containerRect = container.getBoundingClientRect();
            const elementRect = element.getBoundingClientRect();
            const scrollTop =
                container.scrollTop + (elementRect.top - containerRect.top) - headerOffset;
            container.scrollTo({ top: scrollTop, behavior: 'smooth' });
        } else {
            const elementRect = element.getBoundingClientRect();
            const top = window.scrollY + elementRect.top - headerOffset;
            window.scrollTo({ top, behavior: 'smooth' });
        }
    }

    // Built-in widget icons
    const builtInIconMap: Record<string, string> = {
        'watch-parties': '👥',
        'streaming-sessions': '📺',
        'for-you': '✨',
        trending: '🔥',
        'holiday-recommendations': '🎄',
        watchlist: '📋',
        'upcoming-episodes': '📅',
        calendar: '🗓️',
        'live-tv': '📡',
    };

    // Get icon for a widget (built-in or plugin)
    function getWidgetIcon(id: string): string {
        if (builtInIconMap[id]) {
            return builtInIconMap[id];
        }
        // Default icon for plugin widgets
        return '🔌';
    }

    // Forward wheel events to the underlying scroll surface so scrolling over
    // the TOC still moves the page.
    function handleWheel(event: WheelEvent) {
        const opts = {
            top: event.deltaY,
            left: event.deltaX,
            behavior: 'auto' as const,
        };
        if (scrollContainer) {
            scrollContainer.scrollBy(opts);
        } else {
            window.scrollBy(opts);
        }
    }
</script>

<!-- Right side progress indicator -->
<nav
    class="toc-container fixed right-4 top-1/2 -translate-y-1/2 hidden md:block pointer-events-none"
    style="z-index: {Z.TOC}"
    aria-label="Section navigation"
    in:fly={{ x: 20, duration: 300 }}
    onwheel={handleWheel}>
    <div class="toc-track relative">
        <div class="toc-dots group/nav relative pointer-events-auto">
            <!-- Vertical line -->
            <div class="absolute left-1/2 -translate-x-1/2 top-3 bottom-3 w-px bg-surface-700/50">
            </div>

            <!-- Progress fill -->
            {#if scrollProgress >= 0}
                <div
                    class="absolute left-1/2 -translate-x-1/2 top-3 w-0.5 bg-primary-500/50 rounded-full"
                    style="height: {scrollProgress * 40}px">
                </div>
            {/if}

            <!-- Dots -->
            <div class="relative flex flex-col items-center gap-4">
                {#each items as item (item.id)}
                    <button
                        class="toc-dot relative center w-6 h-6"
                        class:active={activeId === item.id}
                        onclick={() => scrollToSection(item.id)}
                        aria-label="Go to {item.name}">
                        <span
                            class="w-2.5 h-2.5 rounded-full transition-all duration-200 border-2"
                            class:bg-primary-500={activeId === item.id}
                            class:border-primary-500={activeId === item.id}
                            class:scale-125={activeId === item.id}
                            class:bg-transparent={activeId !== item.id}
                            class:border-surface-500={activeId !== item.id}
                            class:hover:border-surface-300={activeId !== item.id}
                            class:hover:scale-110={activeId !== item.id}></span>
                    </button>
                {/each}
            </div>

            <!-- Labels panel (on hover) -->
            <div
                class="toc-labels absolute right-full top-0 pr-3 flex flex-col gap-4 opacity-0 group-hover/nav:opacity-100 translate-x-2 group-hover/nav:translate-x-0 transition-all duration-200 pointer-events-none group-hover/nav:pointer-events-auto"
                class:opacity-100={labelsRecentlyChanged}
                class:translate-x-0={labelsRecentlyChanged}>
                {#each items as item (item.id)}
                    <button
                        class="toc-label-btn h-6 flex items-center justify-end"
                        class:active={activeId === item.id}
                        onclick={() => scrollToSection(item.id)}>
                        <span
                            class="toc-label-text px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150 flex items-center"
                            class:active={activeId === item.id}>
                            {#if item.imageUrl}
                                <img
                                    src={item.imageUrl}
                                    alt=""
                                    class="mr-1.5 w-4 h-4 object-contain rounded-sm flex-shrink-0" />
                            {:else}
                                <span class="mr-1.5">{item.icon ?? getWidgetIcon(item.id)}</span>
                            {/if}
                            {item.name}
                        </span>
                    </button>
                {/each}
            </div>
        </div>
    </div>
</nav>

<style lang="postcss">
    .toc-dot {
        cursor: pointer;
    }

    .toc-label-text {
        background: rgb(var(--color-surface-800-rgb) / 0.8);
        color: var(--color-surface-300);
    }

    .toc-label-text:hover {
        background: rgb(var(--color-surface-700-rgb) / 0.8);
        color: var(--color-surface-200);
    }

    .toc-label-text.active {
        background: rgb(var(--color-primary-500-rgb) / 0.2);
        color: var(--color-primary-400);
    }

    .toc-container {
        animation: slideIn 0.4s ease-out;
    }

    @keyframes slideIn {
        from {
            opacity: 0;
            transform: translate(10px, -50%);
        }
        to {
            opacity: 1;
            transform: translate(0, -50%);
        }
    }
</style>
