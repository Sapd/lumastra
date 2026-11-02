<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Music Map — /music/map

  Interactive Canvas2D starfield of the audio embedding space.

  Features:
    - Pan (drag) + zoom (wheel / pinch) over the full projection
    - Points coloured by topMood via mood-palette
    - Hover tooltip: title + artist + mood badge
    - Click a point → open SimilarTracksModal (tracks/{id}/similar endpoint)
    - Lasso or searchable checkboxes select → preview, play, save, or brew
    - Empty-state when projection hasn't run yet

  Canvas layout notes:
    - Uses devicePixelRatio for sharp rendering on HiDPI displays.
    - Animation loop runs only when needed (pan/zoom in-flight, loading).
    - All interaction state is module-level mutable (not $state) to avoid
      60fps Svelte reactivity — only tooltip/selection are reactive props.
-->

<script lang="ts">
    import { page } from '$app/stores';
    import { onDestroy, onMount } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { labelToColor, MOOD_PALETTE_FALLBACK } from '$lib/utils/mood-palette';
    import { openSimilarTracksModal } from '$lib/utils/modal-utils';
    import { toasts } from '$lib/stores/toast.store';
    import { resolve } from '$lib/paths';
    import { goto } from '$app/navigation';
    import MusicSubpageHeader from '$lib/components/music/MusicSubpageHeader.svelte';
    import { GlobeAlt } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import type { PageData } from './$types';
    import { musicAlchemyStore } from '$lib/stores/music-alchemy.store.svelte';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import type { MusicTrack } from '$lib/schemas/music';
    import { getMusicMap } from '$lib/api/music';
    import MixPreview from '$lib/components/music/MixPreview.svelte';
    import SaveMixButton from '$lib/components/music/SaveMixButton.svelte';

    let { data }: { data: PageData } = $props();

    // ──────────────────────────────────────────────────────────────────────────
    // Feature gate
    // ──────────────────────────────────────────────────────────────────────────

    const musicMapEnabled = $derived($page.data?.features?.musicMap === true);
    const isAdmin = $derived(data.isAdmin === true);

    // ──────────────────────────────────────────────────────────────────────────
    // Types
    // ──────────────────────────────────────────────────────────────────────────

    interface MapPoint {
        id: string;
        x: number; // [0,1] normalised
        y: number; // [0,1] normalised
        title: string;
        artist: string | null;
        topMood: string | null;
    }

    /** Shape of the GET /api/music/map response. */
    interface MapApiResponse {
        points: MapPoint[];
        hasCoords: boolean;
        embeddedCount?: number;
        totalTracks?: number;
        projectedCount?: number;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Music Map–specific mood palette
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Map-specific override for the 8 legend moods. The shared `MOOD_COLORS`
     * in `$lib/utils/mood-palette` is used by MoodIslandCanvas / QueueTrackItem /
     * MiniPlayer / BrewResponse and gives Happy+Energetic the same yellow and
     * Mellow+Dark near-identical purples — fine for a single-dot accent, but it
     * makes an 8-swatch legend useless. Rather than touching the shared module
     * (other surfaces depend on its exact values), this page keeps its own
     * palette and is the single source of truth for BOTH the legend swatches
     * and the canvas dots via {@link mapLabelToColor} below.
     *
     * `topMood` is actually COALESCE(mood_tag, genre, sonic_mood_key) — see
     * music-map.queries.ts — so most dots are genre-colored, not mood-colored.
     * Only these 8 known mood keys are overridden; everything else (genres,
     * other mood tags, unknown labels) still falls through to the shared
     * `labelToColor()` so that behaviour is unchanged.
     */
    const MUSIC_MAP_MOOD_COLORS: Record<string, string> = {
        happy: '#fde047', // yellow-300 — warm yellow
        energetic: '#fb923c', // orange-400
        angry: '#f87171', // red-400
        sad: '#60a5fa', // blue-400
        calm: '#4ade80', // green-400
        chill: '#22d3ee', // cyan-400
        mellow: '#f9a8d4', // pink-300 — soft pink/lavender
        dark: '#c026d3', // fuchsia-600 — deep violet/magenta
    };

    /**
     * Resolve a track's `topMood` label to a color for this page. Checks the
     * map-specific mood overrides first, then falls back to the shared
     * `labelToColor()` (genre palette + stable hash) for everything else.
     */
    function mapLabelToColor(label: string | null | undefined): string {
        if (!label) return MOOD_PALETTE_FALLBACK;
        const normalized = label.toLowerCase().trim();
        return MUSIC_MAP_MOOD_COLORS[normalized] ?? labelToColor(label);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Reactive state (Svelte 5 runes)
    // ──────────────────────────────────────────────────────────────────────────

    let loading = $state(true);
    let error = $state<string | null>(null);
    let hasCoords = $state(false);
    // Coarse pointer = touch. Scroll-zoom + shift-drag lasso have no touch
    // equivalent, so the hint switches to pinch/tap wording on touch devices.
    let isCoarsePointer = $state(false);

    // Sonic-embedding backfill progress (drives the empty-state progress bar).
    let embeddedCount = $state(0);
    let totalTracks = $state(0);

    // ETA computation — keep the two most recent (timestamp, embeddedCount)
    // samples to derive a backfill rate (tracks/ms).
    interface CoverageSample {
        t: number;
        embedded: number;
    }
    let firstSample: CoverageSample | null = null;
    let lastSample: CoverageSample | null = null;
    let etaMinutes = $state<number | null>(null);

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const POLL_INTERVAL_MS = 5000;

    const embedPercent = $derived(
        totalTracks > 0 ? Math.min(100, Math.round((embeddedCount / totalTracks) * 100)) : 0,
    );
    const embeddingsReady = $derived(totalTracks > 0 && embeddedCount >= totalTracks);

    // Tooltip
    let hoveredPoint = $state<MapPoint | null>(null);
    let tooltipX = $state(0);
    let tooltipY = $state(0);

    // Lasso selection (SvelteSet for reactive size tracking)
    let selectedIds = new SvelteSet<string>();

    // Similar tracks modal (opened via openSimilarTracksModal utility)

    // Playlist creation state
    let previewTracks = $state<MusicTrack[] | null>(null);
    let browseTracks = $state(false);
    let trackQuery = $state('');
    // Map-projection trigger state (admin empty-state "Compute now" button).
    // Once started, the 5s coverage poll auto-loads the map when hasCoords flips.
    let projectionStarted = $state(false);
    let startingProjection = $state(false);

    // ──────────────────────────────────────────────────────────────────────────
    // Canvas + rendering (module-level mutable, NOT reactive)
    // ──────────────────────────────────────────────────────────────────────────

    let canvasEl: HTMLCanvasElement | undefined = $state();
    let containerEl: HTMLDivElement | undefined = $state();

    // All loaded points ($state because points.length is shown in header)
    let points = $state<MapPoint[]>([]);
    const matchingPoints = $derived(
        browseTracks
            ? points.filter((point) =>
                  `${point.title} ${point.artist ?? ''}`
                      .toLowerCase()
                      .includes(trackQuery.trim().toLowerCase()),
              )
            : [],
    );

    // Viewport state
    let viewX = 0; // pan offset in logical pixels
    let viewY = 0;
    let viewScale = 1; // zoom level
    let canvasW = 0;
    let canvasH = 0;
    let dpr = 1;

    // Drag state ($state because cursor style uses isDragging in template)
    let isDragging = $state(false);
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartViewX = 0;
    let dragStartViewY = 0;

    // Lasso state ($state so cursor + tooltip guard react immediately)
    let isLasso = $state(false);
    let lassoPath: { x: number; y: number }[] = [];

    // rAF handle
    let rafId: number | null = null;
    let destroyed = false;
    let dirty = false; // needs redraw

    // Hit-test cache: screen-space { x, y, r } per point (in logical px)
    interface CachedPoint {
        sx: number;
        sy: number;
        r: number;
        point: MapPoint;
    }
    let cachedScreenPoints: CachedPoint[] = [];

    // ──────────────────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────────────────

    const POINT_BASE_R = 5; // logical pixels
    const POINT_HOVER_R = 8;
    const MIN_SCALE = 0.15;
    const MAX_SCALE = 20;
    const PADDING = 80; // logical px margin inside canvas

    // ──────────────────────────────────────────────────────────────────────────
    // Data loading
    // ──────────────────────────────────────────────────────────────────────────

    async function loadMapData(): Promise<void> {
        loading = true;
        error = null;
        try {
            const result = await getMusicMap();
            if (result.error || !result.data) {
                error =
                    result.status === 404
                        ? 'Music Map is not enabled on this server.'
                        : (result.error ?? 'Failed to load map data');
                return;
            }
            const json = result.data;
            points = json.points ?? [];
            hasCoords = json.hasCoords ?? false;
            applyCoverage(json);
        } catch {
            error = 'Network error — could not load map data';
        } finally {
            loading = false;
            if (!error) {
                resetView();
                scheduleRedraw();
                // Start/stop the backfill poll based on projection state.
                if (hasCoords) {
                    stopPolling();
                } else {
                    startPolling();
                }
            }
        }
    }

    /** Apply the access-scoped coverage counts from a map API payload. */
    function applyCoverage(json: MapApiResponse): void {
        embeddedCount = json.embeddedCount ?? 0;
        totalTracks = json.totalTracks ?? 0;
        recomputeEta(embeddedCount);
    }

    /**
     * Update the ETA estimate from successive coverage samples.
     *
     * Rate = Δembedded / Δtime across the first and most-recent samples we've
     * seen. ETA is only shown once we have ≥2 samples AND a positive rate;
     * otherwise it's hidden (null). Anchoring on the first sample smooths out
     * per-poll jitter for a steadier estimate.
     */
    function recomputeEta(embedded: number): void {
        const now = Date.now();
        if (firstSample === null) {
            firstSample = { t: now, embedded };
            lastSample = { t: now, embedded };
            etaMinutes = null;
            return;
        }
        lastSample = { t: now, embedded };

        const dt = lastSample.t - firstSample.t;
        const dEmbedded = lastSample.embedded - firstSample.embedded;
        if (dt <= 0 || dEmbedded <= 0) {
            etaMinutes = null;
            return;
        }
        const ratePerMs = dEmbedded / dt; // tracks per millisecond
        const remaining = Math.max(0, totalTracks - embedded);
        if (ratePerMs <= 0 || remaining <= 0) {
            etaMinutes = null;
            return;
        }
        etaMinutes = Math.max(1, Math.ceil(remaining / ratePerMs / 60000));
    }

    async function pollCoverage(): Promise<void> {
        try {
            const result = await getMusicMap();
            if (result.error || !result.data) return;
            const json = result.data;
            applyCoverage(json);
            if (json.hasCoords) {
                // Projection finished while we were polling — load the map.
                stopPolling();
                points = json.points ?? [];
                hasCoords = true;
                resetView();
                scheduleRedraw();
            }
        } catch {
            // Silent — polling is best-effort; next tick retries.
        }
    }

    function startPolling(): void {
        if (pollTimer !== null || destroyed) return;
        pollTimer = setInterval(() => {
            void pollCoverage();
        }, POLL_INTERVAL_MS);
    }

    function stopPolling(): void {
        if (pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Viewport helpers
    // ──────────────────────────────────────────────────────────────────────────

    /** Convert a normalised point [0,1] to canvas logical coords. */
    function toScreen(nx: number, ny: number): { sx: number; sy: number } {
        const effectiveW = canvasW - PADDING * 2;
        const effectiveH = canvasH - PADDING * 2;
        const worldX = nx * effectiveW + PADDING;
        const worldY = ny * effectiveH + PADDING;
        const sx = (worldX - viewX) * viewScale + canvasW / 2;
        const sy = (worldY - viewY) * viewScale + canvasH / 2;
        return { sx, sy };
    }

    /** Convert canvas logical coords back to normalised [0,1]. */
    function fromScreen(sx: number, sy: number): { nx: number; ny: number } {
        const effectiveW = canvasW - PADDING * 2;
        const effectiveH = canvasH - PADDING * 2;
        const worldX = (sx - canvasW / 2) / viewScale + viewX;
        const worldY = (sy - canvasH / 2) / viewScale + viewY;
        const nx = (worldX - PADDING) / effectiveW;
        const ny = (worldY - PADDING) / effectiveH;
        return { nx, ny };
    }

    function resetView(): void {
        viewX = canvasW / 2;
        viewY = canvasH / 2;
        viewScale = 1;
        rebuildScreenCache();
    }

    function rebuildScreenCache(): void {
        cachedScreenPoints = points.map((p) => {
            const { sx, sy } = toScreen(p.x, p.y);
            return { sx, sy, r: POINT_BASE_R, point: p };
        });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Rendering
    // ──────────────────────────────────────────────────────────────────────────

    function drawFrame(): void {
        if (!canvasEl) return;
        const ctx = canvasEl.getContext('2d');
        if (!ctx) return;

        // Use physical pixels
        const pw = canvasW * dpr;
        const ph = canvasH * dpr;
        ctx.clearRect(0, 0, pw, ph);
        ctx.save();
        ctx.scale(dpr, dpr);

        // Background grid hint (subtle)
        drawGrid(ctx);

        // Rebuild screen-space cache for current viewport
        rebuildScreenCache();

        // Draw non-selected points first, then selected (on top).
        // Viewport culling: skip points whose screen position falls outside the
        // visible canvas (plus a margin covering the largest drawn radius — the
        // hover glow at POINT_HOVER_R * 1.8). When zoomed out so every point is
        // on-screen this is a no-op; when zoomed in it avoids drawing the bulk of
        // the ~22.9k points. Draw-only — hit-testing/selection are unaffected.
        for (const cp of cachedScreenPoints) {
            if (!isOnScreen(cp.sx, cp.sy)) continue;
            if (!selectedIds.has(cp.point.id)) {
                drawPoint(ctx, cp, false, false);
            }
        }
        for (const cp of cachedScreenPoints) {
            if (!isOnScreen(cp.sx, cp.sy)) continue;
            if (selectedIds.has(cp.point.id)) {
                drawPoint(ctx, cp, false, true);
            }
        }

        // Hover point on top
        if (hoveredPoint) {
            const cp = cachedScreenPoints.find((c) => c.point.id === hoveredPoint!.id);
            if (cp) drawPoint(ctx, cp, true, selectedIds.has(cp.point.id));
        }

        // Lasso overlay
        if (isLasso && lassoPath.length > 1) {
            ctx.beginPath();
            ctx.moveTo(lassoPath[0].x, lassoPath[0].y);
            for (let i = 1; i < lassoPath.length; i++) {
                ctx.lineTo(lassoPath[i].x, lassoPath[i].y);
            }
            ctx.closePath();
            ctx.strokeStyle = 'rgba(139,92,246,0.8)'; // purple-500
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.fillStyle = 'rgba(139,92,246,0.08)';
            ctx.fill();
            ctx.setLineDash([]);
        }

        ctx.restore();
    }

    function drawGrid(ctx: CanvasRenderingContext2D): void {
        // Very subtle grid lines to hint at coordinate space
        ctx.save();
        ctx.strokeStyle = 'rgba(30,41,59,0.6)'; // slate-800
        ctx.lineWidth = 0.5;
        const gridStep = 80 * viewScale;
        if (gridStep < 20) {
            ctx.restore();
            return;
        }
        const startX = (((-viewX * viewScale + canvasW / 2) % gridStep) + gridStep) % gridStep;
        const startY = (((-viewY * viewScale + canvasH / 2) % gridStep) + gridStep) % gridStep;
        for (let x = startX; x < canvasW; x += gridStep) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canvasH);
            ctx.stroke();
        }
        for (let y = startY; y < canvasH; y += gridStep) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvasW, y);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Margin = the largest radius a point can paint (hover glow = POINT_HOVER_R * 1.8),
    // so a point straddling the edge is still drawn.
    const CULL_MARGIN = POINT_HOVER_R * 1.8;

    function isOnScreen(sx: number, sy: number): boolean {
        return (
            sx >= -CULL_MARGIN &&
            sx <= canvasW + CULL_MARGIN &&
            sy >= -CULL_MARGIN &&
            sy <= canvasH + CULL_MARGIN
        );
    }

    function drawPoint(
        ctx: CanvasRenderingContext2D,
        cp: CachedPoint,
        isHovered: boolean,
        isSelected: boolean,
    ): void {
        const { sx, sy, point } = cp;
        const r = isHovered ? POINT_HOVER_R : POINT_BASE_R;
        const color = mapLabelToColor(point.topMood);

        ctx.save();

        // Glow
        if (isHovered || isSelected) {
            ctx.shadowColor = color;
            ctx.shadowBlur = isHovered ? 14 : 8;
            ctx.globalAlpha = isHovered ? 0.5 : 0.35;
            ctx.beginPath();
            ctx.arc(sx, sy, r * 1.8, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.shadowBlur = 0;
        }

        // Point body
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(sx - r * 0.3, sy - r * 0.3, 0, sx, sy, r);
        grad.addColorStop(0, color + 'ee');
        grad.addColorStop(1, color + '77');
        ctx.fillStyle = grad;
        ctx.fill();

        // Selection ring
        if (isSelected) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        ctx.restore();
    }

    function scheduleRedraw(): void {
        dirty = true;
        if (rafId !== null || destroyed) return;
        rafId = requestAnimationFrame(renderLoop);
    }

    function renderLoop(): void {
        rafId = null;
        if (destroyed) return;
        if (dirty) {
            dirty = false;
            drawFrame();
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Canvas resize
    // ──────────────────────────────────────────────────────────────────────────

    function resizeCanvas(): void {
        if (!canvasEl || !containerEl) return;
        const nextDpr = window.devicePixelRatio || 1;
        const rect = containerEl.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (canvasW === width && canvasH === height && dpr === nextDpr) return;
        dpr = nextDpr;
        canvasW = width;
        canvasH = height;
        canvasEl.width = canvasW * dpr;
        canvasEl.height = canvasH * dpr;
        canvasEl.style.width = `${canvasW}px`;
        canvasEl.style.height = `${canvasH}px`;
        resetView();
        scheduleRedraw();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Hit-testing
    // ──────────────────────────────────────────────────────────────────────────

    function hitTest(sx: number, sy: number): MapPoint | null {
        let best: MapPoint | null = null;
        let bestDist = Infinity;
        for (const cp of cachedScreenPoints) {
            const dx = cp.sx - sx;
            const dy = cp.sy - sy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist <= cp.r * 2 && dist < bestDist) {
                bestDist = dist;
                best = cp.point;
            }
        }
        return best;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Pointer event handlers
    // ──────────────────────────────────────────────────────────────────────────

    function onPointerDown(e: PointerEvent): void {
        if (!canvasEl) return;
        const rect = canvasEl.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        if (e.shiftKey) {
            // Lasso mode
            isLasso = true;
            lassoPath = [{ x: sx, y: sy }];
            canvasEl.setPointerCapture(e.pointerId);
            return;
        }

        isDragging = true;
        dragStartX = sx;
        dragStartY = sy;
        dragStartViewX = viewX;
        dragStartViewY = viewY;
        canvasEl.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: PointerEvent): void {
        if (!canvasEl) return;
        const rect = canvasEl.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        if (isLasso) {
            lassoPath = [...lassoPath, { x: sx, y: sy }];
            scheduleRedraw();
            return;
        }

        if (isDragging) {
            const dx = sx - dragStartX;
            const dy = sy - dragStartY;
            viewX = dragStartViewX - dx / viewScale;
            viewY = dragStartViewY - dy / viewScale;
            scheduleRedraw();
            return;
        }

        // Hover hit-test
        const hit = hitTest(sx, sy);
        if (hit !== hoveredPoint) {
            hoveredPoint = hit;
            tooltipX = sx + 12;
            tooltipY = sy - 8;
            scheduleRedraw();
        } else if (hit) {
            tooltipX = sx + 12;
            tooltipY = sy - 8;
        }
    }

    function onPointerUp(e: PointerEvent): void {
        if (!canvasEl) return;

        if (isLasso) {
            finalizeLasso();
            isLasso = false;
            lassoPath = [];
            scheduleRedraw();
            return;
        }

        if (isDragging) {
            const rect = canvasEl.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const dx = Math.abs(sx - dragStartX);
            const dy = Math.abs(sy - dragStartY);

            // Click (not a drag)
            if (dx < 4 && dy < 4) {
                const hit = hitTest(sx, sy);
                if (hit) {
                    openSonicModal(hit);
                } else {
                    // Click on empty space → clear selection
                    if (selectedIds.size > 0) {
                        selectedIds.clear();
                        scheduleRedraw();
                    }
                }
            }
            isDragging = false;
        }
    }

    function onWheel(e: WheelEvent): void {
        e.preventDefault();
        if (!canvasEl) return;
        const rect = canvasEl.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        const delta = e.deltaY > 0 ? 0.85 : 1 / 0.85;
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, viewScale * delta));

        // Zoom toward cursor
        const worldX = (sx - canvasW / 2) / viewScale + viewX;
        const worldY = (sy - canvasH / 2) / viewScale + viewY;
        viewX = worldX - (sx - canvasW / 2) / newScale;
        viewY = worldY - (sy - canvasH / 2) / newScale;
        viewScale = newScale;

        scheduleRedraw();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Lasso selection
    // ──────────────────────────────────────────────────────────────────────────

    function pointInLasso(sx: number, sy: number): boolean {
        if (lassoPath.length < 3) return false;
        let inside = false;
        const n = lassoPath.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = lassoPath[i].x;
            const yi = lassoPath[i].y;
            const xj = lassoPath[j].x;
            const yj = lassoPath[j].y;
            const intersect = yi > sy !== yj > sy && sx < ((xj - xi) * (sy - yi)) / (yj - yi) + xi;
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function finalizeLasso(): void {
        selectedIds.clear();
        for (const cp of cachedScreenPoints) {
            if (pointInLasso(cp.sx, cp.sy)) {
                selectedIds.add(cp.point.id);
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Actions
    // ──────────────────────────────────────────────────────────────────────────

    function openSonicModal(point: MapPoint): void {
        const sonicEnabled = $page.data?.features?.sonicEmbeddings === true;
        openSimilarTracksModal(point.id, sonicEnabled);
    }

    function previewSelection(): void {
        previewTracks = points
            .filter((point) => selectedIds.has(point.id))
            .map((point) =>
                musicTrackFromCard({
                    id: point.id,
                    title: point.title,
                    artists: [{ id: null, title: point.artist ?? '' }],
                    type: 'track',
                }),
            );
    }

    function clearSelection(): void {
        selectedIds.clear();
        scheduleRedraw();
    }

    /**
     * Seed the Mixing Desk with all currently selected tracks, then navigate
     * to /music/alchemy so the user can brew immediately.
     *
     * MapPoint has title + artist but not the full MusicTrack shape.
     * We build minimal MusicTrack stubs (id, title, artist, mediaType) — enough
     * for the seed pad and the brew endpoint (which only uses the IDs).
     */
    async function brewFromSelection(): Promise<void> {
        if (selectedIds.size === 0) return;
        const selectedPoints = points.filter((p) => selectedIds.has(p.id));
        const tracks: MusicTrack[] = selectedPoints.map((p) =>
            musicTrackFromCard({
                id: p.id,
                title: p.title,
                artists: [{ id: null, title: p.artist ?? '' }],
                type: 'track' as const,
            }),
        );
        musicAlchemyStore.addToSeed(tracks);
        toasts.success(m.music_map_brew_seeded({ count: tracks.length }));
        selectedIds.clear();
        scheduleRedraw();
        await goto(resolve('/music/alchemy'));
    }

    /**
     * Admin-only: enqueue the sonic-map-projection task. The existing 5s coverage
     * poll already auto-loads the map once hasCoords flips true, so we just kick
     * the task off and flip a local flag to disable the button / show "Computing…".
     */
    async function startMapProjection(): Promise<void> {
        if (startingProjection || projectionStarted) return;
        startingProjection = true;
        try {
            const res = await fetch(resolve('/admin/developer/sonic-embeddings'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'start-map-projection' }),
            });
            if (!res.ok) {
                toasts.error(m.music_map_projection_failed());
                return;
            }
            projectionStarted = true;
            toasts.success(m.music_map_projection_started());
        } catch {
            toasts.error(m.music_map_projection_failed());
        } finally {
            startingProjection = false;
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ──────────────────────────────────────────────────────────────────────────

    let resizeObserver: ResizeObserver | undefined;

    onMount(() => {
        try {
            isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
        } catch {
            // matchMedia unavailable — assume fine pointer
        }
        if (!musicMapEnabled) return;

        resizeObserver = new ResizeObserver(() => {
            resizeCanvas();
        });
        if (containerEl) {
            resizeObserver.observe(containerEl);
            resizeCanvas();
        }

        loadMapData();
    });

    onDestroy(() => {
        destroyed = true;
        stopPolling();
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        resizeObserver?.disconnect();
    });

    // Re-draw when selectedIds, hoveredPoint, or isLasso changes.
    // isLasso is $state so this effect triggers when lasso mode ends, ensuring
    // the lasso overlay is cleared from the canvas even if no pointermove
    // fires between the last path append and pointerup.
    // Viewport mutations (pan/zoom) call scheduleRedraw() directly.
    $effect(() => {
        // Establish reactive dependencies
        selectedIds.size;
        hoveredPoint;
        isLasso;
        // Only schedule if canvas is ready
        if (canvasEl) scheduleRedraw();
    });
</script>

<svelte:head>
    <title>Music Map</title>
</svelte:head>

{#if !musicMapEnabled}
    <MusicSubpageHeader title={m.music_feature_map_label()} icon={GlobeAlt} />
    <div class="gate-msg">
        <p>Music Map is not enabled on this server.</p>
    </div>
{:else}
    <div class="map-page">
        <div class="map-chrome">
            <MusicSubpageHeader title={m.music_feature_map_label()} icon={GlobeAlt} compact />
            <!-- Map-specific sub-header: status line + selection toolbar -->
            <header class="map-header">
                <div class="header-left">
                    <p class="page-subtitle">
                        {#if loading}
                            Loading projection…
                        {:else if error}
                            &nbsp;
                        {:else if !hasCoords}
                            Projection not yet computed
                        {:else if isCoarsePointer}
                            {points.length.toLocaleString()} tracks · drag to pan · pinch to zoom · tap
                            a dot
                        {:else}
                            {points.length.toLocaleString()} tracks · drag to pan · scroll to zoom · shift-drag
                            to select
                        {/if}
                    </p>
                </div>

                {#if hasCoords}
                    <button
                        class="toolbar-btn"
                        aria-expanded={browseTracks}
                        onclick={() => (browseTracks = !browseTracks)}>Browse tracks</button>
                {/if}
                {#if selectedIds.size > 0}
                    <div class="selection-toolbar">
                        <span class="selection-count"
                            >{m.music_map_selection_label({ count: selectedIds.size })}</span>
                        <button
                            class="toolbar-btn toolbar-btn-primary"
                            onclick={brewFromSelection}
                            title="Seed these tracks into the Mixing Desk and brew a mix">
                            {m.music_map_brew_selection()}
                        </button>
                        <button
                            class="toolbar-btn toolbar-btn-secondary"
                            onclick={previewSelection}
                            title="Preview, play, or save the selected tracks">
                            Preview selection
                        </button>
                        <button
                            class="toolbar-btn"
                            onclick={clearSelection}
                            aria-label="Deselect all"
                            title="Deselect all">
                            ✕
                        </button>
                    </div>
                {/if}
            </header>

            {#if browseTracks}
                <section
                    aria-label="Select map tracks"
                    class="track-browser mx-4 mb-3 rounded-xl border border-surface-700 bg-surface-900 p-3">
                    <input
                        type="search"
                        aria-label="Search map tracks"
                        placeholder="Search songs or artists…"
                        bind:value={trackQuery}
                        class="mb-2 w-full rounded-lg bg-surface-800 px-3 py-2" />
                    <p class="mb-2 text-xs text-surface-400">
                        {matchingPoints.length} matches · showing up to 50. Select songs to preview, play,
                        or save.
                    </p>
                    <div class="max-h-60 overflow-y-auto">
                        {#each matchingPoints.slice(0, 50) as point (point.id)}
                            <label
                                class="flex min-h-11 items-center gap-3 rounded px-2 hover:bg-surface-800">
                                <input
                                    type="checkbox"
                                    checked={selectedIds.has(point.id)}
                                    onchange={(event) => {
                                        if (event.currentTarget.checked) selectedIds.add(point.id);
                                        else selectedIds.delete(point.id);
                                    }} />
                                <span class="min-w-0"
                                    ><span class="block truncate text-sm">{point.title}</span><span
                                        class="block truncate text-xs text-surface-400"
                                        >{point.artist ?? 'Unknown artist'}</span
                                    ></span>
                            </label>
                        {/each}
                    </div>
                </section>
            {/if}
        </div>

        <!-- Canvas area -->
        <div class="canvas-wrap" bind:this={containerEl}>
            <canvas
                bind:this={canvasEl}
                class="starfield-canvas"
                style="cursor: {isLasso ? 'crosshair' : isDragging ? 'grabbing' : 'grab'}"
                aria-label="Music Map — interactive audio embedding projection"
                onpointerdown={onPointerDown}
                onpointermove={onPointerMove}
                onpointerup={onPointerUp}
                onpointerleave={() => {
                    hoveredPoint = null;
                    scheduleRedraw();
                }}
                onwheel={onWheel}></canvas>

            <!-- Static edge-fade overlay. Re-creates the radial edge fade that used
                 to live as a CSS mask on the canvas. A mask over a frequently
                 repainted <canvas> forces per-frame software compositing in Safari
                 (Chrome GPU-composites it). As a separate static layer the browser
                 composites it once. Non-interactive so it never blocks the canvas
                 pointer events or the interactive overlays below it. -->
            <div class="edge-fade" aria-hidden="true"></div>

            <!-- Loading overlay -->
            {#if loading}
                <div class="overlay">
                    <div class="spinner"></div>
                    <p class="overlay-text">Loading map…</p>
                </div>
            {:else if error}
                <div class="overlay">
                    <p class="overlay-text error-text">{error}</p>
                </div>
            {:else if !hasCoords}
                <div class="overlay empty-overlay">
                    <div class="empty-icon" aria-hidden="true">
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
                        </svg>
                    </div>
                    <h2 class="empty-title">{m.music_map_empty_title()}</h2>
                    <p class="empty-body">{m.music_map_empty_body()}</p>

                    {#if embeddingsReady}
                        {#if isAdmin}
                            <p class="backfill-ready">{m.music_map_ready_admin()}</p>
                            <button
                                class="compute-btn"
                                onclick={startMapProjection}
                                disabled={startingProjection || projectionStarted}>
                                {#if projectionStarted || startingProjection}
                                    {m.music_map_computing()}
                                {:else}
                                    {m.music_map_compute_now()}
                                {/if}
                            </button>
                        {:else}
                            <p class="backfill-ready">{m.music_map_ready_non_admin()}</p>
                        {/if}
                    {:else if totalTracks > 0}
                        <div class="backfill">
                            <div class="backfill-meta">
                                <span class="backfill-label"
                                    >{m.music_map_backfill_progress_label()}</span>
                                <span class="backfill-pct">{embedPercent}%</span>
                            </div>
                            <div
                                class="progress-track"
                                role="progressbar"
                                aria-label={m.music_map_backfill_progress_label()}
                                aria-valuenow={embedPercent}
                                aria-valuemin={0}
                                aria-valuemax={100}>
                                <div class="progress-fill" style="width: {embedPercent}%"></div>
                            </div>
                            <div class="backfill-counts">
                                <span
                                    >{m.music_map_backfill_counts({
                                        embedded: embeddedCount.toLocaleString(),
                                        total: totalTracks.toLocaleString(),
                                    })}</span>
                                {#if etaMinutes !== null}
                                    <span class="backfill-eta"
                                        >{m.music_map_backfill_eta({ minutes: etaMinutes })}</span>
                                {/if}
                            </div>
                        </div>
                    {/if}

                    {#if isAdmin}
                        <a href={resolve('/admin/developer/sonic-embeddings')} class="admin-link"
                            >{m.music_map_open_admin()}</a>
                    {/if}
                </div>
            {/if}

            <!-- Hover tooltip -->
            {#if hoveredPoint && !isDragging && !isLasso}
                <div
                    class="tooltip"
                    style="left: {tooltipX}px; top: {tooltipY}px;"
                    aria-live="polite">
                    <p class="tooltip-title">{hoveredPoint.title}</p>
                    {#if hoveredPoint.artist}
                        <p class="tooltip-artist">{hoveredPoint.artist}</p>
                    {/if}
                    {#if hoveredPoint.topMood}
                        <span
                            class="tooltip-mood"
                            style="background-color: {mapLabelToColor(
                                hoveredPoint.topMood,
                            )}22; color: {mapLabelToColor(hoveredPoint.topMood)};">
                            {hoveredPoint.topMood}
                        </span>
                    {/if}
                    <p class="tooltip-hint">Click for similar tracks</p>
                </div>
            {/if}

            <!-- Legend — pinned inside the canvas corner so it stays visible without
                 scrolling (it used to live below the fold as a page footer). Driven by
                 MUSIC_MAP_MOOD_COLORS, the same map used to colour the dots (see
                 mapLabelToColor), so swatches and dots can never drift out of sync. -->
            <footer class="map-legend" aria-label="Mood color legend">
                <span class="legend-label">Mood colors:</span>
                {#each Object.entries(MUSIC_MAP_MOOD_COLORS) as [mood, color] (mood)}
                    <span class="legend-item">
                        <span class="legend-dot" style="background: {color};"></span>
                        {mood}
                    </span>
                {/each}
            </footer>
        </div>
    </div>
{/if}

{#if previewTracks}
    <MixPreview
        title="Music Map selection"
        onretry={previewSelection}
        tracks={previewTracks}
        onclose={() => (previewTracks = null)}>
        <SaveMixButton
            title={`Music Map Selection (${previewTracks.length} tracks)`}
            tracks={previewTracks} />
    </MixPreview>
{/if}

<style>
    /* Map gestures own the viewport, including on mobile where other routes scroll. */
    :global(body:has(.map-page)) {
        overflow: hidden;
    }

    /* This route fills the shell; the dock, navbar and player keep their own layers. */
    :global(.main-content:has(.map-page)) {
        position: fixed;
        inset: 0 0 var(--music-bottom-stack, 0px);
        width: auto;
        max-height: none;
        padding-bottom: 0;
        overflow: hidden;
    }

    .map-page {
        position: relative;
        width: 100%;
        height: 100%;
        min-height: 0;
        background: rgb(2 6 23);
    }

    .map-chrome {
        position: absolute;
        inset: calc(76px + env(safe-area-inset-top, 0px)) 0 auto;
        z-index: 20;
        max-height: calc(100% - 76px - env(safe-area-inset-top, 0px) - 4rem);
        overflow-y: auto;
        pointer-events: auto;
        overscroll-behavior: contain;
        background: linear-gradient(rgb(2 6 23 / 0.9), rgb(2 6 23 / 0));
    }

    /* ── Map sub-header (status line + toolbar) ───────────────────────────── */
    .map-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        /* The overlay owns the navbar clearance; controls wrap on narrow screens. */
        padding: 0.5rem 1.25rem 0.75rem;
        border-bottom: 1px solid rgb(30 41 59); /* slate-800 */
        flex-shrink: 0;
        gap: 1rem;
        flex-wrap: wrap;
    }

    .header-left {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
    }

    .page-subtitle {
        font-size: 0.7rem;
        color: rgb(100 116 139); /* slate-500 */
        margin: 0;
    }

    /* ── Selection toolbar ─────────────────────────────────────────────────── */
    .selection-toolbar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .selection-count {
        font-size: 0.75rem;
        color: rgb(167 139 250); /* purple-400 */
        font-weight: 600;
    }

    .toolbar-btn {
        padding: 0.3rem 0.75rem;
        border-radius: 0.4rem;
        font-size: 0.72rem;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid rgb(51 65 85); /* slate-700 */
        background: rgb(15 23 42); /* slate-900 */
        color: rgb(148 163 184); /* slate-400 */
        transition:
            background 0.1s,
            color 0.1s;
    }

    .toolbar-btn:hover:not(:disabled) {
        background: rgb(30 41 59); /* slate-800 */
        color: rgb(226 232 240);
    }

    .toolbar-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .toolbar-btn-primary {
        background: rgb(124 58 237); /* purple-600 */
        border-color: rgb(124 58 237);
        color: #fff;
    }

    .toolbar-btn-primary:hover:not(:disabled) {
        background: rgb(109 40 217); /* purple-700 */
        color: #fff;
    }

    /* Secondary style reuses the base .toolbar-btn appearance (slate ghost).
       Explicit class keeps markup semantic without duplicating selectors. */
    .toolbar-btn-secondary {
        border-color: rgb(71 85 105); /* slate-600 */
    }

    /* ── Canvas area ───────────────────────────────────────────────────────── */
    .canvas-wrap {
        /* Keep intrinsic canvas dimensions out of the observer's sizing loop. */
        position: absolute;
        inset: 0;
        overflow: hidden;
    }

    .starfield-canvas {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
        touch-action: none;
        /* The canvas element itself paints the dark map rectangle (the grid/points
           are drawn transparently on top). Putting the dark fill here — rather than
           on .map-page — lets the .edge-fade overlay above fade the edges into the
           same colour. */
        background-color: rgb(2 6 23); /* slate-950 */
    }

    /* Static edge-fade layer. Replaces the old CSS mask that lived on the canvas
       (a mask over a repainting <canvas> forces per-frame software compositing in
       Safari and tanked the frame rate). This is a single static gradient the
       browser composites once. The transparent->slate-950 radial fades the outer
       ~22% of the starfield into the canvas background colour, giving the identical
       soft-edge look. It sits above the canvas but is pointer-events:none, so it
       neither blocks canvas interaction nor the loading / error / empty overlays
       rendered after it. */
    .edge-fade {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: radial-gradient(
            ellipse 100% 100% at 50% 50%,
            transparent 78%,
            rgb(2 6 23) 100%
        );
    }

    /* ── Overlays ──────────────────────────────────────────────────────────── */
    .overlay {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        pointer-events: none;
    }

    .overlay-text {
        color: rgb(100 116 139); /* slate-500 */
        font-size: 0.85rem;
        margin: 0;
    }

    .error-text {
        color: rgb(248 113 113); /* red-400 */
    }

    .spinner {
        width: 2rem;
        height: 2rem;
        border: 3px solid rgb(51 65 85);
        border-top-color: rgb(139 92 246); /* purple-500 */
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    /* ── Empty state ───────────────────────────────────────────────────────── */
    /* Empty overlay fills the canvas and centres its content on both axes
       (inherits inset:0 + flex centring from .overlay). The 28rem cap lives on
       the children's container width via max-width with auto side margins so it
       stays centred rather than left-anchored. */
    .empty-overlay {
        pointer-events: auto;
        overflow-y: auto;
        justify-content: safe center;
        text-align: center;
        padding: 2rem;
    }

    .empty-overlay > * {
        max-width: 28rem;
    }

    .empty-icon {
        width: 3rem;
        height: 3rem;
        color: rgb(71 85 105); /* slate-600 */
    }

    .empty-icon svg {
        width: 100%;
        height: 100%;
    }

    .empty-title {
        font-size: 1rem;
        font-weight: 700;
        color: rgb(148 163 184); /* slate-400 */
        margin: 0;
    }

    .empty-body {
        font-size: 0.8rem;
        color: rgb(71 85 105); /* slate-600 */
        line-height: 1.5;
        margin: 0;
    }

    .compute-btn {
        display: inline-block;
        margin-top: 0.25rem;
        padding: 0.5rem 1.25rem;
        border-radius: 0.4rem;
        border: 1px solid rgb(124 58 237); /* purple-600 */
        background: rgb(124 58 237); /* purple-600 */
        color: #fff;
        font-size: 0.82rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.1s;
    }

    .compute-btn:hover:not(:disabled) {
        background: rgb(109 40 217); /* purple-700 */
    }

    .compute-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .admin-link {
        display: inline-block;
        margin-top: 0.25rem;
        padding: 0.4rem 1rem;
        border-radius: 0.4rem;
        background: rgb(30 41 59);
        color: rgb(139 92 246);
        font-size: 0.78rem;
        font-weight: 600;
        text-decoration: none;
        transition: background 0.1s;
    }

    .admin-link:hover {
        background: rgb(51 65 85);
    }

    /* ── Backfill progress ─────────────────────────────────────────────────── */
    .backfill {
        width: 100%;
        max-width: 22rem;
        margin: 0.5rem auto 0.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    .backfill-meta {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.5rem;
    }

    .backfill-label {
        font-size: 0.7rem;
        font-weight: 600;
        color: rgb(148 163 184); /* slate-400 */
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .backfill-pct {
        font-size: 0.75rem;
        font-weight: 700;
        color: rgb(167 139 250); /* purple-400 */
    }

    .progress-track {
        width: 100%;
        height: 0.5rem;
        border-radius: 9999px;
        background: rgb(30 41 59); /* slate-800 */
        overflow: hidden;
    }

    .progress-fill {
        height: 100%;
        border-radius: 9999px;
        background: linear-gradient(90deg, rgb(124 58 237), rgb(167 139 250));
        transition: width 0.4s ease;
    }

    .backfill-counts {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.5rem;
        font-size: 0.7rem;
        color: rgb(100 116 139); /* slate-500 */
    }

    .backfill-eta {
        color: rgb(148 163 184); /* slate-400 */
        font-variant-numeric: tabular-nums;
    }

    .backfill-ready {
        font-size: 0.78rem;
        font-weight: 600;
        color: rgb(134 239 172); /* green-300 */
        margin: 0.5rem auto 0;
        max-width: 24rem;
        line-height: 1.4;
    }

    /* ── Tooltip ───────────────────────────────────────────────────────────── */
    .tooltip {
        position: absolute;
        pointer-events: none;
        background: rgb(15 23 42 / 0.95);
        border: 1px solid rgb(51 65 85);
        border-radius: 0.5rem;
        padding: 0.5rem 0.75rem;
        max-width: 200px;
        backdrop-filter: blur(8px);
        z-index: 10;
    }

    .tooltip-title {
        font-size: 0.78rem;
        font-weight: 700;
        color: rgb(226 232 240);
        margin: 0 0 0.1rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .tooltip-artist {
        font-size: 0.7rem;
        color: rgb(100 116 139);
        margin: 0 0 0.3rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .tooltip-mood {
        display: inline-block;
        padding: 0.1rem 0.4rem;
        border-radius: 9999px;
        font-size: 0.65rem;
        font-weight: 600;
        text-transform: capitalize;
        margin-bottom: 0.3rem;
    }

    .tooltip-hint {
        font-size: 0.62rem;
        color: rgb(71 85 105);
        margin: 0;
    }

    /* ── Legend ────────────────────────────────────────────────────────────── */
    /* Pinned inside the bottom-left corner of the canvas (rather than as a
       page footer below the fold, where it used to be invisible without
       scrolling). Sized to its content and pointer-events:none — same
       treatment as .tooltip — so it never steals pan/zoom pointer events,
       inside its own footprint or out. */
    .map-legend {
        position: absolute;
        left: 0.75rem;
        bottom: 0.75rem;
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        max-width: calc(100% - 1.5rem);
        padding: 0.35rem 0.6rem;
        border-radius: 0.5rem;
        border: 1px solid rgb(51 65 85 / 0.6); /* slate-700, translucent */
        background: rgb(2 6 23 / 0.72); /* slate-950, glassy */
        backdrop-filter: blur(8px);
        flex-wrap: wrap;
        pointer-events: none;
    }

    .legend-label {
        font-size: 0.58rem;
        color: rgb(100 116 139);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        flex-shrink: 0;
    }

    .legend-item {
        display: flex;
        align-items: center;
        gap: 0.2rem;
        font-size: 0.6rem;
        color: rgb(148 163 184);
        text-transform: capitalize;
        white-space: nowrap;
    }

    .legend-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    /* ── Gate message ──────────────────────────────────────────────────────── */
    .gate-msg {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4rem 1rem;
        color: rgb(100 116 139);
        font-size: 0.875rem;
    }
</style>
