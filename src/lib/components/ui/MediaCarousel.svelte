<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    interface Props {
        /**
         * Reusable horizontal scrolling carousel component
         * Used for displaying media cards in a scrollable row
         * Supports mouse wheel scrolling and drag-to-scroll
         */
        scrollbarClass?: string;
        gap?: string; // CSS gap value (e.g., '1rem', '16px')
        disableVerticalWheel?: boolean; // If true, only horizontal wheel events scroll the carousel
        children?: import('svelte').Snippet;
    }

    let {
        scrollbarClass = 'smooth-scroll',
        gap = '1rem',
        disableVerticalWheel = false,
        children,
    }: Props = $props();

    let carousel: HTMLDivElement;
    let isDown = false;
    let startX: number;
    let scrollLeft: number;
    let showLeftGradient = $state(false);
    let showRightGradient = $state(false);

    function updateGradients() {
        if (!carousel) return;

        const { scrollLeft, scrollWidth, clientWidth } = carousel;
        const scrollRight = scrollWidth - clientWidth - scrollLeft;

        // Show left gradient if scrolled more than 10px from left
        showLeftGradient = scrollLeft > 10;

        // Show right gradient if more than 10px of content to the right
        showRightGradient = scrollRight > 10;
    }

    function handleWheel(e: WheelEvent) {
        if (!carousel) return;

        // If disableVerticalWheel is true, only respond to horizontal wheel events (trackpad gestures)
        if (disableVerticalWheel && e.deltaX === 0) {
            // Vertical scroll - let the page handle it
            return;
        }

        // Determine scroll delta (prefer deltaX for trackpad horizontal gestures)
        const scrollDelta = e.deltaX !== 0 ? e.deltaX : e.deltaY;

        // Check if carousel can scroll in the requested direction
        const { scrollLeft, scrollWidth, clientWidth } = carousel;
        const maxScrollLeft = scrollWidth - clientWidth;

        const canScrollLeft = scrollLeft > 0;
        const canScrollRight = scrollLeft < maxScrollLeft;
        const tryingToScrollLeft = scrollDelta < 0;
        const tryingToScrollRight = scrollDelta > 0;

        // Only intercept if carousel can actually scroll in that direction
        const shouldIntercept =
            (tryingToScrollLeft && canScrollLeft) || (tryingToScrollRight && canScrollRight);

        if (shouldIntercept) {
            e.preventDefault();
            carousel.scrollLeft += scrollDelta;
            updateGradients();
        }
        // Otherwise, let the page scroll normally
    }

    function handleMouseDown(e: MouseEvent) {
        if (!carousel) return;
        isDown = true;
        carousel.style.cursor = 'grabbing';
        carousel.style.userSelect = 'none';
        startX = e.pageX - carousel.offsetLeft;
        scrollLeft = carousel.scrollLeft;
    }

    function handleMouseLeave() {
        isDown = false;
        if (carousel) {
            carousel.style.cursor = 'grab';
            carousel.style.userSelect = '';
        }
    }

    function handleMouseUp() {
        isDown = false;
        if (carousel) {
            carousel.style.cursor = 'grab';
            carousel.style.userSelect = '';
        }
    }

    function handleMouseMove(e: MouseEvent) {
        if (!isDown || !carousel) return;
        e.preventDefault();
        const x = e.pageX - carousel.offsetLeft;
        const walk = (x - startX) * 2; // Scroll speed multiplier
        carousel.scrollLeft = scrollLeft - walk;
        updateGradients();
    }

    function handleScroll() {
        updateGradients();
    }

    function handleKeydown(e: KeyboardEvent) {
        if (!carousel) return;
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            carousel.scrollLeft -= 300;
            updateGradients();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            carousel.scrollLeft += 300;
            updateGradients();
        } else if (e.key === 'Home') {
            e.preventDefault();
            carousel.scrollLeft = 0;
            updateGradients();
        } else if (e.key === 'End') {
            e.preventDefault();
            carousel.scrollLeft = carousel.scrollWidth;
            updateGradients();
        }
    }

    function handleCarouselBind(node: HTMLDivElement) {
        carousel = node;
        // Initial gradient check after content loads
        setTimeout(updateGradients, 100);
    }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
    use:handleCarouselBind
    class={`pb-4 -mx-4 px-4 ${scrollbarClass} carousel-container`}
    class:show-left-gradient={showLeftGradient}
    class:show-right-gradient={showRightGradient}
    style="overflow-x: scroll; cursor: grab;"
    onwheel={handleWheel}
    onmousedown={handleMouseDown}
    onmouseleave={handleMouseLeave}
    onmouseup={handleMouseUp}
    onmousemove={handleMouseMove}
    onscroll={handleScroll}
    onkeydown={handleKeydown}
    role="region"
    aria-label={m.ui_media_carousel_aria()}
    tabindex="0">
    <div class="flex" style="width: max-content; gap: {gap};">
        {@render children?.()}
    </div>
</div>

<style>
    .carousel-container {
        -webkit-mask-image: linear-gradient(to right, black, black);
        mask-image: linear-gradient(to right, black, black);
        transition:
            -webkit-mask-image 0.3s ease,
            mask-image 0.3s ease;
    }

    /* Show gradient on left when scrolled */
    .carousel-container.show-left-gradient {
        -webkit-mask-image: linear-gradient(
            to right,
            transparent 0%,
            rgba(0, 0, 0, 0.3) 40px,
            black 150px,
            black 100%
        );
        mask-image: linear-gradient(
            to right,
            transparent 0%,
            rgba(0, 0, 0, 0.3) 40px,
            black 150px,
            black 100%
        );
    }

    /* Show gradient on right when more content */
    .carousel-container.show-right-gradient {
        -webkit-mask-image: linear-gradient(
            to right,
            black 0%,
            black calc(100% - 150px),
            rgba(0, 0, 0, 0.3) calc(100% - 40px),
            transparent 100%
        );
        mask-image: linear-gradient(
            to right,
            black 0%,
            black calc(100% - 150px),
            rgba(0, 0, 0, 0.3) calc(100% - 40px),
            transparent 100%
        );
    }

    /* Show gradients on both sides */
    .carousel-container.show-left-gradient.show-right-gradient {
        -webkit-mask-image: linear-gradient(
            to right,
            transparent 0%,
            rgba(0, 0, 0, 0.3) 40px,
            black 150px,
            black calc(100% - 150px),
            rgba(0, 0, 0, 0.3) calc(100% - 40px),
            transparent 100%
        );
        mask-image: linear-gradient(
            to right,
            transparent 0%,
            rgba(0, 0, 0, 0.3) 40px,
            black 150px,
            black calc(100% - 150px),
            rgba(0, 0, 0, 0.3) calc(100% - 40px),
            transparent 100%
        );
    }
</style>
