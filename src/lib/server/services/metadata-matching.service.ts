// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Metadata Matching Service
 *
 * Given a local file path and a library path configuration, parses the filename
 * and queries the appropriate metadata provider for a match.
 *
 * On success: returns the best MetadataCandidate.
 * On failure: returns { matched: false, parsed } — caller creates a personal media_item.
 */

import type { MetadataCandidate } from '../providers/types.js';
import type { LibraryPathRow } from '../database/queries/library-paths.queries.js';
import type { PluginContext } from '../plugins/types/base-plugin.js';
import { parseMediaFilename } from '../utils/filename-parser.js';
import { extractSeriesTitleFromPath, extractSeriesYearFromPath } from '../utils/path-parsing.js';
import { Logger } from '../utils/logger.js';
import { invokeProviderSearch } from '$lib/server/tasks/plugin-context.js';
import { normalizeSearchResult } from '$lib/server/providers/normalize.js';
import {
    titleSimilarity,
    yearProximity,
} from '$lib/server/providers/implementations/tmdb/normalize.js';
import { isMovie } from '$lib/server/utils/media-types.js';
import {
    isProviderAuthError,
    shouldWarnProviderAuth,
} from '$lib/server/providers/provider-auth-state.js';

const logger = Logger.for('MetadataMatchingService');

function providerLabel(providerId: string): string {
    if (providerId.startsWith('tmdb')) return 'TMDB';
    return providerId.replace(/-metadata-provider$/, '');
}

/**
 * Minimum title/year match score to accept a candidate automatically.
 *
 * A provider's own `confidence` (e.g. TMDB's is derived from live
 * popularity/trending buzz — see `searchResultToCandidate`) measures how
 * *popular* a result currently is, not whether it is the right movie/show
 * for this file. A back-catalog title like "The Hunger Games (2012)" has a
 * near-zero TMDB popularity score most of the time, while a currently-viral
 * new release scores near 1.0 regardless of correctness — so provider
 * confidence must not multiply into (and potentially crush) the acceptance
 * score. We gate purely on titleSimilarity * yearProximity, and use provider
 * confidence only as a tie-breaker when sorting candidates whose title/year
 * match equally well.
 */
const MIN_CONFIDENCE = 0.5;
/** Minimum normalized title-similarity required regardless of combined score. */
const TITLE_SIMILARITY_FLOOR = 0.6;

/**
 * Year factor for a series candidate against the series folder's "(YYYY)".
 *
 * Only a clear disagreement rejects: "Scrubs (2026)" must not match the 2001
 * show, but a folder year one or two off the provider's first-air year (a
 * December premiere, a regional first airing) still matches. Within that,
 * the closer year ranks first.
 */
function seriesYearFactor(folderYear?: number, firstAirYear?: number): number {
    if (folderYear == null || firstAirYear == null) return 1;
    const gap = Math.abs(folderYear - firstAirYear);
    return gap >= 3 ? 0 : 1 - gap * 0.1;
}

export interface MatchResult {
    /** Whether a sufficiently confident match was found. */
    matched: boolean;
    /** Best candidate, if matched. */
    candidate?: MetadataCandidate;
    /** Parsed info extracted from the filename. */
    parsed: ReturnType<typeof parseMediaFilename>;
    /**
     * Set when no match was possible because the provider rejected its
     * credentials (not because the file has no match). Callers count these
     * separately so a scan with a dead TMDB key does not read as "all good".
     * 'unavailable': the search itself failed (network, timeout, 429/5xx) — no
     * answer about this file, so it must not be treated (or cached) as a miss.
     */
    providerError?: 'auth' | 'unavailable';
}

/**
 * Attempt to match a local file to a metadata candidate.
 *
 * @param filePath - Absolute path to the media file
 * @param libraryPath - The configured library path this file belongs to
 * @param providerId - Full provider id (e.g. `'tmdb-metadata-provider'`).
 *   Caller is responsible for verifying the provider is configured before
 *   calling (via `isProviderConfigured(providerId)`).
 * @param context - Plugin execution context (for logging)
 */
export async function matchFileToMetadata(
    filePath: string,
    libraryPath: LibraryPathRow,
    providerId: string,
    context: PluginContext,
): Promise<MatchResult> {
    const parsed = parseMediaFilename(filePath);

    context.logger.debug('Matching file to metadata', {
        filePath,
        parsedTitle: parsed.title,
        parsedYear: parsed.year,
        mediaType: libraryPath.media_type,
        providerId,
    });

    const type: 'movie' | 'tv' = isMovie(libraryPath.media_type) ? 'movie' : 'tv';

    let candidates: MetadataCandidate[];
    let queryTitle: string;
    let queryYear: number | undefined;

    try {
        if (type === 'movie') {
            queryTitle = parsed.title;
            queryYear = parsed.year;
            const raw = await invokeProviderSearch<unknown, unknown>(providerId, {
                type: 'movie',
                query: parsed.title,
                year: parsed.year,
                // Per-library metadata language (e.g. 'en', 'de-DE'). Providers that
                // honor it (TMDB) localize titles/overviews to the library's setting;
                // others ignore it and fall back to their default.
                language: libraryPath.language || undefined,
            });
            candidates = raw
                .map((r) => normalizeSearchResult(providerId, r, 'movie', parsed.year))
                .filter((c): c is MetadataCandidate => c !== null);
        } else {
            // tv, anime → series search.
            // Use folder-derived series title (e.g. "Orbit Guild" from the parent
            // folder) instead of the filename title (e.g. "01 Abgrund" or
            // "A Certain Scientific Railgun S") which is often the episode name.
            const seriesTitle = extractSeriesTitleFromPath(
                filePath,
                libraryPath.path,
                parsed.title,
            );
            queryTitle = seriesTitle;
            // Scores candidates only; the provider query stays year-less so a
            // first-air year off by one still comes back.
            queryYear = extractSeriesYearFromPath(filePath, libraryPath.path);
            const raw = await invokeProviderSearch<unknown, unknown>(providerId, {
                type: 'tv',
                query: seriesTitle,
                // Per-library metadata language — see movie branch above.
                language: libraryPath.language || undefined,
            });
            candidates = raw
                .map((r) => normalizeSearchResult(providerId, r, 'tv'))
                .filter((c): c is MetadataCandidate => c !== null);
        }
    } catch (error) {
        if (isProviderAuthError(error)) {
            // One clear warning per provider (per 10 min), not an error + stack
            // for every file of the scan.
            if (shouldWarnProviderAuth(providerId)) {
                logger.warn(
                    `${providerLabel(providerId)} key rejected — metadata matching skipped; files are added without metadata until the key is fixed`,
                    { providerId, status: error.status },
                );
            }
            return { matched: false, parsed, providerError: 'auth' };
        }
        logger.error('Metadata provider search failed', error as Error, {
            filePath,
            providerId,
        });
        return { matched: false, parsed, providerError: 'unavailable' };
    }

    // Score each candidate by how well its title/year actually match the
    // query (see MIN_CONFIDENCE doc comment above). Provider confidence is
    // used only to break ties between equally-good title/year matches, never
    // to gate acceptance or outrank a better title match.
    const scored = candidates
        .map((candidate) => {
            const titleSim = titleSimilarity(queryTitle, candidate.title);
            const yearScore =
                type === 'movie'
                    ? yearProximity(queryYear, candidate.year)
                    : seriesYearFactor(queryYear, candidate.year);
            return {
                candidate,
                titleSim,
                matchScore: titleSim * yearScore,
            };
        })
        .toSorted(
            (a, b) =>
                b.matchScore - a.matchScore || b.candidate.confidence - a.candidate.confidence,
        );

    const best = scored[0];

    if (!best || best.matchScore < MIN_CONFIDENCE || best.titleSim < TITLE_SIMILARITY_FLOOR) {
        context.logger.debug('No confident match found', {
            filePath,
            candidateCount: candidates.length,
            bestScore: best?.matchScore,
            bestTitleSim: best?.titleSim,
        });

        return { matched: false, parsed };
    }

    context.logger.info('File matched to metadata candidate', {
        filePath,
        candidateId: best.candidate.externalId,
        candidateTitle: best.candidate.title,
        confidence: best.matchScore,
    });

    // Persist the title/year match score, not the raw provider confidence —
    // downstream consumers (external_ids.confidence) should reflect match
    // quality, not the provider's popularity signal.
    return {
        matched: true,
        candidate: { ...best.candidate, confidence: best.matchScore },
        parsed,
    };
}
