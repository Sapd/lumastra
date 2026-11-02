// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subtitle Renderer Manager
 *
 * Manages bitmap and styled subtitle renderers:
 * - PGS (Blu-ray) via libbitsub
 * - VobSub (DVD) via libbitsub
 * - ASS/SSA via AkariSub
 *
 * Handles WASM initialization, renderer lifecycle, and cleanup.
 */

import { SUBTITLE } from './timing-constants';
import { browser } from '$app/environment';
import type { SubtitleStreamInfo } from '$lib/types/playback';
import type * as Libbitsub from 'libbitsub';
import type { SubtitleDisplaySettings } from 'libbitsub';
import type AkariSub from 'akarisub';
import type * as AkariSubNamespace from 'akarisub';
import { isPgsCodec, isAssCodec, isVobsubCodec } from './subtitle-utils';

// ============================================================================
// Types
// ============================================================================

// libbitsub types - loaded dynamically
type LibbitsubModule = typeof Libbitsub;
type PgsRendererType = InstanceType<LibbitsubModule['PgsRenderer']>;
type VobSubRendererType = InstanceType<LibbitsubModule['VobSubRenderer']>;

// AkariSub is loaded dynamically; akarisub 1.x ships its own declarations, so
// its option/instance types come straight from the package.
type AkariSubModule = typeof AkariSubNamespace;

export interface SubtitleRendererConfig {
    /** A current subtitle renderer failed after it had become ready. The viewer may retry. */
    onRendererError?: (subtitleIndex: number) => void;
    /** Enable debug logging */
    debug?: boolean;
    /** Evaluate at renderer creation, after the playback engine has been selected. */
    useFrameAwareSync?: () => boolean;
    /**
     * Override for the ASS fallback font ('liberation sans').
     *
     * Leave unset in normal use. The default is akarisub's own bundled copy,
     * resolved via `getDefaultFontUrl()` — see `resolveFallbackFontUrl()`.
     */
    defaultFontUrl?: string;
    /** Global subtitle size multiplier (default: 1.2) */
    sizeMultiplier?: number;
    /** PGS subtitle base scale as percentage (default: 55) */
    pgsScale?: number;
}

/**
 * Config with every default applied. `defaultFontUrl` stays optional: it has no
 * static default, because the fallback font URL is only knowable once the
 * akarisub module has loaded.
 */
type ResolvedSubtitleRendererConfig = Required<Omit<SubtitleRendererConfig, 'defaultFontUrl'>> &
    Pick<SubtitleRendererConfig, 'defaultFontUrl'>;

export interface SubtitleContext {
    itemId: string;
    mediaSourceId: string;
    subtitleStreams: SubtitleStreamInfo[];
}

type LogFunction = (...args: unknown[]) => void;

// ============================================================================
// Subtitle Renderer Manager
// ============================================================================

/**
 * Manages subtitle renderers for a video element.
 * Handles PGS, VobSub, and ASS/SSA subtitle formats.
 */
export class SubtitleRendererManager {
    private videoElement: HTMLVideoElement | null = null;
    private context: SubtitleContext | null = null;
    private config: ResolvedSubtitleRendererConfig;
    private log: LogFunction;

    // Renderer instances
    private cancelBitmapReady: (() => void) | null = null;
    private cancelAssInitialization: (() => void) | null = null;
    private cleanupAssError: (() => void) | null = null;

    private pgsRenderer: PgsRendererType | null = null;
    private vobsubRenderer: VobSubRendererType | null = null;
    private assRenderer: AkariSub | null = null;

    // WASM/module state
    private libbitsub: LibbitsubModule | null = null;
    private bitsubWasmInitialized = false;
    private akariSubClass: typeof AkariSub | null = null;
    private akariSubModule: AkariSubModule | null = null;
    private assBlobUrl: string | null = null;

    // Monotonic counter used to abort in-flight async init calls when a newer
    // init or dispose supersedes them. Each init captures its generation after
    // sync disposes, then re-checks after every await; a stale value means the
    // user switched tracks mid-fetch and this init must not attach a renderer.
    private initGeneration = 0;
    private subtitleFetchController: AbortController | null = null;

    // Pending SDK work owns its renderer strongly until initialization settles.
    // Weak references let the observer recognize a late-created orphan canvas
    // without retaining disposed subtitle buffers. Settled disposals leave immediately.
    private knownLibbitsubRenderers = new Set<WeakRef<PgsRendererType | VobSubRendererType>>();
    private bitmapLifecycle = new WeakMap<
        PgsRendererType | VobSubRendererType,
        { pending: boolean }
    >();

    // Observes the video's parent for <canvas> additions. Needed because
    // libbitsub's async init has `await initWasm()` → `createCanvas()` with no
    // disposed guard — so if we dispose between those steps, the canvas is
    // attached to the DOM *after* dispose, creating a stray layer. The
    // observer fires synchronously for the insertion microtask, letting us
    // either tag the canvas as the current renderer's or strip it if it
    // belongs to a disposed one.
    private canvasObserver: MutationObserver | null = null;

    constructor(config: SubtitleRendererConfig = {}, log?: LogFunction) {
        this.config = {
            debug: config.debug ?? false,
            onRendererError: config.onRendererError ?? (() => {}),
            useFrameAwareSync: config.useFrameAwareSync ?? (() => true),
            defaultFontUrl: config.defaultFontUrl,
            sizeMultiplier: config.sizeMultiplier ?? 1.2,
            pgsScale: config.pgsScale ?? 55,
        };
        this.log =
            log ??
            ((...args) => {
                if (this.config.debug) console.log('[SubtitleRenderer]', ...args);
            });
    }

    /**
     * Set the video element for subtitle rendering
     */
    setVideoElement(element: HTMLVideoElement | null): void {
        this.canvasObserver?.disconnect();
        this.canvasObserver = null;

        this.videoElement = element;

        const parent = element?.parentElement;
        if (!parent || typeof MutationObserver === 'undefined') return;

        this.canvasObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLCanvasElement) {
                        this.handleCanvasAdded(node);
                    }
                });
            }
        });
        this.canvasObserver.observe(parent, { childList: true });
    }

    /**
     * Classify each newly-added canvas in the video parent.
     *
     * - Canvas owned by the current PGS/VobSub renderer → tag so the sweep can
     *   find it on teardown (does nothing harmful; belt-and-braces).
     * - Canvas owned by a previously-constructed libbitsub renderer that is
     *   no longer current → stale init fired `createCanvas` after dispose;
     *   remove it before a second subtitle layer ever paints.
     * - Any other canvas (AkariSub, trickplay) → ignore.
     */
    private handleCanvasAdded(canvas: HTMLCanvasElement): void {
        const pgsCanvas = (this.pgsRenderer as unknown as { canvas?: HTMLCanvasElement | null })
            ?.canvas;
        const vobCanvas = (
            this.vobsubRenderer as unknown as {
                canvas?: HTMLCanvasElement | null;
            }
        )?.canvas;

        if (canvas === pgsCanvas) {
            canvas.setAttribute('data-libbitsub-owner', 'pgs');
            return;
        }
        if (canvas === vobCanvas) {
            canvas.setAttribute('data-libbitsub-owner', 'vobsub');
            return;
        }

        for (const reference of this.knownLibbitsubRenderers) {
            const renderer = reference.deref();
            if (!renderer) {
                this.knownLibbitsubRenderers.delete(reference);
                continue;
            }
            const rCanvas = (renderer as unknown as { canvas?: HTMLCanvasElement | null })?.canvas;
            if (rCanvas === canvas) {
                console.warn(
                    '[SubtitleRenderer] Removing stale libbitsub canvas — createCanvas raced past dispose',
                );
                canvas.remove();
                this.knownLibbitsubRenderers.delete(reference);
                return;
            }
        }
    }

    /**
     * Update the subtitle context (item ID, media source, streams)
     */
    setContext(context: SubtitleContext | null): void {
        this.context = context;
    }

    /**
     * Initialize the appropriate renderer for a subtitle track
     */
    async initRenderer(subtitleIndex: number): Promise<boolean> {
        if (!this.context || !this.videoElement) {
            this.log('Cannot init renderer - missing context or video element');
            return false;
        }

        const stream = this.context.subtitleStreams.find((s) => s.index === subtitleIndex);
        if (!stream) {
            this.log('Subtitle stream not found:', subtitleIndex);
            return false;
        }

        const codec = stream.codec?.toLowerCase() || '';

        if (isPgsCodec(codec)) {
            return this.initPgsRenderer(subtitleIndex, stream);
        } else if (isVobsubCodec(codec)) {
            return this.initVobsubRenderer(subtitleIndex, stream);
        } else if (isAssCodec(codec)) {
            return this.initAssRenderer(subtitleIndex, stream);
        }

        this.log('Unknown subtitle codec, cannot init renderer:', codec);
        return false;
    }

    /**
     * Dispose all active renderers
     */
    disposeAll(): void {
        this.initGeneration++;
        this.subtitleFetchController?.abort();
        this.subtitleFetchController = null;
        this.disposePgsRenderer();
        this.disposeVobsubRenderer();
        this.disposeAssRenderer();
        this.sweepOrphanLibbitsubCanvases();
    }

    /**
     * Remove any libbitsub-tagged canvases left in the video parent.
     *
     * Libbitsub's async init runs `await initWasm()` → `createCanvas()` after
     * our `dispose()` has already set `disposed=true`. That late `createCanvas`
     * appends a new canvas to the DOM AFTER dispose cleared the reference, so
     * it is never removed — producing a second visible subtitle layer on the
     * next init. Tag each canvas as soon as we can access it, then sweep any
     * stragglers here.
     */
    private sweepOrphanLibbitsubCanvases(): void {
        const parent = this.videoElement?.parentElement;
        if (!parent) return;
        const orphans = parent.querySelectorAll<HTMLCanvasElement>('canvas[data-libbitsub-owner]');
        if (orphans.length === 0) return;
        console.warn(
            `[SubtitleRenderer] Sweeping ${orphans.length} orphan libbitsub canvas(es) — libbitsub createCanvas likely raced past dispose`,
        );
        orphans.forEach((c) => c.remove());
    }

    /**
     * Tag a libbitsub renderer's internal canvas with a data attribute so the
     * orphan sweep can find it later. Called from onLoading because the canvas
     * is created before loadSubtitles fires that callback.
     */
    private tagRendererCanvas(
        renderer: PgsRendererType | VobSubRendererType | null,
        kind: 'pgs' | 'vobsub',
    ): void {
        if (!renderer) return;
        const canvas = (renderer as unknown as { canvas: HTMLCanvasElement | null }).canvas;
        if (canvas && !canvas.hasAttribute('data-libbitsub-owner')) {
            canvas.setAttribute('data-libbitsub-owner', kind);
        }
    }

    /**
     * Check if any renderer is currently active
     */
    hasActiveRenderer(): boolean {
        return (
            this.pgsRenderer !== null || this.vobsubRenderer !== null || this.assRenderer !== null
        );
    }

    /**
     * Check if a subtitle index refers to a PGS subtitle
     */
    isPgsSubtitle(subtitleIndex: number | null): boolean {
        if (subtitleIndex === null || !this.context) return false;
        const stream = this.context.subtitleStreams.find((s) => s.index === subtitleIndex);
        return isPgsCodec(stream?.codec);
    }

    /**
     * Check if a subtitle index refers to an ASS/SSA subtitle
     */
    isAssSubtitle(subtitleIndex: number | null): boolean {
        if (subtitleIndex === null || !this.context) return false;
        const stream = this.context.subtitleStreams.find((s) => s.index === subtitleIndex);
        return isAssCodec(stream?.codec);
    }

    /**
     * Check if a subtitle index refers to a VobSub subtitle
     */
    isVobsubSubtitle(subtitleIndex: number | null): boolean {
        if (subtitleIndex === null || !this.context) return false;
        const stream = this.context.subtitleStreams.find((s) => s.index === subtitleIndex);
        return isVobsubCodec(stream?.codec);
    }

    /**
     * Check if a subtitle needs a special renderer (not native VTT)
     */
    needsSpecialRenderer(subtitleIndex: number | null): boolean {
        return (
            this.isPgsSubtitle(subtitleIndex) ||
            this.isAssSubtitle(subtitleIndex) ||
            this.isVobsubSubtitle(subtitleIndex)
        );
    }

    /**
     * Sync subtitle position to current video time (call on unpause)
     * Forces all renderers to re-sync with the video timeline
     */
    syncToCurrentTime(): void {
        if (!this.videoElement) return;

        const currentTime = this.videoElement.currentTime;
        this.log('Syncing subtitle position to:', currentTime);

        // For ASS: trigger a seek to force AkariSub to resync
        if (this.assRenderer && currentTime > 0.1) {
            this.videoElement.currentTime = currentTime;
        }

        // PGS and VobSub renderers from libbitsub sync automatically via requestAnimationFrame
        // but we can trigger a resize to ensure canvas is correct
        if (this.pgsRenderer || this.vobsubRenderer) {
            // libbitsub renderers auto-sync, no explicit action needed
        }
    }

    /**
     * Check if any special renderer is active
     */
    hasActiveSpecialRenderer(): boolean {
        return (
            this.assRenderer !== null || this.pgsRenderer !== null || this.vobsubRenderer !== null
        );
    }

    // ========================================================================
    // Public: Style Application
    // ========================================================================

    /**
     * Apply subtitle style settings to all active renderers.
     * Note: Different formats support different style options:
     * - PGS/VobSub (bitmap): scale and vertical position only
     * - ASS/SSA: preserve embedded styles and positioning
     */
    applyStyle(style: {
        fontSize?: number; // User size multiplier, default 1.0
        positionY?: number; // 0-100 percentage from top, default 85
        textColor?: string; // hex color
        outlineColor?: string; // hex color
        outlineWidth?: number; // 0-4px
        shadowBlur?: number; // 0-8px
        backgroundColor?: string; // hex color with alpha
    }): void {
        this.log('Applying subtitle style:', style);

        // Apply to PGS/VobSub (bitmap subtitles) - scale and position only
        if (this.pgsRenderer || this.vobsubRenderer) {
            const displaySettings = this.convertToDisplaySettings(style);
            this.log('Applying to bitmap renderer:', displaySettings);

            if (this.pgsRenderer) {
                try {
                    this.pgsRenderer.setDisplaySettings(displaySettings);
                } catch (e) {
                    this.log('Failed to apply style to PGS renderer:', e);
                }
            }
            if (this.vobsubRenderer) {
                try {
                    this.vobsubRenderer.setDisplaySettings(displaySettings);
                } catch (e) {
                    this.log('Failed to apply style to VobSub renderer:', e);
                }
            }
        }

        // ASS/SSA subtitles have their own embedded styles with precise positioning
        // (text above heads, sign translations, karaoke effects, etc.)
        // Don't override - scaling would break the careful positioning
        // The style selector only affects PGS/VobSub and SRT/VTT subtitles
    }

    /**
     * Reset subtitle styles to defaults for all active renderers
     */
    resetStyle(): void {
        this.log('Resetting subtitle styles');

        if (this.pgsRenderer) {
            try {
                this.pgsRenderer.resetDisplaySettings();
            } catch (e) {
                this.log('Failed to reset PGS renderer style:', e);
            }
        }
        if (this.vobsubRenderer) {
            try {
                this.vobsubRenderer.resetDisplaySettings();
            } catch (e) {
                this.log('Failed to reset VobSub renderer style:', e);
            }
        }
        if (this.assRenderer) {
            try {
                this.assRenderer.disableStyleOverride();
            } catch (e) {
                this.log('Failed to reset ASS renderer style:', e);
            }
        }
    }

    /**
     * Convert user style settings to libbitsub display settings
     */
    private convertToDisplaySettings(style: {
        fontSize?: number;
        positionY?: number;
    }): Partial<SubtitleDisplaySettings> {
        const settings: Partial<SubtitleDisplaySettings> = {};

        // libbitsub already maps bitmap source dimensions into the rendered video
        // and updates that mapping on resize. Apply only the user/server tuning
        // here so geometry is scaled once and track initialization size is irrelevant.
        if (style.fontSize !== undefined) {
            settings.scale =
                style.fontSize * this.config.sizeMultiplier * (this.config.pgsScale / 100);
        }

        // Convert positionY (0-100 from top) to verticalOffset (-50 to 50)
        // positionY 85 (15% from bottom) = verticalOffset 0 (default)
        // positionY 50 (middle) = verticalOffset -35
        // positionY 95 (5% from bottom) = verticalOffset 10
        if (style.positionY !== undefined) {
            // Convert from "percentage from top" to "offset from default position"
            // Default is 85 (15% from bottom), so offset = (positionY - 85)
            // Clamp to valid range
            settings.verticalOffset = Math.max(-50, Math.min(50, (style.positionY - 85) * 1.5));
        }

        return settings;
    }

    // ========================================================================
    // Private: WASM Initialization
    // ========================================================================

    private async ensureBitsubWasm(): Promise<boolean> {
        if (this.libbitsub && this.bitsubWasmInitialized) {
            return true;
        }

        if (!browser) {
            return false;
        }

        try {
            if (!this.libbitsub) {
                const libbitsub = await import('libbitsub');
                this.libbitsub = libbitsub;
                this.log('libbitsub module loaded');
            }

            if (!this.libbitsub.isWasmInitialized()) {
                await this.libbitsub.initWasm();
                this.log('libbitsub WASM initialized via package asset');
            }

            this.bitsubWasmInitialized = true;
            return true;
        } catch (error) {
            console.error('[SubtitleRenderer] Failed to initialize libbitsub WASM:', error);
            return false;
        }
    }

    /**
     * URL of the ASS fallback font registered as `'liberation sans'`.
     *
     * Uses akarisub's own bundled copy, not a path under `static/`. Inside
     * akarisub, `getDefaultFontUrl()` is a `new URL('../../assets/default.woff2',
     * import.meta.url)`, which Vite rewrites at build time to the content-hashed
     * emit under `/_app/immutable/assets/`.
     *
     * That prefix matters — it is the only one that gets long-lived cache
     * headers. adapter-node's static handler sets
     * `cache-control: public,max-age=31536000,immutable` only for paths under
     * `${appPath}/immutable/`; the service worker's `isStaticAsset()` treats
     * only `/_app/immutable/` as cache-first; and `immutable-asset-fallback`
     * can only replay hashed assets from a previous build under that prefix.
     *
     * The previous default, a bare `/default.woff2` copied out of `static/`,
     * matched none of those, so the 146 KB font was refetched on every subtitle
     * session. It was also a byte-identical duplicate of the file akarisub
     * already ships, so pointing here drops a redundant copy from the build.
     *
     * Only called from `initAssRenderer`, after `ensureAkariSub()` has resolved
     * truthy; the throw is a guard against future callers, and lands in that
     * method's existing catch.
     */
    private resolveFallbackFontUrl(): string {
        const override = this.config.defaultFontUrl;
        if (override) return override;
        if (!this.akariSubModule) {
            throw new Error('AkariSub module not loaded — cannot resolve the fallback font URL');
        }
        return this.akariSubModule.getDefaultFontUrl();
    }

    private async ensureAkariSub(): Promise<boolean> {
        if (this.akariSubClass) {
            return true;
        }

        if (!browser) {
            return false;
        }

        try {
            // Dynamic import of the AkariSub ES module
            const akariSubModule = await import('akarisub');
            this.akariSubModule = akariSubModule;
            this.akariSubClass = akariSubModule.default;
            this.log('AkariSub module loaded');
            return true;
        } catch (error) {
            console.error('[SubtitleRenderer] Failed to load AkariSub module:', error);
            return false;
        }
    }

    /**
     * Resolve once AkariSub has finished worker/WASM setup.
     *
     * AkariSub exposes no `ready` Promise; it is an EventTarget that dispatches
     * a one-shot `ready` event. A safety timeout guarantees we never block
     * resize/sync forever if the event is missed.
     */
    private waitForAkariSubReady(
        renderer: AkariSub,
        generation: number,
        subtitleIndex: number,
    ): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            let settled = false;
            let ready = false;
            const cleanup = (): void => {
                clearTimeout(timer);
                renderer.removeEventListener('ready', onReady);
                if (!ready) renderer.removeEventListener('error', onError);
                if (this.cancelAssInitialization === cancel) this.cancelAssInitialization = null;
            };
            const finish = (success: boolean): void => {
                if (settled) return;
                settled = true;
                ready =
                    success && generation === this.initGeneration && this.assRenderer === renderer;
                cleanup();
                resolve(ready);
            };
            const onReady = (): void => finish(true);
            const onError = (): void => {
                if (!settled) {
                    finish(false);
                    return;
                }
                if (ready && generation === this.initGeneration && this.assRenderer === renderer) {
                    this.disposeAssRenderer();
                    this.config.onRendererError(subtitleIndex);
                }
            };
            const cancel = (): void => finish(false);
            const timer = setTimeout(cancel, SUBTITLE.INIT_TIMEOUT_MS);
            this.cancelAssInitialization = cancel;
            this.cleanupAssError = (): void => renderer.removeEventListener('error', onError);
            renderer.addEventListener('ready', onReady);
            renderer.addEventListener('error', onError);
        });
    }

    // ========================================================================
    // Private: PGS Renderer
    // ========================================================================

    private bitmapReadiness(generation: number): {
        ready: Promise<boolean>;
        finish: (success: boolean) => void;
    } {
        this.cancelBitmapReady?.();
        let finish!: (success: boolean) => void;
        const ready = new Promise<boolean>((resolve) => {
            let settled = false;
            const cancel = (): void => finish(false);
            const timer = setTimeout(cancel, SUBTITLE.INIT_TIMEOUT_MS);
            finish = (success): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (this.cancelBitmapReady === cancel) this.cancelBitmapReady = null;
                resolve(success && generation === this.initGeneration);
            };
            this.cancelBitmapReady = cancel;
        });
        return { ready, finish };
    }

    private async initPgsRenderer(
        subtitleIndex: number,
        stream: SubtitleStreamInfo,
    ): Promise<boolean> {
        this.disposePgsRenderer();
        this.disposeVobsubRenderer();
        this.sweepOrphanLibbitsubCanvases();
        const generation = ++this.initGeneration;

        if (!this.context || !this.videoElement) return false;

        if (!(await this.ensureBitsubWasm())) {
            console.error('[SubtitleRenderer] Cannot init PGS renderer - WASM not available');
            return false;
        }
        if (generation !== this.initGeneration) {
            this.log('initPgsRenderer: aborted after WASM init (stale generation)');
            return false;
        }

        const pgsUrl = stream.hrefs?.raw;
        if (!pgsUrl) return false;
        this.log('Initializing PGS renderer:', {
            index: subtitleIndex,
            codec: stream.codec,
            displayTitle: stream.displayTitle,
            url: pgsUrl,
        });

        try {
            // Pre-fetch with credentials — libbitsub's internal fetch() doesn't
            // include auth headers, causing 401 with forward-auth proxies.
            const subContent = await this.fetchSubtitleData(pgsUrl);
            if (!subContent) return false;
            if (generation !== this.initGeneration) {
                this.log('initPgsRenderer: aborted after fetch (stale generation)');
                return false;
            }

            const readiness = this.bitmapReadiness(generation);
            let loaded = false;
            const lifecycle = { pending: true };
            let newRenderer: PgsRendererType | null = null;
            newRenderer = new this.libbitsub!.PgsRenderer({
                video: this.videoElement,
                frameAwareSync: this.config.useFrameAwareSync(),
                subContent,
                onLoading: () => {
                    this.log('PGS subtitle loading...');
                    this.tagRendererCanvas(newRenderer, 'pgs');
                },
                onLoaded: () => {
                    lifecycle.pending = false;
                    if (generation !== this.initGeneration) {
                        this.releaseKnownRenderer(newRenderer);
                        return;
                    }
                    loaded = true;
                    this.log('PGS subtitle loaded');
                    this.tagRendererCanvas(newRenderer, 'pgs');
                    readiness.finish(true);
                },
                onError: (error: Error) => {
                    lifecycle.pending = false;
                    if (generation !== this.initGeneration) this.releaseKnownRenderer(newRenderer);
                    console.error('[SubtitleRenderer] PGS error:', error);
                    readiness.finish(false);
                    if (
                        loaded &&
                        generation === this.initGeneration &&
                        this.pgsRenderer === newRenderer
                    ) {
                        this.disposePgsRenderer();
                        this.config.onRendererError(subtitleIndex);
                    }
                },
                // DEBUG: capture timing data to diagnose subtitle desync after seeking.
                // cueStartTime is in ms, videoCurrentTime in seconds.
                // driftMs = (videoCurrentTime * 1000) - cueStartTime: positive means
                // video is ahead of the cue start (normal during playback), large
                // values indicate the PGS cue doesn't match the actual video content.
                onEvent: (event) => {
                    if (event.type === 'loaded' && 'metadata' in event) {
                        const meta = (
                            event as unknown as {
                                metadata: Record<string, unknown>;
                            }
                        ).metadata;
                        console.log('[PGS TIMING] loaded:', {
                            totalCues: meta.totalCues,
                            firstTimestampMs: meta.firstTimestamp,
                            lastTimestampMs: meta.lastTimestamp,
                            videoCurrentTime: this.videoElement?.currentTime,
                        });
                    } else if (event.type === 'cue-change') {
                        const cue = (
                            event as {
                                cue: {
                                    index: number;
                                    startTime: number;
                                    endTime: number;
                                    duration: number;
                                } | null;
                            }
                        ).cue;
                        const vt = this.videoElement?.currentTime ?? 0;
                        console.log('[PGS TIMING] cue-change:', {
                            cueIndex: cue?.index,
                            cueStartMs: cue?.startTime,
                            cueEndMs: cue?.endTime,
                            videoCurrentTime: vt,
                            // How far into this cue we are (should be 0-cueDuration for correct sync)
                            driftMs: cue ? Math.round(vt * 1000 - cue.startTime) : null,
                        });
                    }
                },
            });
            this.pgsRenderer = newRenderer;
            this.knownLibbitsubRenderers.add(new WeakRef(newRenderer));
            this.bitmapLifecycle.set(newRenderer, lifecycle);
            const success = await readiness.ready;
            if (!success && generation === this.initGeneration) this.disposePgsRenderer();
            return success;
        } catch (error) {
            console.error('[SubtitleRenderer] Failed to init PGS renderer:', error);
            this.disposePgsRenderer();
            return false;
        }
    }

    private releaseKnownRenderer(renderer: PgsRendererType | VobSubRendererType | null): void {
        for (const reference of this.knownLibbitsubRenderers) {
            const current = reference.deref();
            if (!current || current === renderer) this.knownLibbitsubRenderers.delete(reference);
        }
    }

    private disposePgsRenderer(): void {
        this.cancelBitmapReady?.();
        if (this.pgsRenderer) {
            this.log('Disposing PGS renderer');
            try {
                this.pgsRenderer.dispose();
            } catch (e) {
                console.warn('[SubtitleRenderer] Error disposing PGS renderer:', e);
            }
            // Only genuinely pending SDK initialization can still create a canvas.
            if (!this.bitmapLifecycle.get(this.pgsRenderer)?.pending)
                this.releaseKnownRenderer(this.pgsRenderer);
            this.pgsRenderer = null;
        }
    }

    // ========================================================================
    // Private: VobSub Renderer
    // ========================================================================

    private async initVobsubRenderer(
        subtitleIndex: number,
        stream: SubtitleStreamInfo,
    ): Promise<boolean> {
        this.disposePgsRenderer();
        this.disposeVobsubRenderer();
        this.sweepOrphanLibbitsubCanvases();
        const generation = ++this.initGeneration;

        if (!this.context || !this.videoElement) return false;

        if (!(await this.ensureBitsubWasm())) {
            console.error('[SubtitleRenderer] Cannot init VobSub renderer - WASM not available');
            return false;
        }
        if (generation !== this.initGeneration) {
            this.log('initVobsubRenderer: aborted after WASM init (stale generation)');
            return false;
        }

        const vobsubUrl = stream.hrefs?.raw;
        if (!vobsubUrl) return false;
        this.log('Initializing VobSub renderer:', {
            index: subtitleIndex,
            codec: stream.codec,
            displayTitle: stream.displayTitle,
            url: vobsubUrl,
        });

        try {
            // Pre-fetch with credentials — libbitsub's internal fetch() doesn't
            // include auth headers, causing 401 with forward-auth proxies.
            const subContent = await this.fetchSubtitleData(vobsubUrl);
            if (!subContent) return false;
            if (generation !== this.initGeneration) {
                this.log('initVobsubRenderer: aborted after fetch (stale generation)');
                return false;
            }

            const readiness = this.bitmapReadiness(generation);
            let loaded = false;
            const lifecycle = { pending: true };
            let newVobsub: VobSubRendererType | null = null;
            newVobsub = new this.libbitsub!.VobSubRenderer({
                video: this.videoElement,
                frameAwareSync: this.config.useFrameAwareSync(),
                subContent,
                onLoading: () => {
                    this.log('VobSub subtitle loading...');
                    this.tagRendererCanvas(newVobsub, 'vobsub');
                },
                onLoaded: () => {
                    lifecycle.pending = false;
                    if (generation !== this.initGeneration) {
                        this.releaseKnownRenderer(newVobsub);
                        return;
                    }
                    loaded = true;
                    this.log('VobSub subtitle loaded');
                    this.tagRendererCanvas(newVobsub, 'vobsub');
                    readiness.finish(true);
                },
                onError: (error: Error) => {
                    lifecycle.pending = false;
                    if (generation !== this.initGeneration) this.releaseKnownRenderer(newVobsub);
                    console.error('[SubtitleRenderer] VobSub error:', error);
                    readiness.finish(false);
                    if (
                        loaded &&
                        generation === this.initGeneration &&
                        this.vobsubRenderer === newVobsub
                    ) {
                        this.disposeVobsubRenderer();
                        this.config.onRendererError(subtitleIndex);
                    }
                },
            });
            this.vobsubRenderer = newVobsub;
            this.knownLibbitsubRenderers.add(new WeakRef(newVobsub));
            this.bitmapLifecycle.set(newVobsub, lifecycle);

            const success = await readiness.ready;
            if (!success && generation === this.initGeneration) this.disposeVobsubRenderer();
            return success;
        } catch (error) {
            console.error('[SubtitleRenderer] Failed to init VobSub renderer:', error);
            this.disposeVobsubRenderer();
            return false;
        }
    }

    private disposeVobsubRenderer(): void {
        this.cancelBitmapReady?.();
        if (this.vobsubRenderer) {
            try {
                this.vobsubRenderer.dispose();
            } catch (e) {
                console.warn('[SubtitleRenderer] Error disposing VobSub renderer:', e);
            }
            if (!this.bitmapLifecycle.get(this.vobsubRenderer)?.pending)
                this.releaseKnownRenderer(this.vobsubRenderer);
            this.vobsubRenderer = null;
        }
    }

    // ========================================================================
    // Private: Authenticated subtitle fetch
    // ========================================================================

    /**
     * Fetches subtitle data with credentials included.
     * libbitsub's internal fetch() doesn't send auth headers/cookies,
     * so we pre-fetch and pass the data as an ArrayBuffer.
     */
    private async fetchSubtitleData(url: string): Promise<ArrayBuffer | null> {
        this.subtitleFetchController?.abort();
        const controller = new AbortController();
        this.subtitleFetchController = controller;
        try {
            const response = await fetch(url, {
                credentials: 'include',
                signal: controller.signal,
            });
            if (!response.ok) {
                console.error(
                    `[SubtitleRenderer] Failed to fetch subtitle data: ${response.status} ${response.statusText}`,
                );
                return null;
            }
            return await response.arrayBuffer();
        } catch (error) {
            console.error('[SubtitleRenderer] Failed to fetch subtitle data:', error);
            return null;
        } finally {
            if (this.subtitleFetchController === controller) this.subtitleFetchController = null;
        }
    }

    // ========================================================================
    // Private: ASS/SSA Renderer (AkariSub)
    // ========================================================================

    private async initAssRenderer(
        subtitleIndex: number,
        stream: SubtitleStreamInfo,
    ): Promise<boolean> {
        this.disposeAssRenderer();
        const generation = ++this.initGeneration;

        if (!this.context || !this.videoElement) return false;

        // Dynamically load the AkariSub module
        if (!(await this.ensureAkariSub())) {
            console.error(
                '[SubtitleRenderer] Cannot init ASS renderer - AkariSub module not available',
            );
            return false;
        }
        if (generation !== this.initGeneration) {
            this.log('initAssRenderer: aborted after AkariSub load (stale generation)');
            return false;
        }

        // AkariSub needs video dimensions to render correctly
        // Wait for video to have metadata loaded (Safari native HLS may delay this)
        const videoEl = this.videoElement;
        if (videoEl.readyState < 1 || videoEl.videoWidth === 0) {
            this.log('Waiting for video metadata before initializing AkariSub...');
            const metadataReady = await new Promise<boolean>((resolve) => {
                const finish = (ready: boolean): void => {
                    clearTimeout(timer);
                    videoEl.removeEventListener('loadedmetadata', checkReady);
                    videoEl.removeEventListener('loadeddata', checkReady);
                    if (this.cancelAssInitialization === cancel)
                        this.cancelAssInitialization = null;
                    resolve(ready);
                };
                const checkReady = (): void => {
                    if (videoEl.readyState >= 1 && videoEl.videoWidth > 0) finish(true);
                };
                const cancel = (): void => finish(false);
                const timer = setTimeout(cancel, 5000);
                this.cancelAssInitialization = cancel;
                videoEl.addEventListener('loadedmetadata', checkReady);
                videoEl.addEventListener('loadeddata', checkReady);
                checkReady();
            });
            if (!metadataReady) return false;
            if (generation !== this.initGeneration) {
                this.log('initAssRenderer: aborted after metadata wait (stale generation)');
                return false;
            }
        }

        const assUrl = stream.hrefs?.raw;
        if (!assUrl) return false;
        this.log('Initializing AkariSub renderer:', {
            index: subtitleIndex,
            codec: stream.codec,
            displayTitle: stream.displayTitle,
            url: assUrl,
        });

        try {
            // Validate video element before creating renderer
            if (!this.videoElement || !this.videoElement.parentElement) {
                throw new Error('Video element not ready or not in DOM');
            }

            // Wait for next animation frame to ensure DOM is fully settled
            // This prevents the AkariSub worker from trying to attach to undefined elements
            await new Promise<void>((resolve) => {
                let frame: number | undefined;
                const finish = (): void => {
                    if (frame !== undefined) cancelAnimationFrame(frame);
                    if (this.cancelAssInitialization === finish)
                        this.cancelAssInitialization = null;
                    resolve();
                };
                this.cancelAssInitialization = finish;
                frame = requestAnimationFrame(finish);
            });
            if (generation !== this.initGeneration) {
                this.log('initAssRenderer: aborted after rAF (stale generation)');
                return false;
            }

            // Pre-fetch with credentials — AkariSub's worker fetch() doesn't
            // include auth headers, causing 401 with forward-auth proxies.
            // Use a Blob URL so the worker can re-read from it.
            const assData = await this.fetchSubtitleData(assUrl);
            if (!assData) {
                throw new Error('Failed to fetch ASS subtitle data');
            }
            if (generation !== this.initGeneration) {
                this.log('initAssRenderer: aborted after fetch (stale generation)');
                return false;
            }
            const assBlobUrl = URL.createObjectURL(new Blob([assData], { type: 'text/plain' }));
            this.assBlobUrl = assBlobUrl;

            // Let AkariSub create and attach its own canvas — it only auto-attaches
            // if we don't provide one. akarisub 1.x resolves its worker, WASM and
            // glue relative to its own module URL, which Vite emits and hashes, so
            // workerUrl/wasmUrl are no longer passed — the 0.2 line had no exports
            // entry for the WASM and needed both handed in on the main thread.
            // Renderer selection (WebGPU → WebGL2 → Canvas2D) is left on AkariSub's
            // automatic default; onCanvasFallback logs when it drops to Canvas2D.
            this.assRenderer = new this.akariSubClass!({
                video: this.videoElement,
                subUrl: assBlobUrl,
                availableFonts: {
                    'liberation sans': this.resolveFallbackFontUrl(),
                },
                fallbackFonts: ['liberation sans'],
                prescaleFactor: 1.0,
                prescaleHeightLimit: 1080,
                onDemandRender: false,
                debug: this.config.debug,
                onCanvasFallback: () => {
                    console.warn(
                        '[SubtitleRenderer] AkariSub fell back to Canvas2D (WebGPU/WebGL2 unavailable)',
                    );
                },
            });

            const renderer = this.assRenderer;
            const success = await this.waitForAkariSubReady(renderer, generation, subtitleIndex);
            if (!success) {
                if (generation === this.initGeneration && this.assRenderer === renderer)
                    this.disposeAssRenderer();
                return false;
            }
            renderer.resize();
            const resumeTime = videoEl.currentTime;
            if (resumeTime > 0.1) videoEl.currentTime = resumeTime;
            return true;
        } catch (error) {
            console.error('[SubtitleRenderer] Failed to init AkariSub renderer:', error);
            this.disposeAssRenderer();
            return false;
        }
    }

    private disposeAssRenderer(): void {
        this.cancelAssInitialization?.();
        this.cancelAssInitialization = null;
        this.cleanupAssError?.();
        this.cleanupAssError = null;
        if (this.assRenderer) {
            try {
                this.assRenderer.destroy();
            } catch (e) {
                console.warn('[SubtitleRenderer] Error disposing AkariSub renderer:', e);
            }
            this.assRenderer = null;
        }
        if (this.assBlobUrl) {
            URL.revokeObjectURL(this.assBlobUrl);
            this.assBlobUrl = null;
        }
    }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new SubtitleRendererManager instance
 */
export function createSubtitleRendererManager(
    config?: SubtitleRendererConfig,
    log?: LogFunction,
): SubtitleRendererManager {
    return new SubtitleRendererManager(config, log);
}
