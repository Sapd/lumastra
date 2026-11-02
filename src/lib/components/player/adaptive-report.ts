// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { SessionAdaptiveReport } from '$lib/schemas/session-adaptive.js';
import { currentAdaptiveVariant, type LiveTvAdaptiveLadder } from './livetv-quality.js';

export interface AdaptiveReportInput {
    /** The synchronized Live TV ladder the server granted, or null. */
    liveLadder: LiveTvAdaptiveLadder | null;
    /** "1280x720" from the decoder, or null. */
    decodedResolution: string | null;
    /** hls.js levels, or null on native HLS. */
    hlsLevels: ReadonlyArray<{ height: number; bitrate: number }> | null;
    /** hls.js `currentLevel` (-1 while unknown), or null. */
    hlsCurrentLevel: number | null;
    /** hls.js `bandwidthEstimate` in bits per second, or null. */
    bandwidthEstimate: number | null;
    switches: number;
    rebuffers: number;
}

// The ranges SessionAdaptiveReportSchema accepts; anything outside is dropped here
// rather than sent (the server would discard the whole block).
const MAX_HEIGHT = 4320;
const MAX_BITRATE = 1_000_000_000;
const MAX_BANDWIDTH = 100_000_000_000;

function positiveInt(value: number | null | undefined, max = MAX_BITRATE): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    const rounded = Math.round(value);
    return rounded <= max ? rounded : undefined;
}

/**
 * The `adaptive` block of a play-session heartbeat, or undefined when playback is not
 * adaptive. Live TV names variants by rung id (the server's own names); adaptive VOD
 * by height, from the hls.js levels.
 */
export function buildAdaptiveReport(input: AdaptiveReportInput): SessionAdaptiveReport | undefined {
    const height = positiveInt(Number(input.decodedResolution?.split('x')[1]), MAX_HEIGHT);
    const common = {
        ...(positiveInt(input.bandwidthEstimate, MAX_BANDWIDTH)
            ? { measured_bandwidth: positiveInt(input.bandwidthEstimate, MAX_BANDWIDTH) }
            : {}),
        switches: Math.max(0, Math.round(input.switches)),
        rebuffers: Math.max(0, Math.round(input.rebuffers)),
    };

    if (input.liveLadder) {
        const current = currentAdaptiveVariant(input.liveLadder, input.decodedResolution ?? null);
        const variantId =
            current?.kind === 'original'
                ? 'original'
                : current?.kind === 'rung'
                  ? current.id
                  : undefined;
        const rung = input.liveLadder.rungs.find((r) => r.id === variantId);
        return {
            ...(variantId ? { variant_id: variantId } : {}),
            ...(height ? { height } : {}),
            ...(rung ? { indicated_bitrate: rung.maxBitrateBps } : {}),
            ladder: [
                ...(input.liveLadder.includesOriginal ? [{ id: 'original' }] : []),
                ...input.liveLadder.rungs.map((r) => ({
                    id: r.id,
                    height: r.height,
                    bitrate: r.maxBitrateBps,
                })),
            ],
            ...common,
        };
    }

    const levels = input.hlsLevels ?? [];
    if (levels.length < 2) return undefined;
    const ladder = levels
        .map((level) => ({
            height: positiveInt(level.height, MAX_HEIGHT),
            bitrate: positiveInt(level.bitrate),
        }))
        .filter((level) => level.height !== undefined || level.bitrate !== undefined)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
        .slice(0, 16);
    const playing =
        input.hlsCurrentLevel !== null && input.hlsCurrentLevel >= 0
            ? levels[input.hlsCurrentLevel]
            : undefined;
    const playingHeight = positiveInt(playing?.height, MAX_HEIGHT) ?? height;
    const playingBitrate = positiveInt(playing?.bitrate);
    return {
        ...(playingHeight ? { height: playingHeight } : {}),
        ...(playingBitrate ? { indicated_bitrate: playingBitrate } : {}),
        ladder,
        ...common,
    };
}
