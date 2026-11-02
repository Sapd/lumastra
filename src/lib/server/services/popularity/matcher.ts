// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProviderTopTrack } from './types.js';
import { normalizeTitle } from './normalize.js';

/**
 * A track from our library as loaded for matching.
 */
export interface LibraryTrack {
    id: string;
    title: string;
    normalizedTitle: string;
    mbid: string | null;
}

/**
 * Match result: which library tracks matched which provider tracks.
 */
export interface MatchResult {
    /** Map from library track UUID → the matched ProviderTopTrack */
    matched: Map<string, ProviderTopTrack>;
    /** Provider tracks that did not match any library track */
    unmatchedProviderTracks: string[];
}

/**
 * Simple client-side trigram similarity (Jaccard over character trigrams,
 * padded with spaces on both sides). Matches PostgreSQL pg_trgm behavior
 * closely enough for our purposes — we do client-side matching to avoid
 * a per-track DB round-trip.
 *
 * Returns a value in [0, 1].
 */
export function simpleTrigramSim(a: string, b: string): number {
    if (a.length === 0 || b.length === 0) return 0;

    const trigrams = (s: string): Set<string> => {
        const padded = `  ${s}  `;
        const set = new Set<string>();
        for (let i = 0; i <= padded.length - 3; i++) {
            set.add(padded.slice(i, i + 3));
        }
        return set;
    };

    const setA = trigrams(a);
    const setB = trigrams(b);

    let intersection = 0;
    for (const tg of setA) {
        if (setB.has(tg)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    if (union === 0) return 0;

    return intersection / union;
}

/**
 * Match provider top-tracks against a library artist's tracks.
 *
 * Strategy (stop at first match per provider track):
 *   1. MBID equality (libraryTrack.mbid === providerTrack.providerMbid)
 *   2. Exact normalized title equality
 *   3. Trigram similarity >= 0.75 (computed client-side via simpleTrigramSim)
 *
 * A single library track can only match one provider track (the first in
 * provider rank order that claims it).
 */
export function matchTracks(
    libraryTracks: LibraryTrack[],
    providerTracks: ProviderTopTrack[],
): MatchResult {
    const matched = new Map<string, ProviderTopTrack>();
    const unmatchedProviderTracks: string[] = [];

    // Track which library IDs have been claimed
    const claimed = new Set<string>();

    // Sort provider tracks by ascending rank (lowest rank = top track first)
    const sorted = [...providerTracks].sort((a, b) => a.rank - b.rank);

    for (const providerTrack of sorted) {
        const normalizedProviderTitle = normalizeTitle(providerTrack.providerTitle);

        // Pass 1: MBID match
        if (providerTrack.providerMbid) {
            const mbidMatch = libraryTracks.find(
                (lt) =>
                    !claimed.has(lt.id) &&
                    lt.mbid !== null &&
                    lt.mbid !== '' &&
                    lt.mbid === providerTrack.providerMbid,
            );
            if (mbidMatch) {
                claimed.add(mbidMatch.id);
                matched.set(mbidMatch.id, providerTrack);
                continue;
            }
        }

        // Pass 2: Exact normalized title match
        const titleMatch = libraryTracks.find(
            (lt) => !claimed.has(lt.id) && lt.normalizedTitle === normalizedProviderTitle,
        );
        if (titleMatch) {
            claimed.add(titleMatch.id);
            matched.set(titleMatch.id, providerTrack);
            continue;
        }

        // Pass 3: Trigram similarity >= 0.75; on tie, longest shared prefix wins
        let bestTrack: LibraryTrack | null = null;
        let bestSim = 0;

        for (const lt of libraryTracks) {
            if (claimed.has(lt.id)) continue;
            const sim = simpleTrigramSim(lt.normalizedTitle, normalizedProviderTitle);
            if (sim < 0.75) continue;

            if (sim > bestSim) {
                bestSim = sim;
                bestTrack = lt;
            } else if (sim === bestSim && bestTrack !== null) {
                // Tiebreak: longer shared prefix wins
                const sharedPrefix = (x: string, y: string): number => {
                    let len = 0;
                    while (len < x.length && len < y.length && x[len] === y[len]) len++;
                    return len;
                };
                const currentPrefix = sharedPrefix(lt.normalizedTitle, normalizedProviderTitle);
                const bestPrefix = sharedPrefix(bestTrack.normalizedTitle, normalizedProviderTitle);
                if (currentPrefix > bestPrefix) {
                    bestTrack = lt;
                }
            }
        }

        if (bestTrack !== null) {
            claimed.add(bestTrack.id);
            matched.set(bestTrack.id, providerTrack);
        } else {
            unmatchedProviderTracks.push(providerTrack.providerTitle);
        }
    }

    return { matched, unmatchedProviderTracks };
}
