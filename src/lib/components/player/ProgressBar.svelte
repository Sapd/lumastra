<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';

    import { onDestroy } from 'svelte';
    import { browser } from '$app/environment';
    import { playerStore } from './playerStore.svelte';
    import type { TimelineChapter } from '$lib/types/playback';
    import type { TrickplayManifestResponse } from '$lib/schemas/playback-trickplay';
    import type { AnnotationData } from '$lib/types/media-annotations';
    import * as m from '$lib/paraglide/messages';
    import { TrickplayLoader, type TrickplayLoaderCallbacks } from './trickplay/TrickplayLoader';
    import HoverPreview from './controls/HoverPreview.svelte';
    import FilmstripOverlay from './controls/FilmstripOverlay.svelte';
    import { getAvatarUrl } from '$lib/utils/image-utils';

    interface Props {
        // Props
        currentTime: number;
        duration: number;
        bufferedPercent: number;
        progressPercent: number;
        chapters?: TimelineChapter[];
        isGuestInWatchParty?: boolean;
        pins?: AnnotationData[];
        showAnnotationMarkers?: boolean;
        onseek?: (time: number) => void;
    }

    let {
        currentTime,
        duration,
        bufferedPercent,
        progressPercent,
        chapters = [],
        isGuestInWatchParty = false,
        pins = [],
        showAnnotationMarkers = true,
        onseek,
    }: Props = $props();

    // Debug logging - set to true for troubleshooting
    const DEBUG = false;

    function handleProgressKeydown(event: KeyboardEvent): void {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const changes: Record<string, number> = {
            ArrowLeft: currentTime - 10,
            ArrowDown: currentTime - 10,
            ArrowRight: currentTime + 10,
            ArrowUp: currentTime + 10,
            Home: 0,
            End: duration,
        };
        if (!(event.key in changes)) return;
        event.preventDefault();
        event.stopPropagation();
        cancelProgressSeek();
        if (
            isGuestInWatchParty ||
            playerStore.isVersionSwitching ||
            !Number.isFinite(duration) ||
            duration <= 0
        )
            return;
        onseek?.(Math.max(0, Math.min(duration, changes[event.key])));
    }

    // Local state
    let progressBar: HTMLDivElement | undefined = $state();
    let isDraggingProgress = $state(false);
    let hoverTime = $state<number | null>(null);
    let progressBarWidth: number = $state(0);

    // Filmstrip mode state (drag up from seekbar)
    let isFilmstripMode = $state(false);
    let filmstripDragStartY: number = 0;
    let filmstripDragStartX: number = 0;
    let filmstripBaseTime: number = 0;
    let filmstripActiveTime = $state<number | null>(null);
    let filmstripPrecision: number = $state(1);
    let lastFilmstripPrecision: number = 1; // Track previous precision to detect changes
    const FILMSTRIP_THRESHOLD = 40;
    const FILMSTRIP_THUMBNAILS = 15;
    const MAX_PRECISION = 8;
    // WebKit synthesizes mouse events after a touch tap. Both input paths
    // commit a seek, so ignore the compatibility mouse sequence after touch.
    const TOUCH_MOUSE_GUARD_MS = 750;
    let ignoreMouseUntil = 0;
    const PRECISION_HEIGHT = 200;
    const SEEK_SETTLE_MS = 150;
    let seekCommitTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingSeekTime = $state<number | null>(null);
    type SeekContext = Pick<
        typeof playerStore,
        | 'itemId'
        | 'currentMediaSource'
        | 'playbackInfo'
        | 'currentQualityProfile'
        | 'currentAudioTrackIndex'
        | 'playSessionId'
        | 'isVersionSwitching'
        | 'seekRevision'
    > & { duration: number };
    let gestureContext: SeekContext | null = null;

    function getSeekContext(): SeekContext {
        return {
            itemId: playerStore.itemId,
            currentMediaSource: playerStore.currentMediaSource,
            playbackInfo: playerStore.playbackInfo,
            currentQualityProfile: playerStore.currentQualityProfile,
            currentAudioTrackIndex: playerStore.currentAudioTrackIndex,
            playSessionId: playerStore.playSessionId,
            isVersionSwitching: playerStore.isVersionSwitching,
            seekRevision: playerStore.seekRevision,
            duration,
        };
    }

    function isSeekContextCurrent(context: SeekContext): boolean {
        const current = getSeekContext();
        return (
            !isGuestInWatchParty &&
            !current.isVersionSwitching &&
            (Object.keys(context) as Array<keyof SeekContext>).every(
                (key) => context[key] === current[key],
            )
        );
    }

    // Keep the real playhead stable while scrubbing. The local preview position
    // drives the thumb and remains visible until the released target settles.
    let previewTime = $derived(isDraggingProgress ? filmstripActiveTime : pendingSeekTime);
    let displayedProgressPercent = $derived(
        previewTime !== null && duration > 0 ? (previewTime / duration) * 100 : progressPercent,
    );
    let displayedCurrentTime = $derived(previewTime ?? currentTime);

    // Invalidate both held gestures and released commits when their media or
    // permissions change. onDestroy cancels work when the component unmounts.
    let previousSeekContext: SeekContext | null = null;
    let previousGuestPermission = false;
    $effect(() => {
        const context = getSeekContext();
        const guest = isGuestInWatchParty;
        // Props may invalidate this effect even when the media context is
        // unchanged (e.g. a normal time update). Cancel only stale intent.
        if (
            previousSeekContext &&
            (!isSeekContextCurrent(previousSeekContext) || guest !== previousGuestPermission)
        ) {
            cancelProgressSeek();
        }
        previousSeekContext = context;
        previousGuestPermission = guest;
    });

    // ============================================
    // Trickplay System
    // ============================================

    // UI State
    let trickplayImage = $state<string | null>(null);
    let trickplayLoading = false;
    let currentSpriteSheetIndex = $state(-1);

    // Track last known IDs
    let trickplayInfo = $state<TrickplayManifestResponse | null>(null);

    // Create TrickplayLoader with callbacks
    const trickplayCallbacks: TrickplayLoaderCallbacks = {
        onManifestLoad: (manifest) => {
            trickplayInfo = manifest;
        },
        onImageLoad: (index: number, url: string) => {
            trickplayImage = url;
            currentSpriteSheetIndex = index;
            DEBUG && console.log('[Trickplay] Image loaded:', index, url);
        },
        onImageFail: (index: number) => {
            // The loader retries individual sheet failures after its cooldown.
            DEBUG && console.log('[Trickplay] Image failed:', index);
        },
        onLoadingStateChange: (isLoading: boolean) => {
            trickplayLoading = isLoading;
            DEBUG && console.log('[Trickplay] Loading state:', isLoading);
        },
    };

    const trickplayLoader = new TrickplayLoader(trickplayCallbacks, DEBUG);

    // Cleanup on component destroy
    onDestroy(() => {
        cancelProgressSeek();
        if (!browser) return;

        // Remove window event listeners if dragging was in progress
        window.removeEventListener('mousemove', handleProgressMouseMove);
        window.removeEventListener('mouseup', handleProgressMouseUp);

        // Clear filmstrip preload timer
        if (filmstripPreloadTimer) {
            clearTimeout(filmstripPreloadTimer);
            filmstripPreloadTimer = null;
        }

        // Destroy trickplay loader (revokes blob URLs, clears caches)
        trickplayLoader.destroy();
    });

    // Get chapter at a specific time
    function getChapterAtTime(timeSeconds: number): TimelineChapter | null {
        if (!chapters.length) return null;

        const timeMs = timeSeconds * 1000;

        for (let i = chapters.length - 1; i >= 0; i--) {
            if (timeMs >= chapters[i].startMs) {
                return chapters[i];
            }
        }
        return chapters[0];
    }

    // Get segment at a specific time
    function getSegmentAtTime(timeSeconds: number): { type: string; label: string } | null {
        const segments = playerStore.mediaSegments;
        if (!segments.length) return null;

        for (const segment of segments) {
            if (timeSeconds * 1000 >= segment.startMs && timeSeconds * 1000 < segment.endMs) {
                const label =
                    segment.type === 'intro'
                        ? m.player_segment_intro()
                        : segment.type === 'outro'
                          ? m.player_segment_credits()
                          : segment.type === 'recap'
                            ? m.player_segment_recap()
                            : segment.type === 'preview'
                              ? m.player_segment_preview()
                              : segment.type;
                return { type: segment.type, label };
            }
        }
        return null;
    }

    // Calculate chapter position as percentage
    function getChapterPercent(chapter: TimelineChapter): number {
        if (!duration) return 0;
        return (chapter.startMs / (duration * 1000)) * 100;
    }

    // Calculate segment start position as percentage
    function getSegmentStartPercent(segment: { startMs: number; endMs: number }): number {
        if (!duration) return 0;
        return (segment.startMs / (duration * 1000)) * 100;
    }

    // Calculate segment width as percentage
    function getSegmentWidthPercent(segment: { startMs: number; endMs: number }): number {
        if (!duration) return 0;
        return ((segment.endMs - segment.startMs) / (duration * 1000)) * 100;
    }

    // Calculate pin position as percentage of duration
    function getPinPercent(pin: AnnotationData): number {
        if (!duration || pin.timestamp_seconds == null) return 0;
        return (Number(pin.timestamp_seconds) / duration) * 100;
    }

    // Get segment color based on type (SponsorBlock-style colors)
    function getSegmentColor(type: string): string {
        switch (type) {
            case 'intro':
                return 'rgba(0, 255, 255, 0.7)';
            case 'outro':
                return 'rgba(255, 140, 0, 0.7)';
            case 'recap':
                return 'rgba(138, 43, 226, 0.7)';
            case 'preview':
                return 'rgba(50, 205, 50, 0.7)';
            default:
                return 'rgba(255, 255, 255, 0.5)';
        }
    }

    // ============================================
    // Utility Functions - Time & Position Calculations
    // ============================================

    /** Calculate sprite sheet index for a given time (delegates to loader) */
    function getSpriteIndexForTime(timeSeconds: number): number {
        return trickplayLoader.getSpriteIndexForTime(timeSeconds);
    }

    // ============================================
    // Core Functions - Hover Preview
    // ============================================

    function checkTrickplayAvailability(): boolean {
        return trickplayInfo !== null && trickplayInfo.thumbnailCount > 0;
    }

    /** Update trickplay preview for hover/seek position (called rapidly on mouse move) */
    function updateTrickplayPreview(timeSeconds: number) {
        if (!checkTrickplayAvailability() || trickplayInfo === null) return;

        const spriteIndex = getSpriteIndexForTime(timeSeconds);

        // Request sheet from loader (handles caching, loading, and callbacks)
        trickplayLoader.requestSheet(spriteIndex);
    }

    // ============================================
    // Utility Functions - Tile Position Calculations
    // ============================================

    /** Calculate tiles per sprite sheet */
    function getTilesPerSheet(): number {
        if (trickplayInfo === null) return 1;
        return trickplayInfo.tileColumns * trickplayInfo.tileRows;
    }

    /** Get tile index for a given time */
    function getTileIndexForTime(timeSeconds: number): number {
        if (trickplayInfo === null) return 0;
        const intervalSeconds = trickplayInfo.intervalMs / 1000;
        return Math.floor(timeSeconds / intervalSeconds);
    }

    /** Get the position within the current sprite sheet */
    function getTrickplayTilePosition(timeSeconds: number): {
        x: number;
        y: number;
    } {
        if (trickplayInfo === null) return { x: 0, y: 0 };

        const tileIndex = getTileIndexForTime(timeSeconds);
        const tilesPerImage = getTilesPerSheet();
        const positionInSheet = tileIndex % tilesPerImage;

        const col = positionInSheet % trickplayInfo.tileColumns;
        const row = Math.floor(positionInSheet / trickplayInfo.tileColumns);

        return {
            x: col * trickplayInfo.width,
            y: row * trickplayInfo.height,
        };
    }

    /** Calculate tile position for a given tile index */
    function getTilePositionFromIndex(tileIndex: number): {
        x: number;
        y: number;
    } {
        if (trickplayInfo === null) return { x: 0, y: 0 };

        const tilesPerImage = getTilesPerSheet();
        const positionInSheet = tileIndex % tilesPerImage;

        const col = positionInSheet % trickplayInfo.tileColumns;
        const row = Math.floor(positionInSheet / trickplayInfo.tileColumns);

        return {
            x: col * trickplayInfo.width,
            y: row * trickplayInfo.height,
        };
    }

    // ============================================
    // Filmstrip Mode Functions
    // ============================================

    type FilmstripThumbnail = {
        time: number;
        spriteIndex: number;
        tilePos: { x: number; y: number };
        isLoaded: boolean;
        isLoading: boolean;
        isFailed: boolean;
        isCenter: boolean; // True for the thumbnail at centerTime
    };

    // Debounce timer for filmstrip preloading
    let filmstripPreloadTimer: ReturnType<typeof setTimeout> | null = null;
    const FILMSTRIP_PRELOAD_DEBOUNCE_MS = 100;

    // Track last preloaded center time to avoid redundant preloads
    let lastFilmstripPreloadTime: number | null = null;

    // Reactivity trigger - increment to force re-render when cache state changes
    let cacheUpdateTrigger = 0;

    /** Force reactivity update when cache state changes */
    function triggerCacheUpdate() {
        cacheUpdateTrigger++;
    }

    /** Get filmstrip thumbnails centered around a time (with loading state) */
    function getFilmstripThumbnails(centerTime: number): FilmstripThumbnail[] {
        // Access trigger to establish reactivity dependency
        void cacheUpdateTrigger;

        if (trickplayInfo === null) return [];

        const intervalSeconds = trickplayInfo.intervalMs / 1000;
        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return [];
        const halfCount = Math.floor(FILMSTRIP_THUMBNAILS / 2);
        const tilesPerImage = getTilesPerSheet();
        if (!Number.isFinite(tilesPerImage) || tilesPerImage <= 0) return [];

        const thumbnails: FilmstripThumbnail[] = [];

        for (let i = -halfCount; i <= halfCount; i++) {
            const time = centerTime + i * intervalSeconds * 2;

            // Skip times outside video bounds
            if (time < 0 || time > duration) continue;

            const tileIndex = Math.floor(time / intervalSeconds);
            const spriteIndex = Math.floor(tileIndex / tilesPerImage);

            thumbnails.push({
                time,
                spriteIndex,
                tilePos: getTilePositionFromIndex(tileIndex),
                isLoaded: trickplayLoader.isSheetCached(spriteIndex),
                isLoading: false, // Loader handles loading state internally
                isFailed: false, // Loader handles failure state internally
                isCenter: i === 0, // Mark the center thumbnail
            });
        }

        return thumbnails;
    }

    /** Get sprite sheet URL for a given index - uses cache if available */
    function getSpriteSheetUrl(spriteIndex: number): string {
        // Get from loader cache (returns null if not cached)
        return trickplayLoader.getCachedUrl(spriteIndex) ?? '';
    }

    /** Get unique sprite indices from thumbnails */
    function getFilmstripSpritesToLoad(thumbnails: FilmstripThumbnail[]): number[] {
        const uniqueIndices = [...new SvelteSet(thumbnails.map((t) => t.spriteIndex))];
        return uniqueIndices.filter((idx) => !trickplayLoader.isSheetCached(idx));
    }

    /** Preload sprite sheets for filmstrip (non-blocking, high priority) */
    function preloadFilmstripSprites(thumbnails: FilmstripThumbnail[]) {
        const indicesToLoad = getFilmstripSpritesToLoad(thumbnails);

        // Request all needed sheets from loader
        for (const index of indicesToLoad) {
            trickplayLoader.requestSheet(index);
        }

        // Trigger reactivity update for filmstrip UI
        triggerCacheUpdate();
    }

    /** Trigger filmstrip preload with debouncing to avoid excessive calls during drag */
    function triggerFilmstripPreload(centerTime: number) {
        // Skip if time hasn't changed significantly (within one thumbnail interval)
        if (lastFilmstripPreloadTime !== null && trickplayInfo !== null) {
            const intervalSeconds = trickplayInfo.intervalMs / 1000;
            const timeDelta = Math.abs(centerTime - lastFilmstripPreloadTime);
            if (timeDelta < intervalSeconds * 2) return;
        }

        // Clear existing timer
        if (filmstripPreloadTimer) {
            clearTimeout(filmstripPreloadTimer);
        }

        // Debounce the preload
        filmstripPreloadTimer = setTimeout(() => {
            const thumbnails = getFilmstripThumbnails(centerTime);
            preloadFilmstripSprites(thumbnails);
            lastFilmstripPreloadTime = centerTime;
            filmstripPreloadTimer = null;
        }, FILMSTRIP_PRELOAD_DEBOUNCE_MS);
    }

    // ============================================
    // Event Handlers - Progress Bar Interactions
    // ============================================

    /** Get client X position from mouse or touch event */
    function getClientX(event: MouseEvent | TouchEvent): number {
        return 'touches' in event ? (event.touches[0]?.clientX ?? NaN) : event.clientX;
    }

    /** Calculate time from mouse/touch position on progress bar */
    function getTimeFromEvent(event: MouseEvent | TouchEvent): number {
        if (!progressBar || !Number.isFinite(duration) || duration <= 0) return NaN;

        const rect = progressBar.getBoundingClientRect();
        const clientX = getClientX(event);
        if (
            !Number.isFinite(rect.left) ||
            !Number.isFinite(rect.width) ||
            rect.width <= 0 ||
            !Number.isFinite(clientX)
        )
            return NaN;
        const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

        return percent * duration;
    }

    /** Initialize filmstrip drag state */
    function initFilmstripDrag(event: MouseEvent | TouchEvent) {
        cancelProgressSeek();
        if (isGuestInWatchParty || playerStore.isVersionSwitching) return;
        const time = getTimeFromEvent(event);
        if (!Number.isFinite(time)) return;
        const clientY = 'touches' in event ? (event.touches[0]?.clientY ?? NaN) : event.clientY;
        const clientX = getClientX(event);
        if (!Number.isFinite(clientY)) return;

        gestureContext = getSeekContext();
        isDraggingProgress = true;
        filmstripDragStartY = clientY;
        filmstripDragStartX = clientX;
        filmstripBaseTime = time;
        filmstripActiveTime = time;
        filmstripPrecision = 1;
        hoverTime = time;
        updateTrickplayPreview(time);
    }

    /** Enter filmstrip mode */
    function enterFilmstripMode(event: MouseEvent | TouchEvent) {
        if (isFilmstripMode) return;

        isFilmstripMode = true;
        filmstripDragStartX = getClientX(event);
        filmstripBaseTime = filmstripActiveTime ?? getTimeFromEvent(event);
        lastFilmstripPrecision = filmstripPrecision; // Sync precision tracking

        // Reset preload tracking for new filmstrip session
        lastFilmstripPreloadTime = null;

        // Initial preload (immediate, not debounced)
        const thumbnails = getFilmstripThumbnails(filmstripBaseTime);
        preloadFilmstripSprites(thumbnails);
        lastFilmstripPreloadTime = filmstripBaseTime;
    }

    /** Calculate filmstrip time based on drag position */
    function updateFilmstripTime(event: MouseEvent | TouchEvent) {
        if (!progressBar || !Number.isFinite(getTimeFromEvent(event))) {
            cancelProgressSeek();
            return;
        }

        const rect = progressBar.getBoundingClientRect();
        const clientX = getClientX(event);

        // If precision changed, update base values to maintain current position
        // This prevents the seek position from jumping when precision changes
        if (filmstripPrecision !== lastFilmstripPrecision && filmstripActiveTime !== null) {
            filmstripBaseTime = filmstripActiveTime;
            filmstripDragStartX = clientX;
            lastFilmstripPrecision = filmstripPrecision;
        }

        const deltaX = clientX - filmstripDragStartX;
        const adjustedDeltaX = deltaX / filmstripPrecision;
        const deltaPercent = adjustedDeltaX / rect.width;
        const deltaTime = deltaPercent * duration;
        const newTime = Math.max(0, Math.min(duration, filmstripBaseTime + deltaTime));

        if (!Number.isFinite(newTime)) {
            cancelProgressSeek();
            return;
        }
        filmstripActiveTime = newTime;

        // Trigger preload for new thumbnails as user drags (debounced)
        triggerFilmstripPreload(newTime);
    }

    /** Reset filmstrip mode state */
    function exitFilmstripMode() {
        isDraggingProgress = false;
        isFilmstripMode = false;
        filmstripActiveTime = null;
        filmstripPrecision = 1;
        lastFilmstripPrecision = 1; // Reset precision tracking

        // Clear preload timer and tracking
        if (filmstripPreloadTimer) {
            clearTimeout(filmstripPreloadTimer);
            filmstripPreloadTimer = null;
        }
        lastFilmstripPreloadTime = null;
    }

    /** Cancel any pending intention and clear its local preview. */
    function cancelProgressSeek(): void {
        if (seekCommitTimer !== null) {
            clearTimeout(seekCommitTimer);
            seekCommitTimer = null;
        }
        pendingSeekTime = null;
        gestureContext = null;
        exitFilmstripMode();
        hoverTime = null;
        if (browser) {
            window.removeEventListener('mousemove', handleProgressMouseMove);
            window.removeEventListener('mouseup', handleProgressMouseUp);
        }
    }

    /** Retain the released preview and commit only after a quiet period. */
    function finishProgressDrag(commit: boolean): void {
        const targetTime = filmstripActiveTime;
        const context = gestureContext;
        const validGesture =
            isDraggingProgress &&
            Number.isFinite(getTimeGeometry()) &&
            context !== null &&
            isSeekContextCurrent(context);
        cancelProgressSeek();
        if (
            !commit ||
            !validGesture ||
            !context ||
            targetTime === null ||
            !Number.isFinite(targetTime)
        )
            return;

        pendingSeekTime = targetTime;
        seekCommitTimer = setTimeout(() => {
            seekCommitTimer = null;
            pendingSeekTime = null;
            if (!isSeekContextCurrent(context) || !Number.isFinite(getTimeGeometry())) return;
            onseek?.(Math.max(0, Math.min(duration, targetTime)));
        }, SEEK_SETTLE_MS);
    }

    /** Invalid geometry or duration must never produce a playback seek. */
    function getTimeGeometry(): number {
        if (!progressBar || !Number.isFinite(duration) || duration <= 0) return NaN;
        const rect = progressBar.getBoundingClientRect();
        return Number.isFinite(rect.left) && Number.isFinite(rect.width) && rect.width > 0
            ? rect.width
            : NaN;
    }

    /** Calculate drag delta Y from current event */
    function getDragDeltaY(event: MouseEvent | TouchEvent): number {
        const clientY = 'touches' in event ? (event.touches[0]?.clientY ?? NaN) : event.clientY;
        return filmstripDragStartY - clientY;
    }

    /** Calculate filmstrip precision based on drag height */
    function calculatePrecision(dragDeltaY: number): number {
        const heightAboveThreshold = dragDeltaY - FILMSTRIP_THRESHOLD;
        return (
            1 +
            Math.min(
                MAX_PRECISION - 1,
                (heightAboveThreshold / PRECISION_HEIGHT) * (MAX_PRECISION - 1),
            )
        );
    }

    /** Check if should enter filmstrip mode */
    function shouldEnterFilmstripMode(dragDeltaY: number): boolean {
        return dragDeltaY > FILMSTRIP_THRESHOLD && trickplayInfo !== null;
    }

    /** Check if should exit filmstrip mode */
    function shouldExitFilmstripMode(dragDeltaY: number): boolean {
        return dragDeltaY < FILMSTRIP_THRESHOLD / 2;
    }

    /** Handle progress bar mouse down */
    function handleProgressMouseDown(event: MouseEvent) {
        if (isGuestInWatchParty) return;
        const capabilities = (
            event as MouseEvent & {
                sourceCapabilities?: { firesTouchEvents: boolean } | null;
            }
        ).sourceCapabilities;
        // Where available, accept a known real mouse immediately on hybrid
        // devices. WebKit lacks this signal, so use the short time guard.
        if (capabilities?.firesTouchEvents !== false && Date.now() < ignoreMouseUntil) return;

        initFilmstripDrag(event);
        window.addEventListener('mousemove', handleProgressMouseMove);
        window.addEventListener('mouseup', handleProgressMouseUp);
    }

    /** Update only a valid, current gesture; invalid input cancels its intent. */
    function updateProgressDrag(event: MouseEvent | TouchEvent): void {
        const time = getTimeFromEvent(event);
        const dragDeltaY = getDragDeltaY(event);
        if (
            !gestureContext ||
            !isSeekContextCurrent(gestureContext) ||
            !Number.isFinite(time) ||
            !Number.isFinite(dragDeltaY)
        ) {
            cancelProgressSeek();
            return;
        }
        if (shouldEnterFilmstripMode(dragDeltaY)) {
            enterFilmstripMode(event);
            filmstripPrecision = calculatePrecision(dragDeltaY);
            updateFilmstripTime(event);
        } else {
            if (shouldExitFilmstripMode(dragDeltaY)) {
                isFilmstripMode = false;
                filmstripPrecision = 1;
            }
            filmstripActiveTime = time;
            hoverTime = time;
            updateTrickplayPreview(time);
        }
    }

    /** Handle progress bar mouse move during drag */
    function handleProgressMouseMove(event: MouseEvent): void {
        if (!isDraggingProgress) return;
        updateProgressDrag(event);
    }

    /** Handle progress bar mouse up */
    function handleProgressMouseUp() {
        finishProgressDrag(true);
        window.removeEventListener('mousemove', handleProgressMouseMove);
        window.removeEventListener('mouseup', handleProgressMouseUp);
    }

    /** Handle progress bar hover */
    function handleProgressEnter() {
        playerStore.setShowControls(true);
    }

    function handleProgressHover(event: MouseEvent) {
        const time = getTimeFromEvent(event);
        if (!Number.isFinite(time)) {
            cancelProgressSeek();
            return;
        }
        hoverTime = time;

        if (trickplayInfo) {
            updateTrickplayPreview(hoverTime);
        }
    }

    /** Handle progress bar leave */
    function handleProgressLeave() {
        hoverTime = null;
        playerStore.showControlsTemporarily();
    }

    // ============================================
    // Event Handlers - Touch Support
    // ============================================

    /** Handle progress bar touch start */
    function handleProgressTouchStart(event: TouchEvent) {
        if (isGuestInWatchParty) return;
        ignoreMouseUntil = Date.now() + TOUCH_MOUSE_GUARD_MS;
        initFilmstripDrag(event);
    }

    /** Handle progress bar touch move */
    function handleProgressTouchMove(event: TouchEvent) {
        if (!isDraggingProgress) return;

        event.preventDefault();
        updateProgressDrag(event);
    }

    /** Handle progress bar touch end */
    function handleProgressTouchEnd(event: TouchEvent) {
        if (!isDraggingProgress) return;
        // touchend is non-passive (Svelte's touchstart/move are passive).
        // Cancel synthesized clicks too, so the surrounding video surface
        // cannot interpret the same tap as a play/pause action.
        event.preventDefault();
        ignoreMouseUntil = Date.now() + TOUCH_MOUSE_GUARD_MS;
        finishProgressDrag(true);
        hoverTime = null;
    }

    /** Handle progress bar touch cancel (e.g., incoming call) */
    function handleProgressTouchCancel() {
        ignoreMouseUntil = Date.now() + TOUCH_MOUSE_GUARD_MS;
        finishProgressDrag(false);
        hoverTime = null;
    }

    // ============================================
    // Utility Functions - Time Formatting
    // ============================================

    function handlePinAvatarError(event: Event): void {
        const img = event.target as HTMLImageElement;
        if (img) img.style.display = 'none';
    }

    /** Format seconds to human-readable time (HH:MM:SS or MM:SS) */
    function formatHoverTime(seconds: number): string {
        const totalSeconds = Math.floor(seconds);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const secs = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }
        return `${minutes}:${String(secs).padStart(2, '0')}`;
    }

    // ============================================
    // Utility Functions - Preview Positioning
    // ============================================

    /** Default centered preview position */
    const DEFAULT_PREVIEW_POSITION = {
        left: '50%',
        transform: 'translateX(-50%)',
    };

    /** Padding added to preview width for clamping calculation */
    const PREVIEW_PADDING = 28;

    /** Default preview width when no trickplay available */
    const DEFAULT_PREVIEW_WIDTH = 180;

    /** Safely calculate percentage (returns 0 if division by zero) */
    function safePercent(value: number, total: number): number {
        if (!total || total <= 0) return 0;
        return (value / total) * 100;
    }

    /** Calculate clamped preview position to keep it within progress bar bounds */
    function getClampedPreviewPosition(hoverTimeSeconds: number): {
        left: string;
        transform: string;
    } {
        if (!progressBarWidth || !duration) {
            return DEFAULT_PREVIEW_POSITION;
        }

        const hoverPercent = safePercent(hoverTimeSeconds, duration);

        // Calculate total preview width including padding
        const previewWidth = trickplayInfo?.width ?? DEFAULT_PREVIEW_WIDTH;
        const totalPreviewWidth = previewWidth + PREVIEW_PADDING;

        // Calculate boundaries as percentages
        const halfPreviewPercent = (totalPreviewWidth / 2 / progressBarWidth) * 100;
        const minPercent = halfPreviewPercent;
        const maxPercent = 100 - halfPreviewPercent;

        // Clamp position to keep preview within bounds
        if (hoverPercent <= minPercent) {
            return { left: '0%', transform: 'translateX(0)' };
        }
        if (hoverPercent >= maxPercent) {
            return { left: '100%', transform: 'translateX(-100%)' };
        }
        return { left: `${hoverPercent}%`, transform: 'translateX(-50%)' };
    }
    // Derived: pin near hover position (threshold = 20px of bar width)
    let hoveredPin = $derived.by(() => {
        if (hoverTime === null || !duration || !progressBarWidth || !pins.length) return null;
        const thresholdSeconds = (20 / progressBarWidth) * duration;
        return (
            pins.find(
                (p) => Math.abs(Number(p.timestamp_seconds) - hoverTime!) <= thresholdSeconds,
            ) ?? null
        );
    });

    // Derived: reactive IDs
    let itemId = $derived(playerStore.itemId);
    let mediaSourceId = $derived(playerStore.currentMediaSource?.id);

    const trickplayManifestHref = $derived(
        playerStore.trickplayManifestHref ??
            [...playerStore.trickplayVariants].sort((a, b) => b.width - a.width)[0]?.manifestHref ??
            null,
    );
    $effect(() => {
        if (!browser) return;
        trickplayLoader.updateSession(itemId, mediaSourceId ?? null, trickplayManifestHref);
        trickplayInfo = null;
        trickplayImage = null;
        currentSpriteSheetIndex = -1;
        if (itemId && mediaSourceId && trickplayManifestHref) {
            void trickplayLoader.prefetchFirstTile();
            void trickplayLoader.startStrategicPreload();
        }
    });
</script>

<div
    role="none"
    class="progress-container"
    data-controls-hover-lock
    onmouseenter={handleProgressEnter}
    onmousemove={handleProgressHover}
    onmouseleave={handleProgressLeave}
    onmousedown={handleProgressMouseDown}
    ontouchstart={handleProgressTouchStart}
    ontouchmove={handleProgressTouchMove}
    ontouchend={handleProgressTouchEnd}
    ontouchcancel={handleProgressTouchCancel}>
    <div
        bind:this={progressBar}
        bind:clientWidth={progressBarWidth}
        class="progress-bar"
        class:guest-disabled={isGuestInWatchParty}
        role="slider"
        aria-label="Video progress"
        onkeydown={handleProgressKeydown}
        aria-disabled={isGuestInWatchParty}
        aria-valuenow={displayedCurrentTime}
        aria-valuemin={0}
        aria-valuemax={duration}
        tabindex="0"
        title={isGuestInWatchParty ? m.player_host_only_control() : ''}>
        <!-- Media segments (intro, outro, etc.) - SponsorBlock style -->
        {#each playerStore.mediaSegments as segment, i (`${segment.type}-${i}`)}
            <div
                class="segment-overlay"
                style="left: {getSegmentStartPercent(segment)}%; width: {getSegmentWidthPercent(
                    segment,
                )}%; background: {getSegmentColor(segment.type)};"
                title={segment.type === 'intro'
                    ? m.player_segment_intro()
                    : segment.type === 'outro'
                      ? m.player_segment_credits()
                      : segment.type === 'recap'
                        ? m.player_segment_recap()
                        : segment.type === 'preview'
                          ? m.player_segment_preview()
                          : segment.type}>
            </div>
        {/each}

        <!-- Chapter marks -->
        {#each chapters as chapter, i (i)}
            {#if i > 0}
                <div
                    class="chapter-mark"
                    style="left: {getChapterPercent(chapter)}%"
                    title={chapter.name}>
                </div>
            {/if}
        {/each}

        <!-- Annotation pin markers -->
        {#if showAnnotationMarkers}
            {#each pins as pin (pin.id)}
                <div class="pin-marker" style="left: {getPinPercent(pin)}%">
                    <span class="pin-marker-initial">
                        {pin.username.slice(0, 1).toUpperCase()}
                    </span>
                    <img
                        src={getAvatarUrl(pin.username)}
                        alt=""
                        class="pin-marker-img"
                        onerror={handlePinAvatarError} />
                </div>
            {/each}
        {/if}

        <!-- Buffered -->
        <div class="progress-buffered" style="width: {bufferedPercent}%"></div>
        <!-- Played -->
        <div class="progress-played" style="width: {displayedProgressPercent}%"></div>
        <!-- Thumb -->
        <div class="progress-thumb" style="left: {displayedProgressPercent}%"></div>

        <!-- Hover preview (trickplay + time + chapter + segment) - hidden during filmstrip mode -->
        {#if hoverTime !== null && !isFilmstripMode}
            {@const hoverChapter = getChapterAtTime(hoverTime)}
            {@const hoverSegment = getSegmentAtTime(hoverTime)}
            {@const tilePos = getTrickplayTilePosition(hoverTime)}
            {@const previewPos = getClampedPreviewPosition(hoverTime)}
            <HoverPreview
                {hoverTime}
                {trickplayImage}
                {trickplayInfo}
                {tilePos}
                {hoverSegment}
                {hoverChapter}
                {previewPos}
                pin={hoveredPin} />
        {/if}

        <!-- Filmstrip mode - shows multiple thumbnails when dragging up -->
        {#if isFilmstripMode && filmstripActiveTime !== null && trickplayInfo}
            {@const filmstripThumbnails = getFilmstripThumbnails(filmstripActiveTime)}
            <FilmstripOverlay
                {filmstripActiveTime}
                {filmstripPrecision}
                {trickplayInfo}
                {duration}
                {filmstripThumbnails}
                {getSpriteSheetUrl}
                {getSegmentAtTime} />
        {/if}
    </div>
</div>

<style>
    .progress-container {
        padding: 0.5rem 0;
    }

    .progress-bar {
        position: relative;
        height: 4px;
        background: rgba(255, 255, 255, 0.3);
        border-radius: 2px;
        cursor: pointer;
        transition: height 0.1s ease;
    }

    .progress-bar:hover {
        height: 6px;
    }

    .progress-bar.guest-disabled {
        cursor: not-allowed;
        opacity: 0.7;
    }

    .progress-bar.guest-disabled:hover {
        height: 4px;
    }

    .progress-buffered {
        position: absolute;
        left: 0;
        top: 0;
        height: 100%;
        background: rgba(255, 255, 255, 0.5);
        border-radius: 2px;
        pointer-events: none;
    }

    .progress-played {
        position: absolute;
        left: 0;
        top: 0;
        height: 100%;
        background: #e50914;
        border-radius: 2px;
        pointer-events: none;
    }

    .progress-thumb {
        position: absolute;
        top: 50%;
        transform: translate(-50%, -50%) scale(0);
        width: 12px;
        height: 12px;
        background: #e50914;
        border-radius: 50%;
        transition: transform 0.1s ease;
        pointer-events: none;
    }

    .progress-bar:hover .progress-thumb {
        transform: translate(-50%, -50%) scale(1);
    }

    /* Media segment overlays (SponsorBlock style) */
    .segment-overlay {
        position: absolute;
        top: 0;
        height: 100%;
        pointer-events: none;
        z-index: 1;
        opacity: 0.8;
        transition: opacity 0.2s;
    }

    .progress-bar:hover .segment-overlay {
        opacity: 1;
    }

    /* Chapter marks on progress bar */
    .chapter-mark {
        position: absolute;
        top: 0;
        width: 3px;
        height: 100%;
        background: rgba(255, 255, 255, 0.6);
        transform: translateX(-50%);
        pointer-events: none;
        z-index: 2;
        border-radius: 1px;
    }

    .progress-bar:hover .chapter-mark {
        height: 100%;
    }

    /* Annotation pin markers on seekbar */
    .pin-marker {
        position: absolute;
        bottom: calc(100% + 3px);
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 2px solid #f59e0b;
        transform: translateX(-50%);
        transition: transform 0.15s;
        z-index: 5;
        pointer-events: none;
        overflow: hidden;
        background: #374151;
    }

    .progress-bar:hover .pin-marker {
        transform: translateX(-50%) scale(1.2);
    }

    .pin-marker-initial {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 7px;
        font-weight: 700;
        color: rgba(255, 255, 255, 0.8);
        line-height: 1;
    }

    .pin-marker-img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    /* Mobile adjustments - Portrait */
    @media (max-width: 640px) {
        .progress-container {
            margin-bottom: 0.75rem;
        }

        .progress-bar {
            height: 6px;
        }

        .progress-thumb {
            width: 14px;
            height: 14px;
            top: -4px;
        }
    }

    /* Mobile Landscape */
    @media (max-width: 920px) and (orientation: landscape) {
        .progress-container {
            margin-bottom: 0.5rem;
        }

        .progress-bar {
            height: 5px;
        }

        .progress-thumb {
            width: 12px;
            height: 12px;
            top: -3.5px;
        }
    }
</style>
