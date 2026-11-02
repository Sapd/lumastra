<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { previewFrame } from './preview-frame.js';
    import { TrickplayManifestResponseSchema } from '$lib/schemas/playback-trickplay';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';

    interface Props {
        mediaId: string;
        width?: number;
        fileId?: string | null;
        /** Jump to the frame at this file offset (e.g. an episode boundary). */
        seekMs?: number | null;
        seekDirection?: 'nearest' | 'before';
    }

    let {
        mediaId,
        width = 320,
        fileId = null,
        seekMs = null,
        seekDirection = 'nearest',
    }: Props = $props();
    let totalTiles = $state(0);
    let tileWidth = $state(0);
    let tileHeight = $state(0);
    let thumbWidth = $state(0);
    let thumbHeight = $state(0);
    let interval = $state(0);
    let thumbnailCount = $state(0);
    let currentFrame = $state(0);
    let loading = $state(true);
    let failed = $state(false);
    let fallbackSheet = $state(0);

    // Sprite sheet URLs keyed by sheet index
    let sheetUrls = new SvelteMap<number, string>();
    let loadingSheets = new SvelteSet<number>();

    // Track all blob URLs for cleanup
    let blobUrls: string[] = [];
    let sheetHrefs: Record<number, string> = {};
    let generation = 0;

    const tilesPerSheet = $derived(tileWidth * tileHeight);
    const totalFrames = $derived(thumbnailCount || totalTiles * tilesPerSheet);
    const currentSheet = $derived(tilesPerSheet > 0 ? Math.floor(currentFrame / tilesPerSheet) : 0);
    const frameInSheet = $derived(tilesPerSheet > 0 ? currentFrame % tilesPerSheet : 0);
    const col = $derived(tileWidth > 0 ? frameInSheet % tileWidth : 0);
    const row = $derived(tileWidth > 0 ? Math.floor(frameInSheet / tileWidth) : 0);

    const spriteWidth = $derived(thumbWidth * tileWidth);
    const spriteHeight = $derived(thumbHeight * tileHeight);
    const bgPosX = $derived(col * thumbWidth);
    const bgPosY = $derived(row * thumbHeight);

    const hasGrid = $derived(tileWidth > 0 && tileHeight > 0 && thumbWidth > 0);
    const currentSheetUrl = $derived(sheetUrls.get(hasGrid ? currentSheet : fallbackSheet) ?? null);

    // Display width: scale up for visibility (max 480px)
    const displayWidth = $derived(Math.min(thumbWidth * 2, 480));
    const displayHeight = $derived(thumbWidth > 0 ? displayWidth * (thumbHeight / thumbWidth) : 0);

    function formatTime(frameIndex: number): string {
        if (interval <= 0) return '';
        const totalMs = frameIndex * interval;
        const totalSec = Math.floor(totalMs / 1000);
        const hrs = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        if (hrs > 0) {
            return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function cleanup(): void {
        for (const url of blobUrls) {
            URL.revokeObjectURL(url);
        }
        generation++;
        sheetHrefs = {};
        blobUrls = [];
        sheetUrls.clear();
        loadingSheets.clear();
    }

    $effect(() => {
        // Read reactive props synchronously so Svelte tracks them as dependencies
        const id = mediaId;
        const w = width;
        const fid = fileId;
        loadManifest(id, w, fid);
        return cleanup;
    });

    async function loadManifest(id: string, w: number, fid?: string | null): Promise<void> {
        loading = true;
        failed = false;
        cleanup();
        const requestGeneration = generation;

        try {
            const fileParam = fid ? `?fileId=${encodeURIComponent(fid)}` : '';
            const res = await fetch(
                `/api/playback/${encodeURIComponent(id)}/trickplay/${w}/manifest${fileParam}`,
            );
            if (generation !== requestGeneration) return;
            if (!res.ok) {
                failed = true;
                return;
            }

            const manifest = TrickplayManifestResponseSchema.parse(await res.json());
            if (generation !== requestGeneration) return;
            totalTiles = manifest.sheets.length;
            tileWidth = manifest.tileColumns;
            tileHeight = manifest.tileRows;
            thumbWidth = manifest.width;
            thumbHeight = manifest.height;
            interval = manifest.intervalMs;
            thumbnailCount = manifest.thumbnailCount;
            sheetHrefs = Object.fromEntries(
                manifest.sheets.map((sheet) => [sheet.index, sheet.href]),
            );
            currentFrame = 0;
            await ensureSheet(0);
        } catch (e) {
            if (generation === requestGeneration) {
                console.warn('[EpisodeTrickplayPreview] Failed to load trickplay sheet', e);
                failed = true;
            }
        } finally {
            if (generation === requestGeneration) loading = false;
        }
    }

    async function ensureSheet(index: number): Promise<void> {
        if (sheetUrls.has(index) || loadingSheets.has(index)) return;
        loadingSheets.add(index);
        const requestGeneration = generation;

        try {
            const href = sheetHrefs[index];
            if (!href) return;
            const res = await fetch(href);
            if (!res.ok) return;
            const blob = await res.blob();
            if (generation !== requestGeneration) return;
            const url = URL.createObjectURL(blob);
            blobUrls.push(url);
            sheetUrls.set(index, url);
        } catch {
            /* expected: network error or blob creation failure for background sheet load */
        } finally {
            if (generation === requestGeneration) loadingSheets.delete(index);
        }
    }

    $effect(() => {
        const at = seekMs;
        const step = interval;
        const frames = totalFrames;
        if (at === null || step <= 0 || frames <= 0) return;
        const frame = previewFrame(at, step, frames, seekDirection);
        currentFrame = frame;
        void ensureSheet(tilesPerSheet > 0 ? Math.floor(frame / tilesPerSheet) : 0);
    });

    function handleSlider(e: Event): void {
        const target = e.target as HTMLInputElement;
        const newFrame = parseInt(target.value, 10);
        currentFrame = newFrame;
        const neededSheet = tilesPerSheet > 0 ? Math.floor(newFrame / tilesPerSheet) : 0;
        ensureSheet(neededSheet);
    }
</script>

{#if loading}
    <div class="h-12 flex items-center text-xs text-surface-500">{m.media_plain_loading()}</div>
{:else if failed || totalTiles === 0}
    <div class="text-xs text-surface-600">{m.media_plain_no_preview()}</div>
{:else if !hasGrid}
    <!-- Fallback: show full sprite sheet if no grid metadata -->
    <div class="space-y-1">
        <span class="text-surface-500 text-xs">{m.media_plain_preview_sheet()}:</span>
        <div
            class="rounded overflow-hidden bg-black/50 max-w-full"
            style="width: 100%; max-width: 640px; aspect-ratio: 16/9;">
            {#if currentSheetUrl}
                <img
                    src={currentSheetUrl}
                    alt="Episode preview"
                    class="w-full h-full object-contain" />
            {/if}
        </div>
        {#if totalTiles > 1}
            <input
                type="range"
                min="0"
                max={totalTiles - 1}
                value={fallbackSheet}
                oninput={(e) => {
                    const idx = parseInt((e.target as HTMLInputElement).value, 10);
                    ensureSheet(idx);
                    fallbackSheet = idx;
                }}
                class="w-full max-w-[640px] accent-primary-500 h-1" />
        {/if}
    </div>
{:else}
    <div class="space-y-2">
        <div class="flex items-center gap-3">
            <span class="text-surface-500 text-xs">Preview:</span>
            {#if interval > 0}
                <span class="text-xs font-mono text-surface-400">
                    {formatTime(currentFrame)}
                </span>
            {/if}
            <span class="text-xs text-surface-600">
                Frame {currentFrame + 1}/{totalFrames}
            </span>
        </div>
        <div
            class="rounded overflow-hidden bg-black/50 max-w-full"
            style="width: {displayWidth}px; height: {displayHeight}px;">
            {#if currentSheetUrl}
                <div
                    style="
                        width: {displayWidth}px;
                        height: {displayHeight}px;
                        background-image: url({currentSheetUrl});
                        background-size: {(spriteWidth / thumbWidth) *
                        displayWidth}px {(spriteHeight / thumbHeight) * displayHeight}px;
                        background-position: -{(bgPosX / thumbWidth) * displayWidth}px -{(bgPosY /
                        thumbHeight) *
                        displayHeight}px;
                        background-repeat: no-repeat;
                    ">
                </div>
            {:else}
                <div
                    class="w-full h-full flex items-center justify-center text-xs text-surface-500">
                    {m.media_plain_loading()}
                </div>
            {/if}
        </div>
        {#if totalFrames > 1}
            <input
                type="range"
                min="0"
                max={totalFrames - 1}
                value={currentFrame}
                oninput={handleSlider}
                class="accent-primary-500 h-1 max-w-full"
                style="width: {displayWidth}px;" />
        {/if}
    </div>
{/if}
