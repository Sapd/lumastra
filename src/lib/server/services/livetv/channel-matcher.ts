// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Channel Matcher — Multi-Signal Identity Scoring
 *
 * Pure function that matches new M3U channels against existing database channels
 * using a weighted scoring algorithm. No database access.
 *
 * Signals (sum to 100):
 *   tvg-id exact match:      40 points
 *   URL channel ID match:    25 points
 *   Normalized name match:   25 points
 *   Group-title match:       10 points
 *
 * Confidence tiers:
 *   >80  → auto-map silently
 *   50-80 → auto-map + flag for review
 *   <50  → treat as new channel
 *
 * @module services/livetv/channel-matcher
 */

import type { ProcessedChannel } from './auto-processor.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface ExistingChannel {
    id: string;
    name: string;
    streamUrl: string;
    epgChannelId: string | undefined;
    qualityTier: string | undefined;
    categoryId: string | undefined;
    categoryName: string | undefined;
    backupGroupId: string | undefined;
    sortOrder: number;
    isVisible: boolean;
    adminDisplayName: string | undefined;
    countryCode: string | undefined;
    consecutiveAbsences: number;
}

export interface MatchSignal {
    type: 'tvg-id' | 'url-channel-id' | 'normalized-name' | 'group-title';
    weight: number;
    oldValue: string;
    newValue: string;
    matched: boolean;
}

export type ConfidenceTier = 'auto' | 'review' | 'new';

export interface ChannelMatch {
    existingChannel: ExistingChannel;
    newChannel: ProcessedChannel;
    confidence: number;
    signals: MatchSignal[];
    tier: ConfidenceTier;
}

export interface ChannelMatchResult {
    matched: ChannelMatch[];
    newChannels: ProcessedChannel[];
    removedChannels: ExistingChannel[];
    flaggedForReview: ChannelMatch[];
    massRestructure: boolean;
    stats: {
        totalExisting: number;
        totalNew: number;
        autoMatched: number;
        reviewMatched: number;
        newCount: number;
        removedCount: number;
        urlChangedCount: number;
    };
}

// ── Signal Weights ─────────────────────────────────────────────────────

const WEIGHT_TVG_ID = 40;
const WEIGHT_URL_CHANNEL_ID = 25;
const WEIGHT_NORMALIZED_NAME = 25;
const WEIGHT_GROUP_TITLE = 10;

// ── Confidence Tier Thresholds ─────────────────────────────────────────

const AUTO_THRESHOLD = 80;
const REVIEW_THRESHOLD = 50;

// ── URL Channel ID Extraction ──────────────────────────────────────────

const URL_CHANNEL_PATTERNS = [
    /\/(\d+)\.(ts|m3u8|mpegts)$/, // /12345.ts
    /\/ch\/([^/]+)/, // /ch/NORDWELLEHD
    /[?&]id=([^&]+)/, // ?id=789
    /\/live\/[^/]+\/[^/]+\/(\d+)/, // /live/user/pass/12345
];

/**
 * Extract stable channel identifier from stream URL.
 * Returns the first matching pattern's capture group, or undefined.
 */
export function extractUrlChannelId(url: string): string | undefined {
    try {
        const urlObj = new URL(url);
        const fullPath = urlObj.pathname + urlObj.search;

        for (const pattern of URL_CHANNEL_PATTERNS) {
            const match = fullPath.match(pattern);
            if (match?.[1]) {
                return match[1];
            }
        }
    } catch {
        // Malformed URL — try raw string matching
        for (const pattern of URL_CHANNEL_PATTERNS) {
            const match = url.match(pattern);
            if (match?.[1]) {
                return match[1];
            }
        }
    }
    return undefined;
}

// ── Name Normalization ─────────────────────────────────────────────────

/**
 * Normalize channel name for comparison.
 * Lowercases, strips quality suffixes, collapses whitespace.
 */
function normalizeChannelName(name: string): string {
    return name
        .toLowerCase()
        .replace(/\b(?:full\s+hd|fullhd|1080p|2160p|720p|480p|576p|uhd|fhd|4k|hd|sd)\b/gi, '')
        .replace(/\s*\*+\s*/g, ' ')
        .replace(/[\u00B9\u00B2\u00B3\u2074-\u2079\u2070]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── EPG ID Normalization ───────────────────────────────────────────────

function normalizeEpgId(id: string): string {
    return id.toLowerCase().trim();
}

// ── Scoring ────────────────────────────────────────────────────────────

interface CandidateMatch {
    existingIdx: number;
    newIdx: number;
    confidence: number;
    signals: MatchSignal[];
}

/**
 * Per-channel values the scorer compares, computed once per channel instead of
 * once per (existing, new) pair: the regexes behind them ran ~155M times for a
 * 12.6k-channel source and blocked the worker until its liveness probe killed it.
 */
interface PairFeatures {
    /** Raw tvg-id / epg id ('' when absent). */
    epgId: string;
    epgKey: string;
    urlId: string;
    /** Normalized name ('' when it normalizes to nothing). */
    nameKey: string;
    category: string;
}

function existingFeatures(existing: ExistingChannel): PairFeatures {
    const epgId = existing.epgChannelId ?? '';
    return {
        epgId,
        epgKey: normalizeEpgId(epgId),
        urlId: extractUrlChannelId(existing.streamUrl) ?? '',
        nameKey: normalizeChannelName(existing.name),
        category: existing.categoryName ?? '',
    };
}

function newFeatures(newChannel: ProcessedChannel): PairFeatures {
    const epgId = newChannel.original.tvgId ?? '';
    return {
        epgId,
        epgKey: normalizeEpgId(epgId),
        urlId: extractUrlChannelId(newChannel.original.streamUrl) ?? '',
        nameKey: normalizeChannelName(newChannel.original.name),
        category: newChannel.category ?? '',
    };
}

function scoreChannelPair(
    existing: ExistingChannel,
    old: PairFeatures,
    newChannel: ProcessedChannel,
    fresh: PairFeatures,
): { confidence: number; signals: MatchSignal[] } {
    const signals: MatchSignal[] = [];
    let confidence = 0;

    // Signal 1: tvg-id match (40 points)
    const tvgIdMatched = old.epgId !== '' && fresh.epgId !== '' && old.epgKey === fresh.epgKey;
    signals.push({
        type: 'tvg-id',
        weight: tvgIdMatched ? WEIGHT_TVG_ID : 0,
        oldValue: old.epgId,
        newValue: fresh.epgId,
        matched: tvgIdMatched,
    });
    if (tvgIdMatched) confidence += WEIGHT_TVG_ID;

    // Signal 2: URL channel ID match (25 points)
    const urlIdMatched = old.urlId !== '' && fresh.urlId !== '' && old.urlId === fresh.urlId;
    signals.push({
        type: 'url-channel-id',
        weight: urlIdMatched ? WEIGHT_URL_CHANNEL_ID : 0,
        oldValue: old.urlId,
        newValue: fresh.urlId,
        matched: urlIdMatched,
    });
    if (urlIdMatched) confidence += WEIGHT_URL_CHANNEL_ID;

    // Signal 3: Normalized name match (25 points)
    const nameMatched = old.nameKey !== '' && fresh.nameKey !== '' && old.nameKey === fresh.nameKey;
    signals.push({
        type: 'normalized-name',
        weight: nameMatched ? WEIGHT_NORMALIZED_NAME : 0,
        oldValue: existing.name,
        newValue: newChannel.original.name,
        matched: nameMatched,
    });
    if (nameMatched) confidence += WEIGHT_NORMALIZED_NAME;

    // Signal 4: Group-title match (10 points)
    const groupMatched =
        old.category !== '' && fresh.category !== '' && old.category === fresh.category;
    signals.push({
        type: 'group-title',
        weight: groupMatched ? WEIGHT_GROUP_TITLE : 0,
        oldValue: old.category,
        newValue: fresh.category,
        matched: groupMatched,
    });
    if (groupMatched) confidence += WEIGHT_GROUP_TITLE;

    return { confidence, signals };
}

function confidenceTier(score: number): ConfidenceTier {
    if (score > AUTO_THRESHOLD) return 'auto';
    if (score >= REVIEW_THRESHOLD) return 'review';
    return 'new';
}

// ── Main Matching Function ─────────────────────────────────────────────

/**
 * Match new M3U channels against existing database channels using
 * multi-signal weighted scoring with greedy assignment.
 *
 * Pure function — no database access, no side effects.
 */
export function matchChannels(
    existingChannels: ExistingChannel[],
    newChannels: ProcessedChannel[],
): ChannelMatchResult {
    // Candidate matches: every (existing, new) pair scoring at least
    // REVIEW_THRESHOLD. Group-title alone (10) cannot reach it, so such a pair
    // shares a tvg-id, URL channel id or normalized name; only pairs found
    // through those keys are scored. Scoring every pair was O(n x m) regex work
    // (155M pairs for a 12.6k-channel source).
    const oldFeatures = existingChannels.map(existingFeatures);
    const freshFeatures = newChannels.map(newFeatures);
    const byEpg = new Map<string, number[]>();
    const byUrl = new Map<string, number[]>();
    const byName = new Map<string, number[]>();
    const index = (map: Map<string, number[]>, key: string, ei: number): void => {
        const bucket = map.get(key);
        if (bucket) bucket.push(ei);
        else map.set(key, [ei]);
    };
    oldFeatures.forEach((f, ei) => {
        if (f.epgId !== '') index(byEpg, f.epgKey, ei);
        if (f.urlId !== '') index(byUrl, f.urlId, ei);
        if (f.nameKey !== '') index(byName, f.nameKey, ei);
    });

    const candidates: CandidateMatch[] = [];
    for (let ni = 0; ni < newChannels.length; ni++) {
        const fresh = freshFeatures[ni];
        const seen = new Set<number>();
        const buckets = [
            fresh.epgId !== '' ? byEpg.get(fresh.epgKey) : undefined,
            fresh.urlId !== '' ? byUrl.get(fresh.urlId) : undefined,
            fresh.nameKey !== '' ? byName.get(fresh.nameKey) : undefined,
        ];
        for (const bucket of buckets) {
            if (!bucket) continue;
            for (const ei of bucket) {
                if (seen.has(ei)) continue;
                seen.add(ei);
                const { confidence, signals } = scoreChannelPair(
                    existingChannels[ei],
                    oldFeatures[ei],
                    newChannels[ni],
                    fresh,
                );
                if (confidence >= REVIEW_THRESHOLD) {
                    candidates.push({ existingIdx: ei, newIdx: ni, confidence, signals });
                }
            }
        }
    }

    // Sort by confidence descending (greedy assignment — best matches first).
    // Ties keep the order the full scan produced: new index, then existing.
    candidates.sort(
        (a, b) =>
            b.confidence - a.confidence || a.newIdx - b.newIdx || a.existingIdx - b.existingIdx,
    );

    // Greedy assignment
    const matchedExistingIndices = new Set<number>();
    const matchedNewIndices = new Set<number>();
    const matches: ChannelMatch[] = [];

    for (const candidate of candidates) {
        if (
            matchedExistingIndices.has(candidate.existingIdx) ||
            matchedNewIndices.has(candidate.newIdx)
        ) {
            continue;
        }

        matchedExistingIndices.add(candidate.existingIdx);
        matchedNewIndices.add(candidate.newIdx);

        matches.push({
            existingChannel: existingChannels[candidate.existingIdx],
            newChannel: newChannels[candidate.newIdx],
            confidence: candidate.confidence,
            signals: candidate.signals,
            tier: confidenceTier(candidate.confidence),
        });
    }

    // Unmatched new channels
    const unmatchedNew = newChannels.filter((_, i) => !matchedNewIndices.has(i));

    // Unmatched existing channels (potentially removed)
    const unmatchedExisting = existingChannels.filter((_, i) => !matchedExistingIndices.has(i));

    // Flagged for review (50-80% confidence)
    const flaggedForReview = matches.filter((m) => m.tier === 'review');

    // URL changes (matched but stream URL changed)
    const urlChangedCount = matches.filter(
        (m) => m.existingChannel.streamUrl !== m.newChannel.original.streamUrl,
    ).length;

    // Mass restructure detection: >50% of existing channels unmatched above 50%
    const massRestructure =
        existingChannels.length > 0 && unmatchedExisting.length > existingChannels.length * 0.5;

    const autoMatched = matches.filter((m) => m.tier === 'auto').length;
    const reviewMatched = matches.filter((m) => m.tier === 'review').length;

    return {
        matched: matches,
        newChannels: unmatchedNew,
        removedChannels: unmatchedExisting,
        flaggedForReview,
        massRestructure,
        stats: {
            totalExisting: existingChannels.length,
            totalNew: newChannels.length,
            autoMatched,
            reviewMatched,
            newCount: unmatchedNew.length,
            removedCount: unmatchedExisting.length,
            urlChangedCount,
        },
    };
}
