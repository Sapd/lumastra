<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	Tooltip.svelte

	A reusable tooltip component that displays on hover/focus.

	@example Basic usage
	<Tooltip text="This is a tooltip">
		<button>Hover me</button>
	</Tooltip>

	@example With position
	<Tooltip text="Tooltip on bottom" position="bottom">
		<span>Some content</span>
	</Tooltip>

	@example With fixed positioning (escapes overflow containers)
	<Tooltip text="Fixed tooltip" position="bottom" fixed>
		<span>Some content in overflow container</span>
	</Tooltip>
-->
<script module lang="ts">
    // Module-level counter shared across all Tooltip instances.
    // Produces stable, incrementing IDs that are consistent between SSR and
    // client (unlike Math.random()) as long as server and client render the
    // same component tree in the same order. If SSR/client mismatch becomes an
    // issue, switch to crypto.randomUUID() inside onMount. For the current
    // server-driven UI pattern this is not a concern.
    let tooltipInstanceCounter = 0;
    export function nextTooltipId(): string {
        return `tt-${++tooltipInstanceCounter}`;
    }

    /**
     * A single styled line of tooltip content. Rendered via `textContent`/
     * Svelte auto-escaping (never `innerHTML`), so `class` may only select
     * from a fixed set of trusted CSS classes — it must never be built from
     * user/media-supplied strings.
     */
    export interface TooltipLine {
        text: string;
        class?: string;
    }
</script>

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { browser } from '$app/environment';
    import {
        computePosition,
        autoUpdate,
        offset,
        shift,
        flip,
        type Placement,
    } from '@floating-ui/dom';

    /** Whether the tooltip is currently visible */
    let isVisible = $state(false);
    // Touch browsers synthesize mouseleave after click. Informational callers
    // that opt out of click toggling keep that click-open bubble until an
    // explicit dismissal (outside interaction, blur, timeout or another tooltip).
    let clickPinned = false;

    interface Props {
        /** Tooltip text to display. Optional when `lines` is provided instead. */
        text?: string;
        /**
         * Optional multi-line, per-line-styled content. Takes precedence
         * over `text` when provided. Use this instead of embedding HTML in
         * `text` — `text` is always rendered as plain text (F64 XSS
         * hardening), so raw `<span>`/`<br>` markup shows up literally.
         */
        lines?: TooltipLine[];
        /** Optional branding shown above the required text or lines inside the bubble. */
        image?: { src: string; alt: string; width: number; height: number };
        /** Position of the tooltip relative to the trigger */
        position?: 'top' | 'bottom' | 'left' | 'right';
        /** Use fixed positioning to escape overflow containers (renders in body portal) */
        fixed?: boolean;
        /** Delay before showing tooltip (ms) */
        delay?: number;
        /**
         * Let the bubble wrap onto multiple lines instead of staying on one.
         * Tooltips default to `white-space: nowrap` (labels, short hints); a
         * sentence-length body (e.g. "what does this pipeline step do") needs
         * this or it renders as one viewport-wide strip.
         */
        wrap?: boolean;
        /**
         * Extra classes for the trigger wrapper. Use this to thread flex
         * sizing constraints (e.g. `min-w-0 max-w-full`) down to the wrapper
         * so a `truncate` child inside the slot can still ellipsize.
         */
        triggerClass?: string;
        /**
         * Render the trigger wrapper as an inline <span> instead of a <div>.
         * Use inside phrasing-only contexts (e.g. a child of <button>) where a
         * <div> would be invalid HTML. Pair with `fixed` so the tooltip itself
         * renders in the body portal (a non-fixed tooltip <div> inside a <span>
         * would also be invalid).
         */
        inline?: boolean;
        /**
         * Suppress the tooltip entirely. Use when another surface takes over the
         * same hover — e.g. the episode hover panel replaces the row's "Show
         * details" hint. Blanking `text` does NOT work for `fixed` tooltips: the
         * fixed path builds its bubble imperatively in createPortalContent(), so
         * only the non-fixed branch reacts to a later `text` change.
         */
        disabled?: boolean;
        /**
         * Whether this Tooltip manages `aria-describedby` on its focusable
         * trigger child. Default `true`. Set `false` when a caller already
         * owns that attribute on the same element — e.g. the episode hover
         * panel describes the row's focusable block directly, and without
         * this both would fight over the attribute, with Tooltip's own
         * show/hide effect winning and clobbering the caller's value.
         */
        manageDescribedBy?: boolean;
        /** Keep focus-opened informational bubbles visible on the following touch click. */
        toggleOnClick?: boolean;
        children?: import('svelte').Snippet;
    }

    let {
        text,
        lines,
        image,
        position = 'top',
        fixed = false,
        delay = 200,
        wrap = false,
        triggerClass = '',
        inline = false,
        disabled = false,
        manageDescribedBy = true,
        toggleOnClick = true,
        children,
    }: Props = $props();

    function hasContent(): boolean {
        return (lines?.length ?? 0) > 0 || Boolean(text?.trim());
    }

    let showTimeout: ReturnType<typeof setTimeout>;
    let hideTimeout: ReturnType<typeof setTimeout>;
    let triggerElement: HTMLElement | undefined = $state();
    let tooltipElement: HTMLDivElement | undefined = $state();
    let portalElement = $state<HTMLDivElement | null>(null);
    let cleanupAutoUpdate: (() => void) | undefined;
    let triggerObserver: MutationObserver | undefined;

    // Unique ID for this tooltip instance derived from the module-level counter.
    const tooltipId = nextTooltipId();

    // Convert position prop to floating-ui placement
    const placementMap: Record<string, Placement> = {
        top: 'top',
        bottom: 'bottom',
        left: 'left',
        right: 'right',
    };

    function updatePosition() {
        const reference = triggerElement;
        const floating = fixed
            ? (portalElement?.querySelector('.tooltip-fixed') as HTMLElement)
            : tooltipElement;

        if (!reference || !floating) return;

        cleanupAutoUpdate?.();
        cleanupAutoUpdate = autoUpdate(reference, floating, () => {
            void computePosition(reference, floating, {
                strategy: fixed ? 'fixed' : 'absolute',
                placement: placementMap[position] || 'top',
                middleware: [offset(8), flip(), shift({ padding: 5 })],
            }).then(({ x, y }) => {
                Object.assign(floating.style, {
                    left: `${x}px`,
                    top: `${y}px`,
                });
                // Reveal only now that it is positioned — see createPortalContent().
                if (fixed) floating.style.visibility = 'visible';
            });
        });
    }

    // Listen for other tooltips showing - hide this one.
    // If the showing tooltip's trigger is nested inside ours, also cancel any
    // pending show — otherwise both tooltips can briefly appear together when
    // the outer's delay timer fires after the inner has already shown.
    function handleOtherTooltipShow(e: Event) {
        const detail = (e as CustomEvent<{ id?: string; trigger?: HTMLElement }>).detail;
        if (detail?.id === tooltipId) return;
        const isAncestorOfShowing =
            detail?.trigger != null &&
            triggerElement != null &&
            triggerElement !== detail.trigger &&
            triggerElement.contains(detail.trigger);
        if (isAncestorOfShowing) {
            clearTimeout(showTimeout);
        }
        if (isVisible) hideTooltip();
    }

    // Create portal element for fixed tooltips
    onMount(() => {
        if (!browser) return;
        if (fixed) {
            portalElement = document.createElement('div');
            portalElement.className = 'tooltip-portal';
            document.body.appendChild(portalElement);
        }

        // Close tooltip when clicking or touching outside (for mobile).
        // `pointerdown` fires before `click` and is not cancelled by drag,
        // making it a more reliable dismiss backstop on touch devices.
        document.addEventListener('click', handleDocumentClick);
        document.addEventListener('pointerdown', handleDocumentPointerDown);
        // Listen for other tooltips showing
        document.addEventListener('tooltip-show', handleOtherTooltipShow);

        // Hide the tooltip if the trigger element is removed from the DOM
        // during an SSE re-render while the tooltip is visible.
        triggerObserver = new MutationObserver(() => {
            if (isVisible && triggerElement && !document.contains(triggerElement)) {
                hideTooltip();
            }
        });
        triggerObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });
    });

    onDestroy(() => {
        cleanupAutoUpdate?.();
        triggerObserver?.disconnect();
        if (portalElement) {
            portalElement.remove();
        }
        clearTimeout(showTimeout);
        clearTimeout(hideTimeout);
        if (browser) {
            document.removeEventListener('click', handleDocumentClick);
            document.removeEventListener('pointerdown', handleDocumentPointerDown);
            document.removeEventListener('tooltip-show', handleOtherTooltipShow);
        }
    });

    function handleDocumentClick(e: MouseEvent) {
        // If tooltip is visible and click is outside trigger, hide it
        if (isVisible && triggerElement && !triggerElement.contains(e.target as Node)) {
            hideTooltip();
        }
    }

    function handleDocumentPointerDown(e: PointerEvent) {
        // Backstop for touch/drag: pointerdown is not cancelled by drag so it
        // reliably dismisses when the user drags away from the trigger.
        if (isVisible && triggerElement && !triggerElement.contains(e.target as Node)) {
            hideTooltip();
        }
    }

    function handleMouseEnter(e: MouseEvent) {
        if (!browser) return;
        // No text → nothing to show. Lets callers pass a conditional/empty
        // string to suppress the tooltip without conditional markup, and avoids
        // rendering an empty bubble.
        if (disabled || !hasContent()) return;
        // Stop propagation to prevent parent tooltips from triggering
        e.stopPropagation();
        // Re-entering a click-pinned bubble must preserve its dismissal deadline.
        if (clickPinned) return;
        clearTimeout(hideTimeout);
        showTimeout = setTimeout(() => {
            if (fixed) {
                createPortalContent();
            }
            isVisible = true;
            // Schedule position update after DOM updates
            requestAnimationFrame(() => updatePosition());
            // Notify other tooltips to hide
            document.dispatchEvent(
                new CustomEvent('tooltip-show', {
                    detail: { id: tooltipId, trigger: triggerElement },
                }),
            );
        }, delay);
    }

    function handleMouseLeave(e: MouseEvent) {
        if (!browser) return;
        // Stop propagation to prevent parent tooltips from hiding prematurely
        e.stopPropagation();
        clearTimeout(showTimeout);
        if (!clickPinned) hideTooltip();
    }

    function handleFocus() {
        if (disabled || !hasContent()) return;
        clearTimeout(hideTimeout);
        if (fixed) {
            createPortalContent();
        }
        isVisible = true;
        // Schedule position update after DOM updates
        requestAnimationFrame(() => updatePosition());
        // Notify other tooltips to hide
        document.dispatchEvent(new CustomEvent('tooltip-show', { detail: { id: tooltipId } }));
    }

    function handleBlur() {
        hideTooltip();
    }

    // Handle tap/click for mobile - toggle tooltip
    function handleClick(e: MouseEvent) {
        if (disabled || !hasContent()) return;
        // Prevent the click from immediately closing via document click handler
        e.stopPropagation();

        if (isVisible && toggleOnClick) {
            hideTooltip();
        } else {
            clickPinned = !toggleOnClick;
            clearTimeout(hideTimeout);
            if (fixed) {
                createPortalContent();
            }
            isVisible = true;
            // Schedule position update after DOM updates
            requestAnimationFrame(() => updatePosition());
            // Notify other tooltips to hide
            document.dispatchEvent(
                new CustomEvent('tooltip-show', {
                    detail: { id: tooltipId, trigger: triggerElement },
                }),
            );

            // Auto-hide after 3 seconds on mobile
            hideTimeout = setTimeout(() => {
                hideTooltip();
            }, 3000);
        }
    }

    function hideTooltip() {
        clickPinned = false;
        clearTimeout(showTimeout);
        cleanupAutoUpdate?.();
        cleanupAutoUpdate = undefined;
        isVisible = false;
        if (portalElement) {
            portalElement.textContent = '';
        }
    }

    function createPortalContent() {
        if (!portalElement) return;
        // Build tooltip DOM programmatically so tooltip text is never
        // treated as HTML — eliminates stored-XSS via media metadata or
        // usernames (F64).
        portalElement.textContent = '';
        const outer = document.createElement('div');
        outer.id = `tooltip-${tooltipId}`;
        outer.className = 'tooltip-fixed';
        outer.role = 'tooltip';
        // `.tooltip-fixed` has no `top`/`left` of its own — until updatePosition()
        // sets them (after the position-computing promise below resolves), a fixed
        // element with no offsets renders at its containing block's static
        // position, which for `.tooltip-portal` (fixed, 0×0, top:0/left:0) is the
        // viewport's top-left corner. That showed as a stray grey box flashing
        // near the top-left of the page — closest to whatever is sticky there,
        // e.g. a settings page's section nav — every time a `fixed` tooltip
        // opened. Hidden until updatePosition() has placed it.
        outer.style.visibility = 'hidden';
        const inner = document.createElement('div');
        inner.className = wrap ? 'tooltip-content tooltip-content-wrap' : 'tooltip-content';
        if (lines?.length) {
            for (const line of lines) {
                const lineEl = document.createElement('div');
                if (line.class) lineEl.className = line.class;
                lineEl.textContent = line.text;
                inner.appendChild(lineEl);
            }
        } else {
            // `text` is optional — `lines` is the alternative content source.
            inner.textContent = text ?? '';
        }
        if (image) {
            const logo = document.createElement('img');
            logo.src = image.src;
            logo.alt = image.alt;
            logo.width = image.width;
            logo.height = image.height;
            logo.className = 'mx-auto mb-2';
            inner.prepend(logo);
        }
        outer.appendChild(inner);
        portalElement.appendChild(outer);
    }

    // Update position reactively when visible
    $effect(() => {
        if (isVisible && triggerElement) {
            requestAnimationFrame(() => updatePosition());
        }
    });

    // Retract an already-open bubble when the caller disables us mid-hover. The
    // show-path guards above only run on enter, so without this a tooltip that
    // opened first would stay up.
    $effect(() => {
        if (disabled && isVisible) {
            hideTooltip();
        }
    });

    // Apply aria-describedby to the first interactive descendant so screen
    // readers announce the tooltip when focus lands on the actual trigger
    // (button/link) rather than on this wrapper div.
    $effect(() => {
        if (!manageDescribedBy) return;
        if (!triggerElement) return;
        const INTERACTIVE =
            'button, a, [role="button"], input, select, textarea, [tabindex]:not([tabindex="-1"])';
        const interactiveChild = triggerElement.querySelector<HTMLElement>(INTERACTIVE);
        const target = interactiveChild ?? triggerElement;
        if (isVisible) {
            target.setAttribute('aria-describedby', `tooltip-${tooltipId}`);
        } else {
            target.removeAttribute('aria-describedby');
        }
    });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:element
    this={inline ? 'span' : 'div'}
    class="relative inline-flex {triggerClass}"
    bind:this={triggerElement}
    onmouseenter={handleMouseEnter}
    onmouseleave={handleMouseLeave}
    onfocusin={handleFocus}
    onfocusout={handleBlur}
    onclick={handleClick}>
    {@render children?.()}

    {#if isVisible && (lines?.length || text) && !fixed}
        <div
            id="tooltip-{tooltipId}"
            bind:this={tooltipElement}
            class="tooltip z-50 pointer-events-none"
            role="tooltip">
            <div
                class="px-3 py-2 text-xs font-medium text-white bg-surface-700 rounded-lg shadow-lg border border-surface-600 {wrap
                    ? 'max-w-xs whitespace-normal'
                    : 'whitespace-nowrap'}">
                {#if image}
                    <img
                        src={image.src}
                        alt={image.alt}
                        width={image.width}
                        height={image.height}
                        class="mx-auto mb-2" />
                {/if}
                {#if lines?.length}
                    {#each lines as line, i (i)}
                        <div class={line.class}>{line.text}</div>
                    {/each}
                {:else}
                    {text}
                {/if}
            </div>
        </div>
    {/if}
</svelte:element>

<!-- Global styles for portal-rendered tooltips (outside component scope) -->
<!-- Tooltip portal styles moved to src/lib/styles/global-components.css so
     the CSS lives in CSSOM exactly once instead of being injected per
     instance via <svelte:head>. -->

<style>
    .tooltip {
        position: absolute;
        width: max-content;
        animation: tooltip-fade-in 0.15s ease-out;
    }

    @keyframes tooltip-fade-in {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
</style>
