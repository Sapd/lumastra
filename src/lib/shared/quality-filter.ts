// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fixed vocabulary for the /browse A-Z QUALITY filter (resolution, HDR, codec).
 *
 * Values mirror the SQL-side quality vocabulary in
 * `src/lib/server/database/queries/builders/quality.builder.ts` (see
 * `buildQualityFilter`). This module holds ONLY the selectable set, labels,
 * and the API CSV parser; it does NOT derive tiers from raw media_streams
 * rows.
 */
export const RESOLUTION_TIERS = ['4K', '1080p', '720p', 'SD'] as const;
export const HDR_TIERS = ['dolby_vision', 'hdr', 'sdr'] as const;
export const CODEC_TIERS = ['hevc', 'h264', 'av1'] as const;

export type ResolutionTier = (typeof RESOLUTION_TIERS)[number];
export type HdrTier = (typeof HDR_TIERS)[number];
export type CodecTier = (typeof CODEC_TIERS)[number];

export const RESOLUTION_LABELS: Record<ResolutionTier, string> = {
    '4K': '4K',
    '1080p': '1080p',
    '720p': '720p',
    SD: 'SD',
};

export const HDR_LABELS: Record<HdrTier, string> = {
    dolby_vision: 'Dolby Vision',
    hdr: 'HDR',
    sdr: 'SDR',
};

export const CODEC_LABELS: Record<CodecTier, string> = {
    hevc: 'HEVC',
    h264: 'H.264',
    av1: 'AV1',
};

/**
 * Parse a comma-separated tier list from a query param, keeping only the
 * allowed tokens (deduped, order-preserving). Matching is case-insensitive
 * (so 'hdr', '4k', 'dolby_vision' all resolve), but the canonical allowed
 * value is what's returned/stored (e.g. '4k' -> '4K'). Unknown tokens are
 * silently dropped.
 */
export function parseTierCsv<T extends string>(
    raw: string | undefined,
    allowed: readonly T[],
): T[] {
    if (!raw) return [];
    const lowerToCanonical = new Map<string, T>(allowed.map((a) => [a.toLowerCase(), a]));
    const out: T[] = [];
    for (const token of raw.split(',')) {
        const canonical = lowerToCanonical.get(token.trim().toLowerCase());
        if (canonical && !out.includes(canonical)) out.push(canonical);
    }
    return out;
}
