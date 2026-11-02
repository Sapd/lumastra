<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { TimelineChapter } from '$lib/types/playback';
    import type { TrickplayManifestResponse } from '$lib/schemas/playback-trickplay';
    import { getAvatarUrl } from '$lib/utils/image-utils';

    function handleAvatarError(event: Event): void {
        const img = event.target as HTMLImageElement;
        if (img) img.style.display = 'none';
    }

    interface Props {
        // Props
        hoverTime: number;
        trickplayImage: string | null;
        trickplayInfo: TrickplayManifestResponse | null;
        tilePos: { x: number; y: number };
        hoverSegment?: { type: string; label: string } | null;
        hoverChapter?: TimelineChapter | null;
        previewPos: { left: string; transform: string };
        pin?: { username: string; content: string } | null;
    }

    let {
        hoverTime,
        trickplayImage,
        trickplayInfo,
        tilePos,
        hoverSegment = null,
        hoverChapter = null,
        previewPos,
        pin = null,
    }: Props = $props();

    /**
     * Format time as HH:MM:SS or MM:SS
     */
    function formatHoverTime(seconds: number): string {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hrs > 0) {
            return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
</script>

<div class="progress-preview" style="left: {previewPos.left}; transform: {previewPos.transform};">
    <div class="preview-card" class:has-thumbnail={trickplayImage && trickplayInfo}>
        <!-- Trickplay thumbnail -->
        {#if trickplayImage && trickplayInfo}
            <!-- Final sheets can have fewer rows; preserve their intrinsic aspect ratio. -->
            {@const spriteWidth = trickplayInfo.width * trickplayInfo.tileColumns}
            <div
                class="trickplay-thumbnail"
                style="
                    width: {trickplayInfo.width}px;
                    height: {trickplayInfo.height}px;
                    background-image: url({trickplayImage});
                    background-size: {spriteWidth}px auto;
                    background-position: -{tilePos.x}px -{tilePos.y}px;
                ">
            </div>
        {/if}

        <!-- Segment badge (intro, credits, etc.) - shown on thumbnail -->
        {#if hoverSegment}
            <div class="preview-segment-badge" data-segment={hoverSegment.type.toLowerCase()}>
                {hoverSegment.label}
            </div>
        {/if}

        <!-- Info section -->
        <div class="preview-info">
            <!-- Time -->
            <div class="preview-time">
                {formatHoverTime(hoverTime)}
            </div>

            <!-- Chapter + pin on one row -->
            {#if (hoverChapter && hoverChapter.name) || pin}
                <div class="preview-meta-row">
                    {#if hoverChapter && hoverChapter.name}
                        <span class="preview-chapter">{hoverChapter.name}</span>
                    {/if}
                    {#if hoverChapter && hoverChapter.name && pin}
                        <span class="preview-meta-divider"></span>
                    {/if}
                    {#if pin}
                        <div class="preview-pin-inline">
                            <div class="preview-pin-avatar">
                                <span class="preview-pin-initial">
                                    {pin.username.slice(0, 1).toUpperCase()}
                                </span>
                                <img
                                    src={getAvatarUrl(pin.username)}
                                    alt=""
                                    onerror={handleAvatarError} />
                            </div>
                            <span class="preview-pin-content">{pin.content}</span>
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .progress-preview {
        position: absolute;
        bottom: 115%;
        pointer-events: none;
        z-index: 100;
        transition:
            left 0.1s ease-out,
            transform 0.1s ease-out;
    }

    .preview-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(24px) saturate(1.2);
        -webkit-backdrop-filter: blur(24px) saturate(1.2);
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow:
            0 8px 32px rgba(0, 0, 0, 0.3),
            0 2px 8px rgba(0, 0, 0, 0.15);
        overflow: hidden;
        padding-bottom: 10px;
        position: relative;
    }

    .preview-card:not(.has-thumbnail) {
        padding: 10px 14px;
    }

    .trickplay-thumbnail {
        background-repeat: no-repeat;
        background-color: #1a1a1a;
    }

    .preview-segment-badge {
        position: absolute;
        top: 6px;
        right: 6px;
        padding: 3px 8px;
        border-radius: 3px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #000;
        background: rgba(0, 255, 255, 0.9);
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
    }

    .preview-segment-badge[data-segment='intro'] {
        background: rgba(0, 255, 255, 0.9);
        color: #000;
    }

    .preview-segment-badge[data-segment='outro'] {
        background: rgba(255, 140, 0, 0.95);
        color: #000;
    }

    .preview-segment-badge[data-segment='recap'] {
        background: rgba(138, 43, 226, 0.95);
        color: white;
    }

    .preview-segment-badge[data-segment='preview'] {
        background: rgba(50, 205, 50, 0.95);
        color: #000;
    }

    .preview-info {
        padding: 8px 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 80px;
    }

    .preview-card:not(.has-thumbnail) .preview-info {
        min-width: 100px;
        padding: 10px 14px;
    }

    .preview-time {
        font-size: 14px;
        font-weight: 600;
        color: white;
        font-variant-numeric: tabular-nums;
    }

    /* Chapter + pin in one row */
    .preview-meta-row {
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: 220px;
    }

    .preview-chapter {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.7);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
    }

    .preview-meta-divider {
        width: 1px;
        height: 12px;
        background: rgba(255, 255, 255, 0.25);
        flex-shrink: 0;
    }

    .preview-pin-inline {
        display: flex;
        align-items: center;
        gap: 5px;
        flex-shrink: 0;
        max-width: 130px;
        min-width: 0;
    }

    /* When there's no chapter, pin can use full width */
    .preview-meta-row:not(:has(.preview-chapter)) .preview-pin-inline {
        max-width: 220px;
        flex-shrink: 1;
    }

    .preview-pin-avatar {
        position: relative;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 1.5px solid #f59e0b;
        overflow: hidden;
        background: #374151;
        flex-shrink: 0;
    }

    .preview-pin-initial {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 6px;
        font-weight: 700;
        color: rgba(255, 255, 255, 0.8);
        line-height: 1;
    }

    .preview-pin-avatar img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .preview-pin-content {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.75);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
</style>
