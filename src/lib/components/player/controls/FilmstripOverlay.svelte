<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { TrickplayManifestResponse } from '$lib/schemas/playback-trickplay';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        // Props
        filmstripActiveTime: number;
        filmstripPrecision: number;
        trickplayInfo: TrickplayManifestResponse;
        duration: number;
        filmstripThumbnails: FilmstripThumbnail[];
        getSpriteSheetUrl: (index: number) => string;
        getSegmentAtTime: (time: number) => { type: string; label: string } | null;
    }

    let {
        filmstripActiveTime,
        filmstripPrecision,
        trickplayInfo,
        duration,
        filmstripThumbnails,
        getSpriteSheetUrl,
        getSegmentAtTime,
    }: Props = $props();

    interface FilmstripThumbnail {
        time: number;
        spriteIndex: number;
        tilePos: { x: number; y: number };
        isLoaded: boolean;
        isLoading: boolean;
        isFailed: boolean;
        isCenter: boolean;
    }

    const MAX_PRECISION = 8;

    function safePercent(time: number, dur: number): number {
        if (!dur || dur <= 0) return 0;
        return Math.max(0, Math.min(100, (time / dur) * 100));
    }

    function formatHoverTime(seconds: number): string {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hrs > 0) {
            return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    let centerIdx = $derived(filmstripThumbnails.findIndex((t) => t.isCenter));
    let precisionPercent = $derived(
        Math.round(((filmstripPrecision - 1) / (MAX_PRECISION - 1)) * 100),
    );
    let filmstripPercent = $derived(safePercent(filmstripActiveTime, duration));
</script>

<div class="filmstrip-overlay">
    <div class="filmstrip-container">
        <!-- Precision indicator -->
        <div class="filmstrip-header">
            <div class="filmstrip-precision" class:active={filmstripPrecision > 1.5}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                    <path
                        d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" />
                </svg>
                <span class="precision-label">{m.player_precision()}</span>
                <div class="precision-bar">
                    <div class="precision-fill" style="width: {precisionPercent}%"></div>
                </div>
                <span class="precision-value">{filmstripPrecision.toFixed(1)}x</span>
            </div>
            <div class="filmstrip-hint">
                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                    <path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z" />
                </svg>
                {m.player_precision_hint()}
            </div>
        </div>

        <!-- Thumbnails - flat layout without 3D -->
        <div class="filmstrip-thumbnails">
            {#each filmstripThumbnails as thumb, i (thumb.time)}
                {@const distanceFromCenter = centerIdx >= 0 ? Math.abs(i - centerIdx) : 0}
                {@const spriteUrl = getSpriteSheetUrl(thumb.spriteIndex)}
                <!-- Final sheets can have fewer rows; preserve their intrinsic aspect ratio. -->
                {@const spriteWidth = trickplayInfo.width * trickplayInfo.tileColumns}
                {@const scale = thumb.isCenter ? 1.1 : 0.85}
                {@const opacity = thumb.isCenter ? 1 : Math.max(0.5, 1 - distanceFromCenter * 0.1)}
                {@const showImage = thumb.isLoaded || (!thumb.isLoading && !thumb.isFailed)}
                <div
                    class="filmstrip-thumb"
                    class:active={thumb.isCenter}
                    class:loading={thumb.isLoading}
                    class:failed={thumb.isFailed}
                    style="
                        --thumb-scale: {scale};
                        --thumb-opacity: {opacity};
                        width: {trickplayInfo.width}px;
                        height: {trickplayInfo.height}px;
                    ">
                    {#if showImage}
                        <div
                            class="filmstrip-thumb-inner"
                            style="
                                width: {trickplayInfo.width}px;
                                height: {trickplayInfo.height}px;
                                background-image: url({spriteUrl});
                                background-size: {spriteWidth}px auto;
                                background-position: -{thumb.tilePos.x}px -{thumb.tilePos.y}px;
                            ">
                        </div>
                    {:else if thumb.isLoading}
                        <div class="filmstrip-thumb-loading">
                            <div class="loading-spinner"></div>
                        </div>
                    {:else if thumb.isFailed}
                        <div class="filmstrip-thumb-failed">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                                <path
                                    d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                            </svg>
                        </div>
                    {/if}
                    {#if thumb.isCenter}
                        <div class="filmstrip-thumb-glow"></div>
                    {/if}
                </div>
                {#if thumb.isCenter}
                    {@const thumbSegment = getSegmentAtTime(thumb.time)}
                    <div class="filmstrip-center-time">
                        {#if thumbSegment}
                            <span
                                class="segment-badge"
                                data-segment={thumbSegment.type.toLowerCase()}
                                >{thumbSegment.label}</span>
                        {/if}
                        <span class="time-value">{formatHoverTime(thumb.time)}</span>
                    </div>
                {/if}
            {/each}
        </div>

        <!-- Progress indicator line -->
        <div class="filmstrip-progress-line">
            <div class="progress-line-fill" style="width: {filmstripPercent}%"></div>
            <div class="progress-line-marker" style="left: {filmstripPercent}%"></div>
        </div>
    </div>
</div>

<style>
    .filmstrip-overlay {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 140px;
        display: flex;
        justify-content: center;
        align-items: center;
        pointer-events: none;
        z-index: 100;
        animation: filmstripSlideUp 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes filmstripSlideUp {
        from {
            opacity: 0;
            transform: translateY(30px) scale(0.95);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }

    .filmstrip-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        background: linear-gradient(135deg, rgba(20, 20, 30, 0.95) 0%, rgba(10, 10, 20, 0.98) 100%);
        backdrop-filter: blur(30px) saturate(1.5);
        -webkit-backdrop-filter: blur(30px) saturate(1.5);
        border-radius: 20px;
        padding: 20px 28px 24px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow:
            0 25px 60px rgba(0, 0, 0, 0.5),
            0 10px 25px rgba(0, 0, 0, 0.3),
            inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }

    .filmstrip-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        gap: 24px;
    }

    .filmstrip-precision {
        display: flex;
        align-items: center;
        gap: 8px;
        color: rgba(255, 255, 255, 0.5);
        font-size: 11px;
        transition: color 0.2s;
    }

    .filmstrip-precision.active {
        color: rgba(229, 9, 20, 0.9);
    }

    .filmstrip-precision svg {
        opacity: 0.7;
    }

    .filmstrip-precision.active svg {
        opacity: 1;
        filter: drop-shadow(0 0 4px rgba(229, 9, 20, 0.5));
    }

    .precision-label {
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .precision-bar {
        width: 60px;
        height: 4px;
        background: rgba(255, 255, 255, 0.15);
        border-radius: 2px;
        overflow: hidden;
    }

    .precision-fill {
        height: 100%;
        background: linear-gradient(90deg, #e50914, #ff6b6b);
        border-radius: 2px;
        transition: width 0.1s ease-out;
        box-shadow: 0 0 8px rgba(229, 9, 20, 0.5);
    }

    .precision-value {
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        min-width: 32px;
        text-align: right;
    }

    .filmstrip-hint {
        display: flex;
        align-items: center;
        gap: 4px;
        color: rgba(255, 255, 255, 0.4);
        font-size: 10px;
        font-weight: 500;
    }

    .filmstrip-thumbnails {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        padding: 10px 0 30px;
    }

    .filmstrip-thumb {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        overflow: visible;
        opacity: var(--thumb-opacity);
        transform: scale(var(--thumb-scale));
        transition: all 0.1s ease-out;
    }

    .filmstrip-thumb.active {
        z-index: 10;
    }

    .filmstrip-thumb-inner {
        background-repeat: no-repeat;
        border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }

    .filmstrip-thumb.active .filmstrip-thumb-inner {
        border: 2px solid #e50914;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .filmstrip-thumb-loading,
    .filmstrip-thumb-failed {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.3);
    }

    .loading-spinner {
        width: 24px;
        height: 24px;
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .filmstrip-thumb-failed svg {
        color: rgba(255, 255, 255, 0.5);
    }

    .filmstrip-thumb-glow {
        position: absolute;
        inset: -2px;
        background: rgba(229, 9, 20, 0.2);
        border-radius: 8px;
        z-index: -1;
    }

    .filmstrip-center-time {
        position: absolute;
        bottom: -28px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 20;
    }

    .filmstrip-center-time .time-value {
        display: block;
        background: linear-gradient(135deg, #e50914 0%, #b20710 100%);
        color: white;
        font-size: 14px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        padding: 6px 14px;
        border-radius: 8px;
        white-space: nowrap;
        box-shadow:
            0 4px 12px rgba(229, 9, 20, 0.4),
            0 2px 4px rgba(0, 0, 0, 0.3);
        letter-spacing: 0.02em;
    }

    .filmstrip-center-time .segment-badge {
        display: block;
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
        white-space: nowrap;
    }

    .filmstrip-center-time .segment-badge[data-segment='intro'] {
        background: rgba(0, 255, 255, 0.9);
        color: #000;
    }

    .filmstrip-center-time .segment-badge[data-segment='outro'] {
        background: rgba(255, 140, 0, 0.95);
        color: #000;
    }

    .filmstrip-center-time .segment-badge[data-segment='recap'] {
        background: rgba(138, 43, 226, 0.95);
        color: white;
    }

    .filmstrip-center-time .segment-badge[data-segment='preview'] {
        background: rgba(50, 205, 50, 0.95);
        color: #000;
    }

    .filmstrip-progress-line {
        width: 100%;
        height: 3px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 2px;
        position: relative;
        overflow: visible;
        margin-top: 8px;
    }

    .progress-line-fill {
        position: absolute;
        left: 0;
        top: 0;
        height: 100%;
        background: linear-gradient(90deg, rgba(229, 9, 20, 0.6), rgba(229, 9, 20, 0.9));
        border-radius: 2px;
        transition: width 0.05s ease-out;
    }

    .progress-line-marker {
        position: absolute;
        top: 50%;
        width: 10px;
        height: 10px;
        background: #e50914;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        box-shadow:
            0 0 10px rgba(229, 9, 20, 0.6),
            0 0 20px rgba(229, 9, 20, 0.3);
        transition: left 0.05s ease-out;
    }

    @media (max-width: 768px) {
        .filmstrip-overlay {
            bottom: 100px;
        }

        .filmstrip-container {
            padding: 14px 18px 20px;
            border-radius: 16px;
        }

        .filmstrip-header {
            gap: 16px;
        }

        .precision-bar {
            width: 40px;
        }

        .filmstrip-thumbnails {
            gap: 2px;
            padding: 8px 0 24px;
        }
    }

    /* Mobile portrait filmstrip adjustments */
    @media (max-width: 640px) and (orientation: portrait) {
        .filmstrip-overlay {
            bottom: 120px;
        }

        .filmstrip-container {
            padding: 14px 16px 20px;
            border-radius: 16px;
            max-width: 95vw;
        }

        .filmstrip-header {
            flex-direction: column;
            gap: 8px;
        }

        .filmstrip-precision {
            font-size: 10px;
        }

        .precision-bar {
            width: 50px;
        }

        .filmstrip-thumbnails {
            gap: 2px;
            overflow-x: auto;
            max-width: 95vw;
            -webkit-overflow-scrolling: touch;
            padding: 8px 0 28px;
        }

        .filmstrip-thumb {
            flex-shrink: 0;
        }

        .filmstrip-center-time .time-value {
            font-size: 12px;
            padding: 5px 12px;
        }

        .filmstrip-progress-line {
            height: 2px;
        }

        .progress-line-marker {
            width: 8px;
            height: 8px;
        }
    }
</style>
