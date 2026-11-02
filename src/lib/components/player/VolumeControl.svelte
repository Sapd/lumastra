<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy } from 'svelte';
    import PlayerIcon from './PlayerIcon.svelte';
    import { applyVolumeCurve, inverseVolumeCurve, type VolumeCurve } from './volume-control';

    interface Props {
        // Props
        volume: number; // 0-1
        isMuted: boolean;
        volumeCurve?: VolumeCurve; // NEW: volume curve setting from server config
        onvolume?: (newVolume: number) => void;
        onmute?: () => void;
    }

    let { volume, isMuted, volumeCurve = 'linear', onvolume, onmute }: Props = $props();

    // Local state
    let showVolumeSlider = $state(false);
    let volumeSliderRef: HTMLDivElement | undefined = $state();
    let isDraggingVolume = $state(false);
    let isDraggingVolumeIcon = $state(false);
    let volumeIconDragStartX = 0;
    let volumeIconDragStartVolume = 0;
    let volumeIconMouseDownTime = 0;
    let volumeIconWasDragged = false;
    let cleanupDrag: (() => void) | undefined;
    onDestroy(() => cleanupDrag?.());

    // Display volume: apply inverse curve to show correct slider position
    // When muted, always show 0; otherwise transform actual volume to slider position
    let displayVolume = $derived(isMuted ? 0 : inverseVolumeCurve(volume, volumeCurve));

    // Volume slider - Touch Bar style
    function handleVolumeDrag(event: MouseEvent | TouchEvent) {
        if (!volumeSliderRef) return;

        const rect = volumeSliderRef.getBoundingClientRect();
        const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;

        // Calculate slider position from mouse/touch position (0-1)
        const relativeX = clientX - rect.left;
        const sliderPosition = Math.max(0, Math.min(1, relativeX / rect.width));

        // Apply volume curve transformation: slider position → actual volume
        const actualVolume = applyVolumeCurve(sliderPosition, volumeCurve);

        onvolume?.(actualVolume);
    }

    function startVolumeDrag(event: MouseEvent | TouchEvent) {
        event.preventDefault();
        event.stopPropagation();

        cleanupDrag?.();
        isDraggingVolume = true;
        handleVolumeDrag(event);

        const handleMove = (e: MouseEvent | TouchEvent) => {
            if (isDraggingVolume) {
                handleVolumeDrag(e);
            }
        };

        const handleEnd = () => {
            isDraggingVolume = false;
            document.removeEventListener('mousemove', handleMove);
            document.removeEventListener('mouseup', handleEnd);
            document.removeEventListener('touchmove', handleMove);
            document.removeEventListener('touchend', handleEnd);
            document.removeEventListener('touchcancel', handleEnd);
            cleanupDrag = undefined;
        };

        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseup', handleEnd);
        document.addEventListener('touchmove', handleMove);
        document.addEventListener('touchend', handleEnd);
        document.addEventListener('touchcancel', handleEnd);
        cleanupDrag = handleEnd;
    }

    // Volume icon drag - Touch Bar style (drag the icon itself)
    function startVolumeIconDrag(event: MouseEvent | TouchEvent) {
        cleanupDrag?.();
        volumeIconWasDragged = false;
        showVolumeSlider = true; // Expand the slider

        const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
        volumeIconDragStartX = clientX;

        // Store starting volume with inverse transformation
        // (convert actual volume to slider position for delta calculation)
        const startSliderPosition = isMuted ? 0 : inverseVolumeCurve(volume, volumeCurve);
        volumeIconDragStartVolume = startSliderPosition;

        let hasMoved = false;

        const handleMove = (e: MouseEvent | TouchEvent) => {
            const currentX = 'touches' in e ? e.touches[0].clientX : e.clientX;
            const deltaX = Math.abs(currentX - volumeIconDragStartX);

            // Only start dragging if moved more than 5px (prevents accidental drags on click)
            if (!hasMoved && deltaX > 5) {
                hasMoved = true;
                volumeIconWasDragged = true;
                isDraggingVolumeIcon = true;
            }

            if (!isDraggingVolumeIcon) return;

            // Moving left = decrease volume, moving right = increase
            // Use 150px as full range (0 to 1) in slider position space
            const dragDelta = currentX - volumeIconDragStartX;
            const deltaSliderPosition = dragDelta / 150;

            // Calculate new slider position, then transform to actual volume
            const newSliderPosition = Math.max(
                0,
                Math.min(1, volumeIconDragStartVolume + deltaSliderPosition),
            );
            const newVolume = applyVolumeCurve(newSliderPosition, volumeCurve);

            onvolume?.(newVolume);
        };

        const handleEnd = () => {
            isDraggingVolumeIcon = false;
            document.removeEventListener('mousemove', handleMove);
            document.removeEventListener('mouseup', handleEnd);
            document.removeEventListener('touchmove', handleMove);
            document.removeEventListener('touchend', handleEnd);
            document.removeEventListener('touchcancel', handleEnd);
            cleanupDrag = undefined;
        };

        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseup', handleEnd);
        document.addEventListener('touchmove', handleMove);
        document.addEventListener('touchend', handleEnd);
        document.addEventListener('touchcancel', handleEnd);
        cleanupDrag = handleEnd;
    }

    // iOS supports mute, but not programmatic volume adjustment. Keep the
    // compact control a simple button rather than consuming touches as drags.
    function isCompactControl(): boolean {
        return window.matchMedia(
            '(max-width: 640px), (max-width: 920px) and (orientation: landscape)',
        ).matches;
    }

    // Handle mousedown on volume icon
    function handleVolumeIconMouseDown(event: MouseEvent) {
        event.stopPropagation(); // Prevent VideoPlayer from handling this
        volumeIconMouseDownTime = Date.now();
        if (!isCompactControl()) startVolumeIconDrag(event);
    }

    // Handle touchstart on volume icon
    function handleVolumeIconTouchStart(event: TouchEvent) {
        event.stopPropagation(); // Prevent VideoPlayer from handling this
        volumeIconMouseDownTime = Date.now();
        if (!isCompactControl()) startVolumeIconDrag(event);
    }

    function handleVolumeIconClick(event: MouseEvent) {
        event.stopPropagation(); // Prevent VideoPlayer from handling this

        // Only toggle mute if it was a quick click (not a drag)
        const clickDuration = Date.now() - volumeIconMouseDownTime;
        if (
            isCompactControl() ||
            event.detail === 0 ||
            (clickDuration < 200 && !volumeIconWasDragged)
        ) {
            onmute?.();
        }
    }

    // Volume scroll - scroll up = increase, scroll down = decrease
    function handleVolumeScroll(event: WheelEvent) {
        event.preventDefault();
        event.stopPropagation(); // Prevent global player scroll handler from also firing

        // Normalize scroll delta for touchpads vs mouse wheels
        // Mouse wheels typically have deltaY of ~100, touchpads have smaller values
        const absDelta = Math.abs(event.deltaY);
        const step = absDelta > 50 ? 0.05 : Math.min(0.05, absDelta * 0.002);

        const direction = event.deltaY < 0 ? 1 : -1;

        // Work in slider position space for the adjustment
        const currentSliderPosition = isMuted ? 0 : inverseVolumeCurve(volume, volumeCurve);
        const newSliderPosition = Math.max(
            0,
            Math.min(1, currentSliderPosition + step * direction),
        );

        // Transform to actual volume
        const newVolume = applyVolumeCurve(newSliderPosition, volumeCurve);

        // Unmute if muted and scrolling up
        if (isMuted && direction > 0) {
            onmute?.();
        }

        onvolume?.(newVolume);
    }

    // Keyboard handling for accessibility
    function handleKeydown(event: KeyboardEvent) {
        const step = event.shiftKey ? 0.1 : 0.05;

        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault();
            // Work in slider position space
            const currentSliderPosition = inverseVolumeCurve(volume, volumeCurve);
            const newSliderPosition = Math.min(1, currentSliderPosition + step);
            const newVolume = applyVolumeCurve(newSliderPosition, volumeCurve);
            onvolume?.(newVolume);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault();
            // Work in slider position space
            const currentSliderPosition = inverseVolumeCurve(volume, volumeCurve);
            const newSliderPosition = Math.max(0, currentSliderPosition - step);
            const newVolume = applyVolumeCurve(newSliderPosition, volumeCurve);
            onvolume?.(newVolume);
        }
    }
</script>

<div
    class="volume-wrapper"
    class:expanded={showVolumeSlider || isDraggingVolume || isDraggingVolumeIcon}
    role="group"
    aria-label="Volume control"
    onmouseenter={() => (showVolumeSlider = true)}
    onmouseleave={() => {
        if (!isDraggingVolume && !isDraggingVolumeIcon) showVolumeSlider = false;
    }}
    onwheel={handleVolumeScroll}>
    <!-- Slider track (expands to the left) -->
    <div
        class="volume-track"
        bind:this={volumeSliderRef}
        onmousedown={startVolumeDrag}
        ontouchstart={startVolumeDrag}
        onkeydown={handleKeydown}
        role="slider"
        aria-label="Volume"
        aria-valuenow={Math.round(displayVolume * 100)}
        aria-valuemin="0"
        aria-valuemax="100"
        tabindex="0">
        <!-- Fill -->
        <div class="volume-fill" style="width: {displayVolume * 100}%"></div>
        <!-- Thumb -->
        <div class="volume-thumb" style="left: {displayVolume * 100}%"></div>
    </div>

    <!-- Volume icon button - draggable like Touch Bar -->
    <button
        class="control-button volume-button"
        class:dragging={isDraggingVolumeIcon}
        onmousedown={handleVolumeIconMouseDown}
        ontouchstart={handleVolumeIconTouchStart}
        onclick={handleVolumeIconClick}
        aria-label={isMuted ? 'Unmute' : 'Mute (drag to adjust)'}>
        {#if isMuted || volume === 0}
            <PlayerIcon name="muted" size={22} />
        {:else if volume < 0.5}
            <PlayerIcon name="volumeLow" size={22} />
        {:else}
            <PlayerIcon name="volume" size={22} />
        {/if}
    </button>
</div>

<style>
    /* Modern Volume Control - Touch Bar Style */
    .volume-wrapper {
        display: flex;
        align-items: center;
        position: relative;
        height: 36px;
        border-radius: 18px;
        background: transparent;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        overflow: hidden;
    }

    .volume-wrapper:hover,
    .volume-wrapper.expanded {
        background: rgba(255, 255, 255, 0.1);
    }

    .volume-track {
        width: 0;
        height: 6px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 3px;
        position: relative;
        cursor: pointer;
        transition:
            width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
            opacity 0.2s;
        opacity: 0;
        margin-left: 8px;
        flex-shrink: 0;
    }

    .volume-wrapper:hover .volume-track,
    .volume-wrapper.expanded .volume-track {
        width: 80px;
        opacity: 1;
    }

    .volume-fill {
        position: absolute;
        left: 0;
        top: 0;
        height: 100%;
        background: white;
        border-radius: 3px;
        pointer-events: none;
        transition: width 0.05s ease-out;
    }

    .volume-thumb {
        position: absolute;
        top: 50%;
        width: 14px;
        height: 14px;
        background: white;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
        opacity: 0;
        transition:
            opacity 0.2s,
            transform 0.1s;
    }

    .volume-wrapper:hover .volume-thumb,
    .volume-wrapper.expanded .volume-thumb {
        opacity: 1;
    }

    .volume-thumb:active,
    .volume-wrapper.expanded .volume-thumb {
        transform: translate(-50%, -50%) scale(1.15);
    }

    .control-button {
        background: none;
        border: none;
        color: white;
        cursor: pointer;
        padding: 0.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        transition: background-color 0.2s;
    }

    .control-button:hover {
        background: rgba(255, 255, 255, 0.1);
    }

    .volume-button {
        flex-shrink: 0;
        z-index: 1;
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
    }

    .volume-button:active,
    .volume-button.dragging {
        cursor: grabbing;
    }

    .volume-button.dragging {
        transform: scale(1.1);
    }

    /* Touch-friendly: larger hit area */
    .volume-track::before {
        content: '';
        position: absolute;
        top: -10px;
        left: 0;
        right: 0;
        bottom: -10px;
    }

    /* Keep mute available on mobile; only the unsupported volume slider is hidden. */
    @media (max-width: 640px) {
        .volume-track {
            display: none;
        }
    }

    /* Keep the same sound action available in landscape. */
    @media (max-width: 920px) and (orientation: landscape) {
        .volume-track {
            display: none;
        }
    }
</style>
