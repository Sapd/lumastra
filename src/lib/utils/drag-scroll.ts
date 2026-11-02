// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Svelte action for drag-to-scroll functionality
 * Apply to any horizontally scrollable container to enable mouse drag scrolling
 *
 * Usage:
 * <div use:dragScroll>...</div>
 * <div use:dragScroll={{ onScrollNear: () => loadMore() }}>...</div>
 */

export interface DragScrollOptions {
    /** Distance from end to trigger onScrollNear callback (default: 200) */
    nearEndThreshold?: number;
    /** Scroll speed multiplier (default: 2) */
    scrollSpeed?: number;
    /** Minimum drag distance to count as a drag vs click (default: 5) */
    dragThreshold?: number;
    /** Callback when scrolled near the end (for infinite scroll) */
    onScrollNear?: () => void;
    /** Friction for momentum scrolling (0-1, lower = more slide, default: 0.92) */
    momentumFriction?: number;
    /** Minimum velocity to trigger momentum (default: 0.5) */
    momentumThreshold?: number;
}

export function dragScroll(node: HTMLElement, options: DragScrollOptions = {}) {
    let currentOptions = {
        nearEndThreshold: 200,
        scrollSpeed: 2,
        dragThreshold: 12,
        onScrollNear: undefined as (() => void) | undefined,
        momentumFriction: 0.92,
        momentumThreshold: 0.5,
        ...options,
    };

    let isDown = false;
    let startX = 0;
    let scrollLeft = 0;
    let hasDragged = false;
    let dragDistance = 0;
    // Viewport position of the mousedown and the latest mousemove, used to
    // read the gesture's direction when a draggable card fires dragstart.
    let startClientX = 0;
    let startClientY = 0;
    let lastClientX = 0;
    let lastClientY = 0;

    // Momentum tracking
    let lastX = 0;
    let lastTime = 0;
    let velocity = 0;
    let animationId: number | null = null;

    function isInteractiveTarget(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) return false;
        // Allow dragging if element has data-drag-scroll-allow attribute
        if (target.closest('[data-drag-scroll-allow]')) return false;
        return Boolean(
            target.closest(
                'button, a, input, select, textarea, label, [role="button"], [data-drag-scroll-ignore]',
            ),
        );
    }

    function stopMomentum() {
        if (animationId !== null) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
    }

    function handleMouseDown(e: MouseEvent) {
        if (e.button !== 0 || isInteractiveTarget(e.target)) return;

        // Stop any ongoing momentum animation
        stopMomentum();

        isDown = true;
        hasDragged = false;
        dragDistance = 0;
        velocity = 0;
        node.style.cursor = 'grabbing';
        node.style.userSelect = 'none';
        startX = e.pageX - node.offsetLeft;
        scrollLeft = node.scrollLeft;
        startClientX = lastClientX = e.clientX;
        startClientY = lastClientY = e.clientY;

        // Initialize momentum tracking
        lastX = e.pageX;
        lastTime = performance.now();

        // Listen globally so dragging continues outside the element
        window.addEventListener('mousemove', handleGlobalMouseMove);
    }

    function animateMomentum() {
        // Apply friction
        velocity *= currentOptions.momentumFriction;

        // Stop when velocity is negligible
        if (Math.abs(velocity) < currentOptions.momentumThreshold) {
            animationId = null;
            return;
        }

        // Apply velocity (convert from px/ms to px/frame at ~60fps)
        node.scrollLeft += velocity * 16;

        // Continue animation
        animationId = requestAnimationFrame(animateMomentum);
    }

    function handleMouseUp() {
        if (!isDown) return;
        const releaseVelocity = velocity;
        endGesture();
        velocity = releaseVelocity;

        // Start momentum animation if velocity is significant
        if (Math.abs(velocity) > currentOptions.momentumThreshold) {
            animateMomentum();
        }

        // Reset hasDragged after a brief delay to allow click events to check it
        setTimeout(() => {
            hasDragged = false;
        }, 10);
    }

    function handleGlobalMouseMove(e: MouseEvent) {
        if (!isDown) return;
        e.preventDefault();
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        const x = e.pageX - node.offsetLeft;
        const walk = (x - startX) * currentOptions.scrollSpeed;

        node.scrollLeft = scrollLeft - walk;
        dragDistance = Math.max(dragDistance, Math.abs(node.scrollLeft - scrollLeft));

        // Track velocity for momentum
        const now = performance.now();
        const dt = now - lastTime;
        if (dt > 0) {
            // Calculate velocity (pixels per ms), apply scroll speed multiplier
            velocity = ((lastX - e.pageX) * currentOptions.scrollSpeed) / dt;
            lastX = e.pageX;
            lastTime = now;
        }

        // Mark as dragged if moved beyond threshold
        if (dragDistance > currentOptions.dragThreshold) {
            hasDragged = true;
        }
    }

    function handleScroll() {
        // Check if near the end and callback is provided
        if (currentOptions.onScrollNear) {
            const scrollRight = node.scrollWidth - node.scrollLeft - node.clientWidth;
            if (scrollRight < currentOptions.nearEndThreshold) {
                currentOptions.onScrollNear();
            }
        }
    }

    function handleClick(e: MouseEvent) {
        if (isInteractiveTarget(e.target)) return;
        // Prevent click if we just dragged
        if (hasDragged) {
            e.stopPropagation();
            e.preventDefault();
        }
    }

    function endGesture() {
        isDown = false;
        velocity = 0;
        node.style.cursor = 'grab';
        node.style.userSelect = '';
        window.removeEventListener('mousemove', handleGlobalMouseMove);
    }

    // Suppress the browser's native HTML5 drag (images, links) — it would
    // hijack the mouse-drag gesture this scroller relies on. Cards that opt
    // into HTML5 drag ([data-drag-scroll-allow] on a draggable="true"
    // element, e.g. music track cards dragged onto the Mixing Desk dock)
    // share the gesture by direction: the browser fires dragstart after a
    // few pixels of movement, so a mostly-horizontal start means "scroll the
    // row" and the drag is cancelled (mousemove keeps flowing to the scroll
    // handler); a mostly-vertical start hands the gesture to drag-and-drop.
    // Runs in the capture phase so a cancelled drag never reaches the card's
    // own dragstart handler (which would set drag state that no dragend
    // ever clears).
    function handleDragStart(e: DragEvent) {
        const target = e.target instanceof HTMLElement ? e.target : null;
        const draggableAncestor = target?.closest('[draggable="true"]');
        const cardDrag =
            draggableAncestor instanceof HTMLElement &&
            draggableAncestor.dataset['dragScrollAllow'] !== undefined;
        if (cardDrag && !isDown) return;
        if (cardDrag) {
            // Read the direction from the last mousemove: Chromium stamps
            // dragstart with the mousedown position, and some engines report
            // 0/0 on drag events. The event's own coordinates are only a
            // fallback for when no mousemove arrived first.
            let dx = lastClientX - startClientX;
            let dy = lastClientY - startClientY;
            if (dx === 0 && dy === 0 && (e.clientX !== 0 || e.clientY !== 0)) {
                dx = e.clientX - startClientX;
                dy = e.clientY - startClientY;
            }
            if (Math.abs(dy) > Math.abs(dx)) {
                // Drag-and-drop wins: stop scrolling and undo the few pixels
                // the row moved before the browser decided it was a drag.
                endGesture();
                node.scrollLeft = scrollLeft;
                return;
            }
        }
        e.preventDefault();
        e.stopPropagation();
    }

    // Set initial cursor
    node.style.cursor = 'grab';

    // Add event listeners
    node.addEventListener('mousedown', handleMouseDown);
    node.addEventListener('scroll', handleScroll);
    node.addEventListener('click', handleClick, true); // Capture phase to intercept
    node.addEventListener('dragstart', handleDragStart, true);
    // Global mouseup to catch release anywhere
    window.addEventListener('mouseup', handleMouseUp);

    return {
        destroy() {
            stopMomentum();
            node.removeEventListener('mousedown', handleMouseDown);
            node.removeEventListener('scroll', handleScroll);
            node.removeEventListener('click', handleClick, true);
            node.removeEventListener('dragstart', handleDragStart, true);
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('mousemove', handleGlobalMouseMove);
        },
        update(newOptions: DragScrollOptions) {
            currentOptions = {
                ...currentOptions,
                ...newOptions,
            };
        },
    };
}
