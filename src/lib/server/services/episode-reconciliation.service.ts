// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { refreshSortTitles } from '$lib/server/database/queries/sort-title.queries.js';
import type postgres from 'postgres';
import {
    bestMatchAboveThreshold,
    isGenericChapterName,
} from '$lib/server/utils/string-similarity.js';
import type {
    ReconcileFileGroup,
    ReconcileEpisodeRow,
} from '$lib/server/database/queries/episode-reconciliation.queries.js';
import {
    getReconciliationGroups,
    getReconciliationUndoSnapshots,
    getEpisodesHoldingTmdbIds,
    getLockedHeldTmdbIds,
    lockReconciliationEvidence,
    getReconciliationEvidence,
    getReconciliationTargetHolders,
    lockQuarantineEvidence,
    type ReconciliationEvidence,
} from '$lib/server/database/queries/episode-reconciliation.queries.js';
import { getTmdbId } from '$lib/server/database/queries/external-ids.queries.js';
import {
    markSeriesBackfilled,
    listBackfillSeriesCandidates,
    type BackfillSeriesCandidate,
} from '$lib/server/database/queries/episode-reconciliation.queries.js';
import {
    writeQuarantineSnapshot,
    type QuarantineEntry,
    listQuarantineSnapshots,
    resolveQuarantineSnapshot,
    archiveQuarantineSnapshot,
    lockQuarantineSnapshots,
    type QuarantineSnapshot,
    listNavigableQuarantineEpisodes,
    getQuarantineCurrentMatch,
    getQuarantineSnapshot,
    type QuarantineCurrentMatch,
} from '$lib/server/database/queries/sync-quarantine.queries.js';
import { insertAdminAuditEvent } from '$lib/server/database/queries/admin-audit.queries.js';
import { tmdbApi, createTMDBApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { config } from '$lib/server/config.js';
import {
    getProvidersByPriority,
    invokeProviderChildList,
} from '$lib/server/tasks/plugin-context.js';
import { createCatalogService } from '$lib/server/services/catalog.service.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import type { ExternalIdWrite } from '$lib/server/providers/provider-types.js';
import { Logger } from '$lib/server/utils/logger.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { extractTitleSegmentsFromFilename } from '$lib/server/utils/episode-filename-titles.js';
import { upsertProviderMetadataUnlessLocked } from '$lib/server/database/queries/media-upsert.js';

import { normalizeEpisodeTitle } from '$lib/server/utils/episode-title-match.js';
import {
    insertReconciliationMove,
    loadBlockedPairKeys,
    reconciliationPairKey,
} from '$lib/server/database/queries/episode-reconciliation-moves.queries.js';

const logger = Logger.for('EpisodeReconciliation');
const incompleteCatalogs = new WeakSet<TmdbCatalogEpisode[]>();

export interface TmdbCatalogEpisode {
    tmdbEpisodeId: string;
    name: string;
    altNames: string[];
    overview: string | null;
    seasonNumber: number;
    episodeNumber: number;
    /** TMDB still_path ("/abc.jpg") of THIS episode — persisted at apply so the
     *  episode's thumbnail follows the content-matched id, not the local number. */
    stillPath: string | null;
}

export type ReconcileReason =
    | 'matched'
    | 'no-usable-chapters'
    | 'chapter-count-mismatch'
    | 'below-threshold'
    | 'duplicate-match'
    | 'manually-locked'
    // Title was already content-matched to an external identity. The matcher
    // treats this as a trusted, frozen binding and never proposes a change for
    // it — historical confident matches must not be re-litigated by a backfill.
    | 'identity-bound'
    | 'contradictory-file-window';

export interface ReconcileProposal {
    episodeId: string;
    fileId: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    currentTitle: string | null;
    proposedTitle: string | null;
    matchedTmdbEpisodeId: string | null;
    confidence: number;
    changed: boolean;
    reason: ReconcileReason;
    source: 'chapters' | 'filename';
}

export interface ReconcileOptions {
    /** Minimum normalized-similarity score to accept a chapter→episode match. */
    threshold: number;
}

const DEFAULT_THRESHOLD = 0.8;

/**
 * An episode row the matcher must never propose a change for. Two protections:
 *   - metadata_locked: an admin froze this row by hand.
 *   - title_binding === 'identity': the title was already bound to an external
 *     identity by a prior confident content match; re-running the matcher must
 *     never override that trusted binding (a backfill correcting historical
 *     mis-mappings only touches fragile positional/unbound rows).
 * Protected rows still consume their ordinal chapter slot so locking/binding one
 * episode never shifts the chapter index of its unprotected siblings.
 */
function isProtectedEpisode(ep: ReconcileEpisodeRow): boolean {
    return ep.metadataLocked || ep.titleBinding === 'identity';
}

/** Reason emitted for a protected row, distinguishing the two protections. */
function protectedReason(ep: ReconcileEpisodeRow): ReconcileReason {
    return ep.metadataLocked ? 'manually-locked' : 'identity-bound';
}

/**
 * Reasons that are intentionally frozen — the row is already correct (a prior
 * confident match) or admin-locked — so they are NOT "needs review".
 */
const FROZEN_REASONS: ReadonlySet<ReconcileReason> = new Set(['identity-bound', 'manually-locked']);

/** Exact aliases are content proof only when they identify a single catalog identity. */
function exactCatalogMatches(query: string, catalog: TmdbCatalogEpisode[]): TmdbCatalogEpisode[] {
    if (isGenericChapterName(query)) return [];
    const title = normalizeEpisodeTitle(query);
    return catalog.filter((entry) =>
        [entry.name, ...entry.altNames].some(
            (variant) => !isGenericChapterName(variant) && normalizeEpisodeTitle(variant) === title,
        ),
    );
}

/**
 * Match a single query string against the catalog using all name variants
 * (primary name + altNames). Returns the best-scoring catalog entry and its
 * score, or null when no variant clears the threshold.
 */
function matchAgainstCatalog(
    query: string,
    catalog: TmdbCatalogEpisode[],
    threshold: number,
    filePart: number | null = null,
): { matched: TmdbCatalogEpisode; score: number } | null {
    if (isGenericChapterName(query)) return null;
    const queryPart = explicitPart(query);
    if (filePart !== null && queryPart !== null && queryPart !== filePart) return null;
    const part = filePart ?? queryPart;
    const compatible =
        part === null
            ? catalog
            : catalog.filter((entry) =>
                  [entry.name, ...entry.altNames].some((variant) => explicitPart(variant) === part),
              );
    const exact = exactCatalogMatches(query, compatible);
    if (exact.length > 0) {
        return new Set(exact.map((entry) => entry.tmdbEpisodeId)).size === 1
            ? { matched: exact[0], score: 1 }
            : null;
    }
    let bestScore = -1;
    let bestEntry: TmdbCatalogEpisode | null = null;

    for (const entry of compatible) {
        const variants = [entry.name, ...entry.altNames];
        for (const variant of variants) {
            if (isGenericChapterName(variant) || (part !== null && explicitPart(variant) !== part))
                continue;
            const { bestIndex, bestScore: score } = bestMatchAboveThreshold(
                query,
                [variant],
                threshold,
            );
            if (bestIndex !== -1 && score > bestScore) {
                bestScore = score;
                bestEntry = entry;
            }
        }
    }

    if (!bestEntry || bestScore < threshold) return null;
    return { matched: bestEntry, score: bestScore };
}

/** Normalize explicit E lists and inclusive ranges to the same numbering evidence.
 * Bound expansion to avoid allocating an unbounded window from a malformed name.
 */
function expandFilenameEpisodes(first: number, suffix: string): number[] | null {
    const episodes = [first];
    for (const token of suffix.matchAll(/(-E?|E)(\d{1,4})/gi)) {
        const end = Number(token[2]);
        if (token[1].startsWith('-')) {
            const start = episodes[episodes.length - 1];
            if (end < start || episodes.length + end - start > 1000) return null;
            for (let episode = start + 1; episode <= end; episode++) episodes.push(episode);
        } else {
            episodes.push(end);
        }
    }
    return episodes;
}

/** A filename window is a contradiction fence, never content proof. Only
 * bounded, explicit multi-episode tokens are checked here; ordinary single-episode
 * filenames retain the existing title matcher. Numbering offsets are permitted
 * when the complete linked logical window is coherent. */
function consistentFilenameWindow(group: ReconcileFileGroup): boolean {
    const match = /S(\d{1,4})E(\d{1,4})((?:(?:E|-)(?:E)?\d{1,4})+)(?=[. _-]|$)/i.exec(
        group.fileName ?? '',
    );
    if (!match) return true;
    const first = Number(match[2]);
    const ordinals = expandFilenameEpisodes(first, match[3]) ?? [];
    return (
        ordinals.length > 1 &&
        ordinals.every((ordinal, index) => ordinal === first + index) &&
        group.episodes.length === ordinals.length &&
        group.episodes.every(
            (ep, index) =>
                ep.seasonNumber === group.episodes[0].seasonNumber &&
                ep.episodeNumber !== null &&
                ep.episodeNumber === group.episodes[0].episodeNumber! + index,
        )
    );
}

/** Explicit release numbers contradict duplicate identity even when titles repeat.
 * Local/catalog positions are intentionally excluded: correcting them is this
 * matcher's job. The filename's own numbering is independent evidence. */
function filenameNumbers(fileName: string | null): string | null {
    if (!fileName) return null;
    const absolute = /(?:^| - )(\d{1,4})(?= - )/.exec(fileName);
    const se = /S(\d{1,4})E(\d{1,4})((?:(?:E|-)(?:E)?\d{1,4})*)/i.exec(fileName);
    if (se) {
        const episodes = expandFilenameEpisodes(Number(se[2]), se[3]);
        if (!episodes) return `invalid:${se[0].toLowerCase()}`;
        const release = absolute ? `:absolute:${Number(absolute[1])}` : '';
        return [Number(se[1]), ...episodes].join(':') + release;
    }
    return absolute ? `absolute:${Number(absolute[1])}` : null;
}

/** Explicit story parts in release titles are independent of a shared chapter label. */
function explicitPart(title: string | null): number | null {
    const match = /(?:\b(?:teil|part)[. _-]*|\()(\d+)\)?(?=[. _-]|$)/i.exec(title ?? '');
    return match ? Number(match[1]) : null;
}

/** A shared catalog target is only a collision, not duplicate proof. Require
 * exact meaningful title evidence plus the same physical file or a matching
 * head hash AND size. Known disagreements veto that inference; equal runtime
 * alone is common across an entire season and proves nothing. */
function hasDuplicateEvidence(
    a: ReconcileFileGroup,
    b: ReconcileFileGroup,
    aTitle: string,
    bTitle: string,
): boolean {
    if (aTitle.trim().toLowerCase() !== bTitle.trim().toLowerCase()) return false;
    const aPart = explicitPart(a.fileName) ?? explicitPart(aTitle);
    const bPart = explicitPart(b.fileName) ?? explicitPart(bTitle);
    if (aPart !== null && bPart !== null && aPart !== bPart) return false;
    if (a.fileId === b.fileId) return true;
    const aNumbers = filenameNumbers(a.fileName);
    const bNumbers = filenameNumbers(b.fileName);
    if (aNumbers && bNumbers && aNumbers !== bNumbers) return false;
    if (
        a.durationSeconds != null &&
        b.durationSeconds != null &&
        a.durationSeconds !== b.durationSeconds
    )
        return false;
    return Boolean(
        a.fileHashHead &&
        a.fileHashHead === b.fileHashHead &&
        a.fileSizeBytes != null &&
        a.fileSizeBytes > 0 &&
        a.fileSizeBytes === b.fileSizeBytes,
    );
}

/** Cross-season title matches need the same absolute-number corroboration as
 * the absolute reconciliation path: a stored file number and a gap-free catalog
 * whose seasons run from 1 or continue the preceding absolute run. */
function filenameSeasonCompatible(
    proposal: ReconcileProposal,
    groups: ReconcileFileGroup[],
    catalog: TmdbCatalogEpisode[],
): boolean {
    if (proposal.seasonNumber === null || proposal.seasonNumber === 0) return false;
    const target = catalog.find((e) => e.tmdbEpisodeId === proposal.matchedTmdbEpisodeId);
    if (!target || target.seasonNumber === 0) return false;
    if (target.seasonNumber === proposal.seasonNumber) return true;
    const absolute = groups.find((g) => g.fileId === proposal.fileId)?.absoluteEpisode;
    if (!absolute || absolute < 1) return false;
    const seasons = new Map<number, TmdbCatalogEpisode[]>();
    for (const ep of catalog) {
        if (ep.seasonNumber === 0) continue;
        const episodes = seasons.get(ep.seasonNumber) ?? [];
        episodes.push(ep);
        seasons.set(ep.seasonNumber, episodes);
    }
    const ordered: TmdbCatalogEpisode[] = [];
    let expectedSeason = 1;
    for (const season of [...seasons.keys()].sort((a, b) => a - b)) {
        if (season !== expectedSeason++) break;
        const episodes = seasons.get(season)!.sort((a, b) => a.episodeNumber - b.episodeNumber);
        const runsFrom = (base: number): boolean =>
            episodes.every((e, i) => e.episodeNumber === base + i);
        if (!runsFrom(1) && !runsFrom(ordered.length + 1)) break;
        ordered.push(...episodes);
    }
    return ordered[absolute - 1]?.tmdbEpisodeId === target.tmdbEpisodeId;
}

/**
 * Pure matcher: for each file, match its CONTENT chapters (generics filtered)
 * against the TMDB episode catalog and bind each episode row on the file to the
 * chapter at the same ordinal position. Only binds when the file's content-chapter
 * count equals the number of episode rows on the file (the unambiguous case).
 *
 * When a file has no usable content chapters, attempts to derive title segments
 * from the filename before giving up.
 */
export function computeReconciliationProposals(
    groups: ReconcileFileGroup[],
    catalog: TmdbCatalogEpisode[],
    options: ReconcileOptions = { threshold: DEFAULT_THRESHOLD },
): ReconcileProposal[] {
    const proposals: ReconcileProposal[] = [];
    const titleEvidence = new Map<ReconcileProposal, string>();
    const files = new Map(groups.map((group) => [group.fileId, group]));

    for (const group of groups) {
        const contentChapters = group.chapterNames.filter((n) => !isGenericChapterName(n));

        const base = (
            ep: ReconcileFileGroup['episodes'][number],
            reason: ReconcileReason,
            source: 'chapters' | 'filename' = 'chapters',
        ): ReconcileProposal => ({
            episodeId: ep.episodeId,
            fileId: group.fileId,
            seasonNumber: ep.seasonNumber,
            episodeNumber: ep.episodeNumber,
            currentTitle: ep.currentTitle,
            proposedTitle: null,
            matchedTmdbEpisodeId: null,
            confidence: 0,
            changed: false,
            reason,
            source,
        });

        // Chapter→episode binding uses the full episode-list ordinal so that locking
        // one episode does not shift the chapter index for its siblings: episode[i]
        // always corresponds to chapter[i]. Locked episodes emit 'manually-locked'
        // and consume their chapter slot without participating in matching or the
        // duplicate-demotion count.
        if (!consistentFilenameWindow(group)) {
            for (const ep of group.episodes)
                proposals.push(
                    base(
                        ep,
                        isProtectedEpisode(ep) ? protectedReason(ep) : 'contradictory-file-window',
                        'filename',
                    ),
                );
            continue;
        }

        const fileSegments = group.fileName ? extractTitleSegmentsFromFilename(group.fileName) : [];
        const exactFilename =
            fileSegments.length === group.episodes.length &&
            fileSegments.length > 0 &&
            fileSegments.every((segment) => exactCatalogMatches(segment, catalog).length > 0);
        if (contentChapters.length === 0 || exactFilename) {
            // Filename segments correspond positionally to the episode rows on the
            // file (segment[i] ↔ episode[i] in episode_number order), exactly like
            // the chapter branch below. Align on the FULL episode list — never the
            // unprotected subset — so an identity-bound/locked sibling consumes its
            // ordinal slot instead of shifting the segment index of its neighbours.
            // (Aligning on the filtered subset would shrink the required count when a
            // sibling flips to identity between passes, fail the equality, and drop
            // the remaining fragile rows to 'no-usable-chapters' — they'd never get
            // re-matched.)
            if (fileSegments.length > 0 && fileSegments.length === group.episodes.length) {
                group.episodes.forEach((ep, idx) => {
                    if (isProtectedEpisode(ep)) {
                        proposals.push(base(ep, protectedReason(ep), 'filename'));
                        return;
                    }
                    const segment = fileSegments[idx];
                    const result = matchAgainstCatalog(
                        segment,
                        catalog,
                        options.threshold,
                        group.episodes.length === 1 ? explicitPart(group.fileName) : null,
                    );
                    if (!result) {
                        proposals.push(base(ep, 'below-threshold', 'filename'));
                        return;
                    }
                    const proposal: ReconcileProposal = {
                        episodeId: ep.episodeId,
                        fileId: group.fileId,
                        seasonNumber: ep.seasonNumber,
                        episodeNumber: ep.episodeNumber,
                        currentTitle: ep.currentTitle,
                        proposedTitle: result.matched.name,
                        matchedTmdbEpisodeId: result.matched.tmdbEpisodeId,
                        confidence: result.score,
                        changed:
                            ep.tmdbEpisodeId !== result.matched.tmdbEpisodeId ||
                            (ep.currentTitle ?? '') !== result.matched.name,
                        reason: 'matched',
                        source: 'filename',
                    };
                    proposals.push(proposal);
                    titleEvidence.set(proposal, segment);
                });
            } else {
                for (const ep of group.episodes) {
                    proposals.push(
                        base(
                            ep,
                            isProtectedEpisode(ep) ? protectedReason(ep) : 'no-usable-chapters',
                        ),
                    );
                }
            }
            continue;
        }
        if (contentChapters.length !== group.episodes.length) {
            for (const ep of group.episodes) {
                proposals.push(
                    base(
                        ep,
                        isProtectedEpisode(ep) ? protectedReason(ep) : 'chapter-count-mismatch',
                    ),
                );
            }
            continue;
        }

        group.episodes.forEach((ep, idx) => {
            if (isProtectedEpisode(ep)) {
                proposals.push(base(ep, protectedReason(ep)));
                return;
            }
            const chapter = contentChapters[idx];
            const result = matchAgainstCatalog(
                chapter,
                catalog,
                options.threshold,
                group.episodes.length === 1 ? explicitPart(group.fileName) : null,
            );
            if (!result) {
                proposals.push(base(ep, 'below-threshold'));
                return;
            }
            const proposal: ReconcileProposal = {
                episodeId: ep.episodeId,
                fileId: group.fileId,
                seasonNumber: ep.seasonNumber,
                episodeNumber: ep.episodeNumber,
                currentTitle: ep.currentTitle,
                proposedTitle: result.matched.name,
                matchedTmdbEpisodeId: result.matched.tmdbEpisodeId,
                confidence: result.score,
                changed:
                    ep.tmdbEpisodeId !== result.matched.tmdbEpisodeId ||
                    (ep.currentTitle ?? '') !== result.matched.name,
                reason: 'matched',
                source: 'chapters',
            };
            proposals.push(proposal);
            titleEvidence.set(proposal, chapter);
        });
    }

    // Always block EVERY claimant of a colliding id from auto-apply. Only
    // corroborated peers are duplicate-match warnings; unsupported collisions
    // carry no candidate and must not create backfill quarantine noise.
    const claims = new Map<string, ReconcileProposal[]>();
    for (const p of proposals) {
        if (p.reason !== 'matched' || !p.matchedTmdbEpisodeId) continue;
        const peers = claims.get(p.matchedTmdbEpisodeId) ?? [];
        peers.push(p);
        claims.set(p.matchedTmdbEpisodeId, peers);
    }
    for (const peers of claims.values()) {
        if (peers.length < 2) continue;
        for (const p of peers) {
            const duplicate = peers.some(
                (peer) =>
                    peer !== p &&
                    hasDuplicateEvidence(
                        files.get(p.fileId)!,
                        files.get(peer.fileId)!,
                        titleEvidence.get(p)!,
                        titleEvidence.get(peer)!,
                    ),
            );
            p.changed = false;
            if (duplicate) {
                p.reason = 'duplicate-match';
            } else {
                p.reason = 'below-threshold';
                p.confidence = 0;
                p.matchedTmdbEpisodeId = null;
                p.proposedTitle = null;
            }
        }
    }

    return proposals;
}

/**
 * Minimal ISO 639-2/B (and a few 639-2/T) → 639-1 map for the languages a TMDB
 * release is likely dubbed/subbed in. Used to turn stored audio-stream codes
 * (e.g. 'ger') into TMDB language codes (e.g. 'de'). Unknown codes pass through.
 */
const ISO_639_2_TO_1: Record<string, string> = {
    ger: 'de',
    deu: 'de',
    eng: 'en',
    fre: 'fr',
    fra: 'fr',
    spa: 'es',
    ita: 'it',
    jpn: 'ja',
    por: 'pt',
    rus: 'ru',
    dut: 'nl',
    nld: 'nl',
    pol: 'pl',
    swe: 'sv',
    dan: 'da',
    fin: 'fi',
    nor: 'no',
    cze: 'cs',
    ces: 'cs',
    kor: 'ko',
    chi: 'zh',
    zho: 'zh',
    tur: 'tr',
    ara: 'ar',
    heb: 'he',
    hun: 'hu',
    ell: 'el',
    gre: 'el',
};

// ---------------------------------------------------------------------------
// Provider-based season/episode fetch helpers
// ---------------------------------------------------------------------------

/**
 * Find the highest-priority provider that declares `childList`. Returns its id,
 * or `null` when none is registered. Used to route season/episode fetches
 * through the provider SDK before falling back to direct `tmdbApi` calls.
 */
function resolveChildListProviderId(): string | null {
    const providers = getProvidersByPriority();
    for (const p of providers) {
        if (typeof p.childList === 'function') return p.id;
    }
    return null;
}

/**
 * Fetch the season list for a TV series via the provider SDK, falling back to
 * `tmdbApi.getTVShowSeasons` when the provider is unavailable.
 *
 * Returns normalized season stubs: `{ seasonNumber, name, episodeCount }`.
 */
async function fetchSeasons(
    tmdbId: number,
    providerId: string | null,
): Promise<{ seasonNumber: number; name: string; episodeCount: number }[]> {
    if (providerId) {
        try {
            const raw = await invokeProviderChildList<Record<string, unknown>>(
                providerId,
                `tv:${tmdbId}`,
            );
            if (raw.length > 0) {
                return raw.map((s) => ({
                    seasonNumber: typeof s['season_number'] === 'number' ? s['season_number'] : 0,
                    name:
                        typeof s['name'] === 'string'
                            ? s['name']
                            : `Season ${s['season_number'] ?? 0}`,
                    episodeCount: typeof s['episode_count'] === 'number' ? s['episode_count'] : 0,
                }));
            }
        } catch {
            // Fall through to the direct TMDB fallback below.
        }
    }
    // Fresh client, NOT the tmdbApi singleton: the singleton's language is
    // frozen at process boot (constructor default param evaluated once at
    // module load), so a config change never reaches it — the same bug that
    // wrote wrong-language episode text via series-children.ts. This call
    // is language-less (season names/counts feed reconciliation matching AND
    // the primary episode-title candidates), so it must track the CURRENT
    // config.TMDB_LANGUAGE.
    return createTMDBApi(config.TMDB_LANGUAGE).getTVShowSeasons(tmdbId);
}

/**
 * Fetch episodes for a season via the provider SDK, falling back to
 * `tmdbApi.getSeasonEpisodes` when the provider is unavailable.
 *
 * Returns normalized episode stubs: `{ id, name, episodeNumber, seasonNumber, overview?, stillPath? }`.
 */
async function fetchSeasonEpisodes(
    tmdbId: number,
    seasonNumber: number,
    providerId: string | null,
): Promise<
    {
        id: number;
        name: string;
        episodeNumber: number;
        seasonNumber: number;
        overview?: string;
        stillPath?: string;
    }[]
> {
    if (providerId) {
        try {
            const raw = await invokeProviderChildList<Record<string, unknown>>(
                providerId,
                `tv:${tmdbId}:s${seasonNumber}`,
            );
            if (raw.length > 0) {
                return raw.map((e) => ({
                    id: typeof e['id'] === 'number' ? e['id'] : 0,
                    name:
                        typeof e['name'] === 'string'
                            ? e['name']
                            : `Episode ${e['episode_number'] ?? 0}`,
                    episodeNumber:
                        typeof e['episode_number'] === 'number' ? e['episode_number'] : 0,
                    seasonNumber:
                        typeof e['season_number'] === 'number' ? e['season_number'] : seasonNumber,
                    overview: typeof e['overview'] === 'string' ? e['overview'] : undefined,
                    stillPath: typeof e['still_path'] === 'string' ? e['still_path'] : undefined,
                }));
            }
        } catch {
            // Fall through to the direct TMDB fallback below.
        }
    }
    // Fresh client (not the frozen-language tmdbApi singleton) — these episode
    // names become `proposedTitle` → media_items.title (title_binding =
    // 'identity'), i.e. USER-VISIBLE text, so the request language must track
    // the current config.TMDB_LANGUAGE, not the boot-time snapshot.
    return createTMDBApi(config.TMDB_LANGUAGE).getSeasonEpisodes(tmdbId, seasonNumber);
}

/**
 * Fetch episodes for a season in a specific language via the provider SDK,
 * falling back to `tmdbApi.getSeasonEpisodesInLanguage` when the provider is
 * unavailable.
 *
 * Returns minimal episode stubs: `{ id, name, episodeNumber, seasonNumber }`.
 */
async function fetchSeasonEpisodesInLanguage(
    tmdbId: number,
    seasonNumber: number,
    language: string,
    providerId: string | null,
): Promise<{ id: number; name: string; episodeNumber: number; seasonNumber: number }[]> {
    if (providerId) {
        try {
            const raw = await invokeProviderChildList<Record<string, unknown>>(
                providerId,
                `tv:${tmdbId}:s${seasonNumber}`,
                { language },
            );
            if (raw.length > 0) {
                return raw.map((e) => ({
                    id: typeof e['id'] === 'number' ? e['id'] : 0,
                    name:
                        typeof e['name'] === 'string'
                            ? e['name']
                            : `Episode ${e['episode_number'] ?? 0}`,
                    episodeNumber:
                        typeof e['episode_number'] === 'number' ? e['episode_number'] : 0,
                    seasonNumber:
                        typeof e['season_number'] === 'number' ? e['season_number'] : seasonNumber,
                }));
            }
        } catch {
            // Fall through to tmdbApi.
        }
    }
    // The frozen-language tmdbApi singleton is SAFE here (unlike the
    // language-less fallbacks above): makeRequest merges params as
    // `{ language: this.language, ...params }`, so the explicit `language`
    // this method passes per-request fully overrides the singleton's
    // boot-time language. No fresh client needed.
    return tmdbApi.getSeasonEpisodesInLanguage(tmdbId, seasonNumber, language);
}

import {
    reconciliationCatalogEvidence as catalogEvidence,
    snapshotReconciliationCatalog,
} from './episode-reconciliation-catalog.service.js';

export async function loadTmdbCatalog(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<TmdbCatalogEpisode[]> {
    const language = config.TMDB_LANGUAGE;
    const evidence = await getReconciliationEvidence(sql, seriesMediaId);
    const tmdbId = await getTmdbId.get(sql, { mediaId: seriesMediaId });
    if (!tmdbId) return [];

    // Resolve the primary provider for childList calls. Falls back to direct
    // tmdbApi calls inside each fetch helper when no provider is available or
    // the provider returns an empty result.
    const childListProviderId = resolveChildListProviderId();

    // When no provider is available, guard with the legacy tmdbApi.isAvailable()
    // check so we don't attempt API calls against an unconfigured TMDB.
    if (!childListProviderId && !tmdbApi.isAvailable()) return [];

    // Resolve the SERIES' library language so we can match chapter names (written
    // in the library's language — e.g. German "Der Einbruch") against TMDB titles
    // in that same language. The base client fetches the global TMDB_LANGUAGE
    // (en-US by default), which can't match a German chapter. We add the library
    // language (and English) as extra title candidates. Falls back gracefully.
    // Consume the same single-statement snapshot used for catalog provenance.
    // A language edit during provider I/O therefore invalidates the plan just
    // like an identity, sibling or file edit; no mixed snapshots gain provenance.
    const libLang = evidence.libraryLanguage?.trim() || null;
    const audioRows = evidence.audioLanguages.map((language) => ({ language }));

    // Languages to fetch as ALT names (deduped, normalized to a 639-1 base code).
    // The base client already supplies the primary name (global TMDB_LANGUAGE).
    const baseOf = (l: string): string => {
        const lower = l.split('-')[0].toLowerCase();
        return ISO_639_2_TO_1[lower] ?? lower;
    };
    const altLangs = [
        ...new Set(
            [libLang, ...audioRows.map((r) => r.language), 'en']
                .filter((l): l is string => !!l)
                .map(baseOf),
        ),
    ];

    const seasons = await fetchSeasons(tmdbId, childListProviderId);
    let complete = true;
    const catalog: TmdbCatalogEpisode[] = [];
    for (const season of seasons) {
        if (season.seasonNumber === 0) continue;
        let episodes: Awaited<ReturnType<typeof fetchSeasonEpisodes>>;
        try {
            episodes = await fetchSeasonEpisodes(tmdbId, season.seasonNumber, childListProviderId);
        } catch (err) {
            complete = false;
            logger.warn('Failed to load season episodes; skipping season', {
                seriesMediaId,
                seasonNumber: season.seasonNumber,
                error: err instanceof Error ? err.message : String(err),
            });
            continue;
        }

        if (episodes.length < season.episodeCount) complete = false;

        // Fetch each alt language's episode titles (library language + English) for
        // multi-language matching. One extra API call per language per season at
        // most; failures are non-fatal. altByEpId[epId] = set of alt titles.
        const altByEpId = new Map<number, string[]>();
        for (const lang of altLangs) {
            try {
                const localized = await fetchSeasonEpisodesInLanguage(
                    tmdbId,
                    season.seasonNumber,
                    lang,
                    childListProviderId,
                );
                for (const e of localized) {
                    if (!e.name) continue;
                    const list = altByEpId.get(e.id) ?? [];
                    list.push(e.name);
                    altByEpId.set(e.id, list);
                }
            } catch {
                complete = false;
                // Non-fatal: proceed without this language's variants.
            }
        }

        for (const ep of episodes) {
            if (!ep.name) continue;
            // Dedupe alt names against the primary (case-insensitive) and each other.
            const seen = new Set([ep.name.toLowerCase()]);
            const altNames: string[] = [];
            for (const n of altByEpId.get(ep.id) ?? []) {
                const key = n.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                altNames.push(n);
            }
            catalog.push({
                tmdbEpisodeId: String(ep.id),
                name: ep.name,
                altNames,
                overview: ep.overview ?? null,
                seasonNumber: ep.seasonNumber,
                episodeNumber: ep.episodeNumber,
                stillPath: ep.stillPath ?? null,
            });
        }
    }
    const snapshot = snapshotReconciliationCatalog(catalog, {
        seriesId: seriesMediaId,
        evidence,
        language,
    });
    if (!complete) incompleteCatalogs.add(snapshot);
    return snapshot;
}

export interface ReconcilePreview {
    seriesMediaId: string;
    catalogSize: number;
    proposals: ReconcileProposal[];
    changedCount: number;
    needsReviewCount: number;
}

export async function previewReconciliation(
    sql: postgres.Sql,
    seriesMediaId: string,
    options: ReconcileOptions = { threshold: DEFAULT_THRESHOLD },
    preloadedCatalog?: TmdbCatalogEpisode[],
): Promise<ReconcilePreview> {
    const [groups, catalog] = await Promise.all([
        getReconciliationGroups(sql, seriesMediaId),
        preloadedCatalog ?? loadTmdbCatalog(sql, seriesMediaId),
    ]);
    const proposals = computeReconciliationProposals(groups, catalog, options);
    return {
        seriesMediaId,
        catalogSize: catalog.length,
        proposals,
        changedCount: proposals.filter((p) => p.changed && p.reason === 'matched').length,
        // Only genuinely unresolved rows need operator attention. 'identity-bound'
        // and 'manually-locked' are intentionally frozen (already correct / admin
        // froze them) — counting them inflated "needs review" (e.g. all 126 Hafentage
        // episodes) with rows nobody needs to act on.
        needsReviewCount: proposals.filter(
            (p) => p.reason !== 'matched' && !FROZEN_REASONS.has(p.reason),
        ).length,
    };
}

class ReconciliationWriteRejected extends Error {}

export interface ApplyReconcileResult {
    appliedExternalIds: number;
    updatedTitles: number;
    appliedEpisodeIds: string[];
    resolvedQuarantineIds: string[];
    pageChanged?: boolean;
}

export async function applyReconciliation(
    sql: postgres.Sql,
    seriesMediaId: string,
    minConfidence: number,
    episodeIds?: string[],
    preloadedCatalog?: TmdbCatalogEpisode[],
    quarantine?: {
        entries: QuarantineSnapshot[];
        actor: string;
        reviewed?: boolean;
        fenceEntries?: QuarantineSnapshot[];
    },
): Promise<ApplyReconcileResult> {
    // A producer must carry the snapshot captured across its own provider I/O.
    // Never substitute a differently localized catalog for a supplied one.
    const catalog = preloadedCatalog ?? (await loadTmdbCatalog(sql, seriesMediaId));
    const origin = catalogEvidence.get(catalog);
    const empty = {
        appliedExternalIds: 0,
        updatedTitles: 0,
        appliedEpisodeIds: [],
        resolvedQuarantineIds: [],
    };
    if (!origin || origin.seriesId !== seriesMediaId || origin.language !== config.TMDB_LANGUAGE) {
        if (!quarantine?.fenceEntries) return empty;
        if (quarantine.reviewed && origin) return { ...empty, pageChanged: true };
        const current = await withTx(sql, (tx) =>
            lockQuarantineSnapshots(tx, quarantine.fenceEntries!),
        );
        return current ? empty : { ...empty, pageChanged: true };
    }
    const overviewById = new Map(catalog.map((c) => [c.tmdbEpisodeId, c.overview]));
    const stillById = new Map(catalog.map((c) => [c.tmdbEpisodeId, c.stillPath]));
    const originalGroups = await getReconciliationGroups(sql, seriesMediaId);
    const proposals = computeReconciliationProposals(originalGroups, catalog, {
        threshold: minConfidence,
    });
    const allow = episodeIds ? new Set(episodeIds) : null;

    const toApply = proposals.filter(
        (p) =>
            p.reason === 'matched' &&
            p.changed &&
            !!p.matchedTmdbEpisodeId &&
            p.confidence >= minConfidence &&
            (p.source !== 'filename' ||
                (!incompleteCatalogs.has(catalog) &&
                    (quarantine?.reviewed ||
                        filenameSeasonCompatible(p, originalGroups, catalog)))) &&
            (!allow || allow.has(p.episodeId)),
    );

    if (toApply.length === 0 && !quarantine?.fenceEntries) {
        return {
            appliedExternalIds: 0,
            updatedTitles: 0,
            appliedEpisodeIds: [],
            resolvedQuarantineIds: [],
        };
    }

    // Drop any proposal whose target tmdb id is held by a locked episode in this
    // series. The locked holder won't be released by Phase 1b (which skips locked
    // rows), so the upsertExternalId in Phase 2 would hit a unique-constraint
    // collision and roll back the entire transaction. Skipping only the
    // locked-id proposals lets the remaining proposals apply safely.
    const lockedHeld = await getLockedHeldTmdbIds(
        sql,
        seriesMediaId,
        toApply.map((p) => p.matchedTmdbEpisodeId).filter((x): x is string => !!x),
    );
    const toApply2 =
        lockedHeld.size > 0
            ? toApply.filter((p) => !lockedHeld.has(p.matchedTmdbEpisodeId as string))
            : toApply;

    if (toApply2.length === 0 && !quarantine?.fenceEntries) {
        return {
            appliedExternalIds: 0,
            updatedTitles: 0,
            appliedEpisodeIds: [],
            resolvedQuarantineIds: [],
        };
    }

    let appliedExternalIds = 0;
    let updatedTitles = 0;
    const appliedEpisodeIds: string[] = [];
    const resolvedQuarantineIds: string[] = [];
    let committedEvidence: ReconciliationEvidence | undefined;
    let pageChanged = false;

    try {
        await withTx(sql, async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;
            // Serialize concurrent applies for the same series (auto-released at tx end).
            await tx`SELECT set_config('lock_timeout', '10s', true)`;
            await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesMediaId})::bigint)`;
            await lockReconciliationEvidence(tx, seriesMediaId);
            if (
                quarantine?.fenceEntries &&
                !(await lockQuarantineSnapshots(tx, quarantine.fenceEntries))
            ) {
                pageChanged = true;
                return;
            }
            // The entire matching graph is one dependency plan. Reuse it only if
            // every subject, sibling and holder still has exactly the original evidence.
            // This fails closed for partial permutations rather than releasing a changed holder.
            const freshEvidence = await getReconciliationEvidence(tx, seriesMediaId);
            if (
                freshEvidence.image !== origin.evidence.image ||
                origin.language !== config.TMDB_LANGUAGE
            ) {
                if (quarantine?.reviewed) pageChanged = true;
                return;
            }
            const freshProtected = await getLockedHeldTmdbIds(
                tx,
                seriesMediaId,
                toApply2.map((p) => p.matchedTmdbEpisodeId as string),
            );
            let eligible = toApply2.filter((p) => {
                const episode = originalGroups
                    .flatMap((g) => g.episodes)
                    .find((e) => e.episodeId === p.episodeId);
                return (
                    episode?.status === 'active' &&
                    episode.seasonStatus === 'active' &&
                    episode.seriesStatus === 'active' &&
                    !episode.seasonLocked &&
                    !episode.seriesLocked &&
                    ((!quarantine?.reviewed && p.source !== 'filename') ||
                        episode.parentSeasonNumber === episode.seasonNumber) &&
                    !freshProtected.has(p.matchedTmdbEpisodeId as string)
                );
            });
            const blockedPairs = await loadBlockedPairKeys(
                tx,
                eligible.map((p) => p.episodeId),
            );
            eligible = eligible.filter(
                (p) =>
                    !blockedPairs.has(reconciliationPairKey(p.episodeId, p.matchedTmdbEpisodeId!)),
            );
            if (quarantine?.reviewed) {
                const unchanged = new Set<string>();
                for (const warning of quarantine.entries) {
                    const [row] = await tx<{ id: string }[]>`
                        SELECT id FROM sync_quarantine q WHERE id = ${warning.id} AND resolved_at IS NULL
                            AND xmin::text = ${warning.rowVersion}
                            AND to_jsonb(q) = ${tx.json(warning.rowImage as Record<string, never>)}::jsonb
                        FOR UPDATE
                    `;
                    if (row) unchanged.add(warning.externalId);
                }
                eligible = eligible.filter(
                    (p) =>
                        unchanged.has(p.episodeId) &&
                        quarantine.entries.some(
                            (e) =>
                                e.externalId === p.episodeId &&
                                historicalProposalMatches(e, p, seriesMediaId, originalGroups),
                        ),
                );
            }
            const holders = await getReconciliationTargetHolders(
                tx,
                seriesMediaId,
                eligible.map((p) => p.matchedTmdbEpisodeId as string),
            );
            const holderByTarget = new Map(holders.map((h) => [h.targetId, h.mediaId]));
            const fileBackedHolders = new Set(
                holders.filter((h) => h.hasFiles).map((h) => h.mediaId),
            );
            const candidates = new Set(
                proposals
                    .filter((p) => p.reason === 'matched' && p.changed)
                    .map((p) => p.episodeId),
            );
            let removed: boolean;
            do {
                const allowedIds = new Set(eligible.map((p) => p.episodeId));
                const next = eligible.filter((p) => {
                    const holder = holderByTarget.get(p.matchedTmdbEpisodeId as string);
                    return (
                        !holder ||
                        holder === p.episodeId ||
                        allowedIds.has(holder) ||
                        (!quarantine?.reviewed &&
                            !candidates.has(holder) &&
                            (p.source !== 'filename' || !fileBackedHolders.has(holder)))
                    );
                });
                removed = next.length !== eligible.length;
                eligible = next;
            } while (removed);
            const catalogService = createCatalogService(tx, {
                skipLifecycleHooks: true,
            });
            const targetIds = eligible.map((p) => p.matchedTmdbEpisodeId!);
            const appliedIds = new Set(eligible.map((p) => p.episodeId));
            const releasedIds = quarantine?.reviewed
                ? []
                : (await getEpisodesHoldingTmdbIds(tx, seriesMediaId, targetIds)).filter(
                      (id) => !appliedIds.has(id),
                  );
            // Snapshot every change, including fuzzy matches and holders whose
            // positional identity is released without a replacement.
            const undo = new Map(
                (await getReconciliationUndoSnapshots(tx, [...appliedIds, ...releasedIds])).map(
                    (prev) => [prev.episode_id, prev],
                ),
            );
            if (undo.size !== appliedIds.size + releasedIds.length)
                throw new ReconciliationWriteRejected('Missing reconciliation undo snapshot');

            // Only connected identity dependencies share an undo group. Independent
            // corrections in this transaction remain independently undoable.
            const components = new Map([...undo.keys()].map((id) => [id, new Set([id])]));
            for (const p of eligible) {
                const holder = holderByTarget.get(p.matchedTmdbEpisodeId!);
                if (!holder || !components.has(holder)) continue;
                const merged = new Set([
                    ...components.get(p.episodeId)!,
                    ...components.get(holder)!,
                ]);
                for (const id of merged) components.set(id, merged);
            }
            const groupIds = new Map<string, string>();
            for (const members of components.values()) {
                if (members.size < 2 || groupIds.has([...members][0])) continue;
                const groupId = randomUUID();
                for (const id of members) groupIds.set(id, groupId);
            }
            for (const id of undo.keys())
                await catalogService.deleteExternalId(id, 'tmdb', 'episode');

            for (const episodeId of releasedIds) {
                const prev = undo.get(episodeId)!;
                await insertReconciliationMove(tx, {
                    seriesId: seriesMediaId,
                    episodeId,
                    service: 'filename-title',
                    evidence: 'released-positional-holder',
                    ghostId: null,
                    tmdbEpisodeId: prev.tmdb_id!,
                    prevTmdbEpisodeId: prev.tmdb_id,
                    groupId: groupIds.get(episodeId),
                    identityReleased: true,
                    fromParentId: prev.parent_id,
                    fromSeason: prev.season_number,
                    fromEpisode: prev.episode_number,
                    toParentId: prev.parent_id,
                    toSeason: prev.season_number,
                    toEpisode: prev.episode_number,
                    prevTitleBinding: prev.title_binding,
                    prevTitle: prev.title,
                    prevOverview: prev.overview,
                    prevStillPath: prev.still_path,
                    mergeStats: null,
                });
            }
            for (const p of eligible) {
                const extId: ExternalIdWrite = {
                    provider: 'tmdb',
                    id: p.matchedTmdbEpisodeId as string,
                    mediaType: 'episode',
                    source: 'reconciliation',
                };
                const written = await catalogService.upsertExternalId(p.episodeId, extId, true);
                if (!written)
                    throw new ReconciliationWriteRejected(
                        'Reconciliation identity write rejected; transaction rolled back',
                    );
                appliedExternalIds++;
                const overview = overviewById.get(p.matchedTmdbEpisodeId as string) ?? null;
                // RETURNING + count actual rows: the `NOT metadata_locked` guard can
                // match 0 rows if a row was locked between the preview snapshot and
                // here, so a blind increment would overcount updatedTitles.
                const updated = await tx<{ id: string }[]>`
                UPDATE media_items
                SET title = ${p.proposedTitle},
                    overview = COALESCE(${overview}, overview),
                    title_binding = 'identity',
                    updated_at = NOW()
                WHERE id = ${p.episodeId}
                  AND NOT metadata_locked
                RETURNING id
            `;
                if (updated.length !== 1)
                    throw new ReconciliationWriteRejected(
                        'Reconciliation title write rejected; transaction rolled back',
                    );
                const prev = undo.get(p.episodeId);
                if (prev)
                    await insertReconciliationMove(tx, {
                        seriesId: seriesMediaId,
                        episodeId: p.episodeId,
                        service: 'filename-title',
                        evidence:
                            p.source === 'filename'
                                ? p.confidence === 1
                                    ? 'unique-normalized-filename-title'
                                    : 'fuzzy-filename-title'
                                : 'chapter-title',
                        groupId: groupIds.get(p.episodeId),
                        ghostId: null,
                        tmdbEpisodeId: p.matchedTmdbEpisodeId!,
                        prevTmdbEpisodeId: prev.tmdb_id,
                        fromParentId: prev.parent_id,
                        fromSeason: prev.season_number,
                        fromEpisode: prev.episode_number,
                        toParentId: prev.parent_id,
                        toSeason: prev.season_number,
                        toEpisode: prev.episode_number,
                        prevTitleBinding: prev.title_binding,
                        prevTitle: prev.title,
                        prevOverview: prev.overview,
                        prevStillPath: prev.still_path,
                        mergeStats: null,
                    });
                appliedEpisodeIds.push(p.episodeId);
                for (const warning of quarantine?.entries.filter(
                    (e) =>
                        e.externalId === p.episodeId &&
                        (!quarantine?.reviewed ||
                            historicalProposalMatches(e, p, seriesMediaId, originalGroups)),
                ) ?? []) {
                    if (await resolveQuarantineSnapshot(tx, warning, quarantine!.actor))
                        resolvedQuarantineIds.push(warning.id);
                }
                updatedTitles += updated.length;
                if (updated.length > 0) await refreshSortTitles(tx, [p.episodeId]);
                // Persist the MATCHED episode's still_path so the thumbnail follows the
                // content-matched TMDB episode (getEpisodeStillPath prefers this over the
                // local season/episode number, which is wrong for non-TMDB-ordered releases).
                const stillPath = stillById.get(p.matchedTmdbEpisodeId as string);
                if (stillPath) {
                    // No `force` — applyReconciliation has no admin-force
                    // override anywhere in its call chain (the admin "reconcile
                    // this episode" HTTP endpoint calls it directly with no
                    // bypass input either); it already treats a locked episode
                    // as unavailable for identity re-binding above. Same lock
                    // guard as the sibling media_items UPDATE (C3, 2026-09-24
                    // security review — this write previously had none).
                    await upsertProviderMetadataUnlessLocked(tx, p.episodeId, 'tmdb', {
                        still_path: stillPath,
                    });
                }
            }
            committedEvidence = await getReconciliationEvidence(tx, seriesMediaId);
        });
    } catch (err) {
        if (!(err instanceof ReconciliationWriteRejected)) throw err;
        // Permutations release identities together. A rejected write rolls back
        // the entire plan, so none of its rows may be reported or resolved.
        logger.warn('Reconciliation plan rejected; all changes rolled back', { seriesMediaId });
        catalogEvidence.delete(catalog);
        return {
            appliedExternalIds: 0,
            updatedTitles: 0,
            appliedEpisodeIds: [],
            resolvedQuarantineIds: [],
        };
    }

    // Carry provenance forward only through our own validated, committed plan.
    // Ancillary still backfills can reuse the provider response in this same run,
    // but must compare against the resulting graph under locks again.
    if (committedEvidence) catalogEvidence.set(catalog, { ...origin, evidence: committedEvidence });

    for (const episodeId of appliedEpisodeIds) {
        try {
            await MediaLifecycleService.afterMetadataChanged(episodeId, ['title', 'overview'], sql);
        } catch (err) {
            logger.warn('afterMetadataChanged failed post-commit (non-fatal)', {
                episodeId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        try {
            const { getImageProxyService } =
                await import('$lib/server/services/image-proxy/index.js');
            getImageProxyService().invalidateCatalogImage(episodeId);
        } catch (err) {
            logger.warn('invalidateCatalogImage failed post-commit (non-fatal)', {
                episodeId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    if (updatedTitles > 0) {
        try {
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
            await cacheManager.for(CACHE_NAMESPACES.nextEpisode).clear();
            await cacheManager.for(CACHE_NAMESPACES.heroNextUp).clear();
            await cacheManager.for(CACHE_NAMESPACES.newEpisodes).clear();
        } catch (err) {
            logger.warn('Post-reconciliation cache clear failed (non-fatal)', {
                seriesMediaId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    logger.info('Applied episode reconciliation', {
        seriesMediaId,
        appliedExternalIds,
        updatedTitles,
    });
    return {
        appliedExternalIds,
        updatedTitles,
        appliedEpisodeIds,
        resolvedQuarantineIds,
        ...(pageChanged ? { pageChanged } : {}),
    };
}

// ============================================================================
// WS4 — reconciliation backfill / remap
// ============================================================================

/**
 * Quarantine provider tag used to namespace reconciliation backfill entries in
 * the shared `sync_quarantine` table. The (provider, external_id, media_type)
 * upsert key means re-running the backfill resurrects/refreshes the same row for
 * a still-ambiguous episode rather than piling up duplicates.
 */
const RECONCILE_QUARANTINE_PROVIDER = 'lumastra-reconcile';

function seriesIdOf(e: QuarantineEntry): string | null {
    const id = e.expectedSeriesId ?? payloadText(e.payload, 'seriesMediaId');
    return id && UUID_RE.test(id) ? id : null;
}

export interface BackfillSeriesResult {
    seriesMediaId: string;
    /** External-id bindings applied by the confident-match path. */
    appliedExternalIds: number;
    /** Titles rewritten by the confident-match path. */
    updatedTitles: number;
    /** Episodes parked in sync_quarantine for operator review (low confidence). */
    quarantined: number;
    resolvedQuarantineIds: string[];
    /** Historical warnings closed as obsolete rather than applied. */
    supersededQuarantineIds?: string[];
}

/**
 * Re-run the content matcher over a single existing series and act on the result:
 *   1. Apply confident matches (>= minConfidence) via {@link applyReconciliation}.
 *      That path already refuses to touch metadata_locked OR identity-bound rows
 *      (both are gated in the pure matcher and in the apply UPDATE), so historical
 *      confident matches are never overridden — only fragile positional/unbound
 *      titles get corrected.
 *   2. Quarantine episodes the matcher found a candidate for but could NOT commit
 *      confidently (below-threshold or duplicate-match) so an operator can review
 *      them. Quarantining is idempotent: the same still-ambiguous episode
 *      refreshes its existing `sync_quarantine` row instead of creating a new one.
 *
 * Idempotent + safe to re-run: a confident match flips the row to
 * title_binding='identity', so a later pass treats it as protected and leaves it
 * alone; an unresolved low-confidence row simply re-quarantines (no-op refresh).
 *
 * @param minConfidence   floor for auto-applying a match (clamped to [0.5, 1]).
 * @param quarantineFloor minimum candidate score to bother quarantining; matches
 *                        scoring below this are treated as noise and skipped.
 */
export async function backfillReconcileSeries(
    sql: postgres.Sql,
    seriesMediaId: string,
    opts: { minConfidence: number; quarantineFloor?: number; actor?: string } = {
        minConfidence: 0.9,
    },
): Promise<BackfillSeriesResult> {
    const minConfidence = Math.min(1, Math.max(0.5, opts.minConfidence));
    const quarantineFloor = Math.min(minConfidence, Math.max(0, opts.quarantineFloor ?? 0.5));
    const actor = opts.actor ?? 'reconciliation-backfill';

    // Capture warning versions before provider I/O, so a review made while the
    // catalog is loading cannot be overwritten by this run's old decision.
    const priorWarnings: QuarantineSnapshot[] = [];
    const initialSubjects = [
        ...new Set(
            (await getReconciliationGroups(sql, seriesMediaId)).flatMap((g) =>
                g.episodes.map((e) => e.episodeId),
            ),
        ),
    ];
    for (let i = 0; i < initialSubjects.length; i += 250) {
        priorWarnings.push(
            ...(await listQuarantineSnapshots(sql, {
                episodeIds: initialSubjects.slice(i, i + 250),
                limit: 1000,
                includeResolved: true,
            })),
        );
    }
    const catalog = await loadTmdbCatalog(sql, seriesMediaId);

    // Empty catalog = the series has no TMDB id OR TMDB was unavailable this
    // cycle. There is nothing to match against, so do NOT stamp the watermark —
    // stamping would defer this series for the entire stale window over a
    // transient TMDB outage. Leave it un-stamped so the next drain retries.
    if (catalog.length === 0) {
        logger.warn('Reconciliation backfill: empty TMDB catalog — skipping (no watermark)', {
            seriesMediaId,
        });
        return {
            seriesMediaId,
            appliedExternalIds: 0,
            updatedTitles: 0,
            quarantined: 0,
            resolvedQuarantineIds: [],
        };
    }

    // Compute proposals once at the quarantine threshold so a below-`minConfidence`
    // candidate still surfaces a (low) score we can decide to quarantine on.
    const { proposals } = await previewReconciliation(
        sql,
        seriesMediaId,
        { threshold: quarantineFloor },
        catalog,
    );
    // Duplicate demotion depends on the threshold: a weak competing match in
    // the quarantine preview may disappear at the application threshold.
    // Snapshot the actual prospective application subjects, not that lower preview.
    const prospective = await previewReconciliation(
        sql,
        seriesMediaId,
        { threshold: minConfidence },
        catalog,
    );
    const prospectiveIds = prospective.proposals
        .filter((p) => p.reason === 'matched' && p.changed && p.confidence >= minConfidence)
        .map((p) => p.episodeId);
    const warningsBefore = priorWarnings.filter(
        (e) => e.resolvedAt === null && prospectiveIds.includes(e.externalId),
    );

    // Capture each suspect's prior warning (including resolved rows/absence)
    // BEFORE acquiring media locks. The compare-and-write below cannot clobber
    // an intervening review, rewrite or revival.
    const hasProposal = (p: ReconcileProposal): boolean =>
        Boolean(p.proposedTitle || p.matchedTmdbEpisodeId);
    const noProposalCount = proposals.filter(
        (p) => p.reason === 'below-threshold' && !hasProposal(p),
    ).length;
    if (noProposalCount > 0) {
        logger.info('Reconciliation backfill: skipped results without a proposal', {
            seriesMediaId,
            noProposalCount,
        });
    }
    const suspects = proposals.filter(
        (p) =>
            hasProposal(p) &&
            ((p.reason === 'matched' &&
                p.confidence < minConfidence &&
                p.confidence >= quarantineFloor) ||
                p.reason === 'below-threshold' ||
                p.reason === 'duplicate-match'),
    );
    // 1. Apply confident matches (re-previews internally at minConfidence; reuses
    //    the loaded catalog so we don't re-hit the TMDB API).
    const applied = await applyReconciliation(
        sql,
        seriesMediaId,
        minConfidence,
        undefined,
        catalog,
        { entries: warningsBefore, actor },
    );

    const origin = catalogEvidence.get(catalog);
    let quarantined = 0;
    const supersededQuarantineIds: string[] = [];
    const invalidatedImages: string[] = [];
    if (origin) {
        // Suspects, stills and the completion watermark share the SAME final
        // validated graph. Any DB failure rolls the transaction back and propagates.
        quarantined = await withTx(sql, async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;
            await tx`SELECT set_config('lock_timeout', '10s', true)`;
            await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesMediaId})::bigint)`;
            await lockReconciliationEvidence(tx, seriesMediaId);
            if (
                origin.language !== config.TMDB_LANGUAGE ||
                (await getReconciliationEvidence(tx, seriesMediaId)).image !== origin.evidence.image
            )
                return 0;
            const groups = await getReconciliationGroups(tx, seriesMediaId);
            const live = new Map(groups.flatMap((g) => g.episodes).map((e) => [e.episodeId, e]));
            let count = 0;
            let allWarningsCurrent = true;
            for (const p of suspects) {
                if (applied.appliedEpisodeIds.includes(p.episodeId)) continue;
                const episode = live.get(p.episodeId);
                if (
                    !episode ||
                    isProtectedEpisode(episode) ||
                    episode.seasonLocked ||
                    episode.seriesLocked ||
                    episode.status !== 'active' ||
                    episode.seasonStatus !== 'active' ||
                    episode.seriesStatus !== 'active'
                )
                    continue;
                const wrote = await writeQuarantineSnapshot(
                    tx,
                    {
                        provider: RECONCILE_QUARANTINE_PROVIDER,
                        externalId: p.episodeId,
                        mediaType: 'episode',
                        expectedSeriesId: seriesMediaId,
                        payload: {
                            seriesMediaId,
                            seasonNumber: p.seasonNumber,
                            episodeNumber: p.episodeNumber,
                            currentTitle: p.currentTitle,
                            proposedTitle: p.proposedTitle,
                            matchedTmdbEpisodeId: p.matchedTmdbEpisodeId,
                            confidence: p.confidence,
                            source: p.source,
                        },
                        reason: `reconcile-backfill:${p.reason}`,
                        source: actor,
                    },
                    priorWarnings.find((e) => e.externalId === p.episodeId),
                );
                if (wrote === true) count++;
                else if (wrote !== 'hidden') allWarningsCurrent = false;
            }
            // Fresh matching under the validated graph closes historical noise, never
            // an intervening review or a warning rewritten while the catalog loaded.
            const freshProposals = new Map(
                computeReconciliationProposals(groups, catalog, {
                    threshold: quarantineFloor,
                }).map((p) => [p.episodeId, p]),
            );
            for (const warning of incompleteCatalogs.has(catalog) ? [] : priorWarnings) {
                const episode = live.get(warning.externalId);
                const proposal = freshProposals.get(warning.externalId);
                if (
                    warning.resolvedAt !== null ||
                    !warning.reason.startsWith('reconcile-backfill:') ||
                    seriesIdOf(warning) !== seriesMediaId ||
                    applied.resolvedQuarantineIds.includes(warning.id) ||
                    !proposal ||
                    hasProposal(proposal) ||
                    !episode ||
                    episode.metadataLocked ||
                    episode.seasonLocked ||
                    episode.seriesLocked ||
                    episode.status !== 'active' ||
                    episode.seasonStatus !== 'active' ||
                    episode.seriesStatus !== 'active'
                )
                    continue;
                if (await resolveCompletedProposal(tx, warning, seriesMediaId, actor)) {
                    applied.resolvedQuarantineIds.push(warning.id);
                    continue;
                }
                if (
                    await archiveQuarantineSnapshot(
                        tx,
                        warning,
                        `${actor}:superseded`,
                        'superseded',
                    )
                )
                    supersededQuarantineIds.push(warning.id);
                else allWarningsCurrent = false;
            }
            const stillByTmdbId = new Map(catalog.map((c) => [c.tmdbEpisodeId, c.stillPath]));
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal backfill of an exact locked series, with active hierarchy and protection guards
            const needStill = await tx<{ id: string; tmdb_id: string }[]>`
                SELECT ep.id, ei.external_id AS tmdb_id FROM media_items ep
                JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
                JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
                JOIN external_ids ei ON ei.media_id = ep.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
                WHERE series.id = ${seriesMediaId} AND ep.media_type = 'episode'
                    AND ep.status = 'active' AND season.status = 'active' AND series.status = 'active'
                    AND NOT ep.metadata_locked AND NOT season.metadata_locked AND NOT series.metadata_locked
                    AND NOT EXISTS (SELECT 1 FROM provider_metadata pm WHERE pm.media_id = ep.id
                        AND pm.provider = 'tmdb' AND pm.metadata ? 'still_path')
            `;
            for (const row of needStill) {
                const still = stillByTmdbId.get(row.tmdb_id);
                if (!still) continue;
                await upsertProviderMetadataUnlessLocked(tx, row.id, 'tmdb', { still_path: still });
                invalidatedImages.push(row.id);
            }
            if (allWarningsCurrent) await markSeriesBackfilled(tx, seriesMediaId);
            return count;
        });
    }
    // Cache invalidation is separately best-effort AFTER the DB commit.
    for (const id of invalidatedImages) {
        try {
            const { getImageProxyService } =
                await import('$lib/server/services/image-proxy/index.js');
            getImageProxyService().invalidateCatalogImage(id);
        } catch {
            /* cache expiry will recover */
        }
    }

    return {
        seriesMediaId,
        appliedExternalIds: applied.appliedExternalIds,
        updatedTitles: applied.updatedTitles,
        quarantined,
        resolvedQuarantineIds: [...applied.resolvedQuarantineIds, ...supersededQuarantineIds],
        supersededQuarantineIds,
    };
}

// ============================================================================
// Quarantine bulk triage (admin) + self-draining re-evaluation
// ============================================================================

/** True when a media_items row with this id still exists as an episode. */
async function episodeRowExists(sql: postgres.Sql, episodeId: string): Promise<boolean> {
    // Malformed identity is not evidence that a subject has gone.
    if (!UUID_RE.test(episodeId)) return true;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal quarantine maintenance lookup keyed by a specific UUID; not a user-facing/library-scoped query
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_items WHERE id = ${episodeId} AND media_type = 'episode' LIMIT 1
    `;
    return rows.length > 0;
}

export interface ReviewedQuarantinePage {
    ids: string[];
    fingerprint: string;
    continuation?: string;
}

export interface ReviewedQuarantineWarning {
    id: string;
    fingerprint: string;
    episodeId: string;
    currentTitle: string | null;
    currentTmdbEpisodeId: string | null;
    overview: string | null;
    stillPath: string | null;
    title: string;
    tmdbEpisodeId: string;
    seasonNumber: number;
    episodeNumber: number;
}

export interface AcceptQuarantinedMatchesResult {
    accepted: number;
    appliedExternalIds: number;
    updatedTitles: number;
    skipped: number;
    examined: number;
    blocked: number;
    continuation?: string;
    review?: ReviewedQuarantineWarning[];
    inspectableEpisodeIds?: string[];
    blockedReview?: {
        episodeId: string;
        title: string;
        target: string;
        reason: string;
        blockingEpisodeId?: string;
    }[];
    reviewedPage?: ReviewedQuarantinePage;
    pageChanged?: boolean;
}

/** JSONB may contain any JSON value; never coerce warning-owned objects. Raw
 * payloads remain untouched in the warning image used by every version fence. */
function payloadFields(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function payloadText(value: unknown, key: string): string {
    const field = payloadFields(value)[key];
    return typeof field === 'string' ? field : '';
}

function digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Bind all prospective writes, including provider overview/still values and
 * matching alternatives, to the immutable catalog captured before confirmation.
 */
function warningFingerprint(
    entry: QuarantineSnapshot,
    planDigest: string,
    proposal: ReconcileProposal,
): string {
    return digest([entry.rowVersion, entry.rowImage, planDigest, proposal]);
}

function pageFingerprint(
    seriesId: string,
    after: string | undefined,
    limit: number,
    continuation: string | undefined,
    entries: QuarantineSnapshot[],
): string {
    return digest([
        seriesId,
        after ?? null,
        limit,
        continuation ?? null,
        entries.map((e) => [e.id, e.rowVersion, e.rowImage]),
    ]);
}

function historicalProposalMatches(
    entry: QuarantineSnapshot,
    proposal: ReconcileProposal,
    seriesId: string,
    groups: ReconcileFileGroup[],
): boolean {
    const p = payloadFields(entry.payload);
    const episode = groups
        .flatMap((g) => g.episodes)
        .find((e) => e.episodeId === proposal.episodeId);
    return (
        entry.provider === RECONCILE_QUARANTINE_PROVIDER &&
        entry.mediaType === 'episode' &&
        entry.reason === 'reconcile-backfill:matched' &&
        entry.externalId === proposal.episodeId &&
        (entry.expectedSeriesId === null || entry.expectedSeriesId === seriesId) &&
        (p['seriesMediaId'] === undefined || p['seriesMediaId'] === seriesId) &&
        (entry.parentTmdbId === null || entry.parentTmdbId === episode?.seriesTmdbId) &&
        typeof p['matchedTmdbEpisodeId'] === 'string' &&
        /^[1-9][0-9]*$/.test(p['matchedTmdbEpisodeId']) &&
        p['matchedTmdbEpisodeId'] === proposal.matchedTmdbEpisodeId &&
        typeof p['proposedTitle'] === 'string' &&
        p['proposedTitle'].trim().length > 0 &&
        p['proposedTitle'] === proposal.proposedTitle &&
        isPostgresOrdinal(p['seasonNumber']) &&
        p['seasonNumber'] === proposal.seasonNumber &&
        episode?.parentSeasonNumber === p['seasonNumber'] &&
        isPostgresOrdinal(p['episodeNumber']) &&
        p['episodeNumber'] === proposal.episodeNumber &&
        (p['currentTitle'] === undefined || p['currentTitle'] === proposal.currentTitle) &&
        (p['source'] === undefined || p['source'] === proposal.source)
    );
}

export type EpisodeEligibilityBlocker =
    | 'manually-locked'
    | 'identity-bound'
    | 'inactive-episode'
    | 'inactive-season'
    | 'inactive-series'
    | 'locked-season'
    | 'locked-series'
    | 'inconsistent-season'
    | 'unreviewable-dependency';

/** The boolean eligibility and operator reason share exactly one predicate. */
export function episodeEligibilityBlocker(
    episode: ReconcileEpisodeRow | undefined,
): EpisodeEligibilityBlocker | null {
    if (!episode) return 'unreviewable-dependency';
    if (episode.metadataLocked) return 'manually-locked';
    if (episode.titleBinding === 'identity') return 'identity-bound';
    if (episode.status !== 'active') return 'inactive-episode';
    if (episode.seasonStatus !== 'active') return 'inactive-season';
    if (episode.seriesStatus !== 'active') return 'inactive-series';
    if (episode.seasonLocked) return 'locked-season';
    if (episode.seriesLocked) return 'locked-series';
    if (episode.parentSeasonNumber !== episode.seasonNumber) return 'inconsistent-season';
    return null;
}

function canApplyEpisode(episode: ReconcileEpisodeRow | undefined): boolean {
    return episodeEligibilityBlocker(episode) === null;
}

/** A confirmation reviews a fixed seed page, plus complete bounded dependency
 * components. Every release must belong to an actionable reviewed proposal.
 * Noncandidate holders are retained; displaying a holder cannot authorize a
 * destructive effect that has no proposal of its own.
 */
export async function acceptQuarantinedMatchesForSeries(
    sql: postgres.Sql,
    seriesMediaId: string,
    actor: string,
    opts: {
        after?: string;
        limit?: number;
        reviewed?: { id: string; fingerprint: string }[];
        reviewedPage?: ReviewedQuarantinePage;
        preview?: boolean;
    } = {},
): Promise<AcceptQuarantinedMatchesResult> {
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 250)));
    let seeds: QuarantineSnapshot[];
    let continuation: string | undefined;
    if (opts.preview) {
        const rows = await listQuarantineSnapshots(sql, {
            seriesId: seriesMediaId,
            after: opts.after,
            limit: limit + 1,
        });
        seeds = rows.slice(0, limit);
        continuation = rows.length > limit ? seeds[seeds.length - 1].id : undefined;
    } else {
        const page = opts.reviewedPage;
        // Never refill a shrinking preview page. Re-query only the exact seed
        // UUIDs that were reviewed, preserving their immutable upper bound.
        const rows = page
            ? await listQuarantineSnapshots(sql, {
                  seriesId: seriesMediaId,
                  warningIds: page.ids,
                  includeResolved: true,
                  limit: 1000,
              })
            : [];
        if (
            !page ||
            rows.length !== page.ids.length ||
            rows.some((r, i) => r.id !== page.ids[i] || r.resolvedAt !== null) ||
            page.fingerprint !==
                pageFingerprint(seriesMediaId, opts.after, limit, page.continuation, rows)
        ) {
            return {
                accepted: 0,
                appliedExternalIds: 0,
                updatedTitles: 0,
                skipped: 0,
                blocked: 0,
                examined: 0,
                pageChanged: true,
            };
        }
        seeds = rows;
        continuation = page.continuation;
    }
    const reviewedPage: ReviewedQuarantinePage = {
        ids: seeds.map((e) => e.id),
        fingerprint: pageFingerprint(seriesMediaId, opts.after, limit, continuation, seeds),
        ...(continuation ? { continuation } : {}),
    };
    const pageChanged = (): AcceptQuarantinedMatchesResult => ({
        accepted: 0,
        appliedExternalIds: 0,
        updatedTitles: 0,
        skipped: 0,
        blocked: 0,
        examined: 0,
        pageChanged: true,
    });
    if (
        !seeds.some(
            (entry) =>
                entry.mediaType === 'episode' && entry.reason === 'reconcile-backfill:matched',
        )
    ) {
        const result: AcceptQuarantinedMatchesResult = {
            accepted: 0,
            appliedExternalIds: 0,
            updatedTitles: 0,
            skipped: 0,
            examined: seeds.length,
            blocked: seeds.length,
            blockedReview: seeds.map((entry) => ({
                episodeId: entry.externalId,
                title: payloadText(entry.payload, 'proposedTitle'),
                target: payloadText(entry.payload, 'matchedTmdbEpisodeId'),
                reason: 'ineligible',
            })),
            ...(continuation ? { continuation } : {}),
        };
        if (opts.preview)
            return {
                ...result,
                review: [],
                reviewedPage,
                inspectableEpisodeIds: await listNavigableQuarantineEpisodes(
                    sql,
                    seeds
                        .filter((entry) => entry.mediaType === 'episode')
                        .map((entry) => entry.externalId),
                ),
            };
        return withTx(sql, async (tx) =>
            (await lockQuarantineSnapshots(tx, seeds)) ? result : pageChanged(),
        );
    }
    const catalog = await loadTmdbCatalog(sql, seriesMediaId);
    const evidenceImage = catalogEvidence.get(catalog)?.evidence.image ?? '';
    const planDigest = digest([evidenceImage, catalog]);
    const groups = await getReconciliationGroups(sql, seriesMediaId);
    const episodes = new Map(groups.flatMap((g) => g.episodes).map((e) => [e.episodeId, e]));
    const proposals = computeReconciliationProposals(groups, catalog, { threshold: 0 });
    const matched = new Map(
        proposals
            .filter((p) => p.reason === 'matched' && p.changed && p.matchedTmdbEpisodeId)
            .map((p) => [p.episodeId, p]),
    );
    const holders = await getReconciliationTargetHolders(
        sql,
        seriesMediaId,
        [...matched.values()].map((p) => p.matchedTmdbEpisodeId!),
    );
    const holderByTarget = new Map(holders.map((h) => [h.targetId, h.mediaId]));
    const selected = new Map<string, QuarantineSnapshot>();
    const selectedWarnings = new Set<string>();
    const blockedReasons = new Map<string, string>();
    const blockingEpisodes = new Map<string, string>();
    // Request-local cache includes known absence. A blocked prefix must not
    // poison a valid directed suffix, so only warning reads are memoized.
    const warningCache = new Map<string, QuarantineSnapshot | undefined>();
    for (const seed of seeds)
        if (seed.mediaType === 'episode') warningCache.set(seed.externalId, seed);
    const warningsFor = async (subjects: string[]): Promise<QuarantineSnapshot[]> => {
        const missing = subjects.filter((id) => !warningCache.has(id));
        for (let offset = 0; offset < missing.length; offset += 250) {
            const batch = missing.slice(offset, offset + 250);
            const rows = await listQuarantineSnapshots(sql, {
                seriesId: seriesMediaId,
                episodeIds: batch,
                limit: 1000,
            });
            for (const id of batch) warningCache.set(id, undefined);
            for (const row of rows) warningCache.set(row.externalId, row);
        }
        return subjects.flatMap((id) => {
            const warning = warningCache.get(id);
            return warning ? [warning] : [];
        });
    };
    for (const seed of seeds) {
        if (selectedWarnings.has(seed.id)) continue;
        if (seed.mediaType !== 'episode' || seed.reason !== 'reconcile-backfill:matched') {
            blockedReasons.set(seed.id, 'ineligible');
            continue;
        }
        const component = new Set<string>();
        let next: string | undefined = seed.externalId;
        let reason: string | undefined;
        while (next && !component.has(next)) {
            component.add(next);
            const episode = episodes.get(next);
            const proposal = matched.get(next);
            if (!canApplyEpisode(episode)) {
                reason = episodeEligibilityBlocker(episode) ?? 'unreviewable-dependency';
                break;
            }
            if (!proposal) {
                reason = 'unreviewable-dependency';
                break;
            }
            if (component.size > 1000) {
                reason = 'oversized-component';
                break;
            }
            const holder = holderByTarget.get(proposal.matchedTmdbEpisodeId!);
            next = holder && holder !== next ? holder : undefined;
        }
        if (!reason && new Set([...selected.keys(), ...component]).size > 1000)
            reason = 'batch-capacity';
        const warnings = reason ? [] : await warningsFor([...component]);
        if (!reason) {
            for (const id of component) {
                const warning = warnings.find((entry) => entry.externalId === id);
                if (!warning) {
                    reason = 'unreviewable-dependency';
                    next = id;
                    break;
                }
                if (!historicalProposalMatches(warning, matched.get(id)!, seriesMediaId, groups)) {
                    reason = 'changed-proposal';
                    next = id;
                    break;
                }
            }
        }
        if (reason) {
            if (next && next !== seed.externalId && UUID_RE.test(next))
                blockingEpisodes.set(seed.id, next);
            blockedReasons.set(seed.id, reason);
            continue;
        }
        for (const warning of warnings) {
            selected.set(warning.externalId, warning);
            selectedWarnings.add(warning.id);
        }
    }
    const entries = [...selected.values()];
    const providerValues = new Map(catalog.map((entry) => [entry.tmdbEpisodeId, entry]));
    const review = entries.map((entry): ReviewedQuarantineWarning => {
        const proposal = matched.get(entry.externalId)!;
        const episode = episodes.get(entry.externalId)!;
        return {
            id: entry.id,
            fingerprint: warningFingerprint(entry, planDigest, proposal),
            episodeId: entry.externalId,
            currentTitle: episode.currentTitle,
            currentTmdbEpisodeId: episode.tmdbEpisodeId,
            overview: providerValues.get(proposal.matchedTmdbEpisodeId!)?.overview ?? null,
            stillPath: providerValues.get(proposal.matchedTmdbEpisodeId!)?.stillPath ?? null,
            title: proposal.proposedTitle!,
            tmdbEpisodeId: proposal.matchedTmdbEpisodeId!,
            seasonNumber: proposal.seasonNumber!,
            episodeNumber: proposal.episodeNumber!,
        };
    });
    const blockedReview = seeds
        .filter((e) => !entries.some((entry) => entry.id === e.id))
        .map((e) => ({
            episodeId: e.externalId,
            title: payloadText(e.payload, 'proposedTitle'),
            target: payloadText(e.payload, 'matchedTmdbEpisodeId'),
            reason: blockedReasons.get(e.id) ?? 'ineligible',
            ...(blockingEpisodes.has(e.id)
                ? { blockingEpisodeId: blockingEpisodes.get(e.id) }
                : {}),
        }));
    const examined = new Set([...seeds, ...entries].map((e) => e.id)).size;
    const blocked = blockedReview.length;
    const paging = { examined, blocked, ...(continuation ? { continuation } : {}) };
    if (opts.preview)
        return {
            accepted: 0,
            appliedExternalIds: 0,
            updatedTitles: 0,
            skipped: 0,
            review,
            blockedReview,
            inspectableEpisodeIds: await listNavigableQuarantineEpisodes(sql, [
                ...review.map((entry) => entry.episodeId),
                ...seeds
                    .filter((entry) => entry.mediaType === 'episode')
                    .map((entry) => entry.externalId),
                ...blockedReview.flatMap((entry) =>
                    entry.blockingEpisodeId ? [entry.blockingEpisodeId] : [],
                ),
            ]),
            reviewedPage,
            ...paging,
        };
    const approved = new Map((opts.reviewed ?? []).map((e) => [e.id, e.fingerprint]));
    const authorized = entries.filter(
        (entry) =>
            approved.get(entry.id) ===
            warningFingerprint(entry, planDigest, matched.get(entry.externalId)!),
    );
    // Every submitted decision must still describe this exact immutable plan.
    // A stale decision cannot advance past its work merely because filtering
    // removes it from today's otherwise valid proposals.
    const currentAuthorizations = new Map(review.map((entry) => [entry.id, entry.fingerprint]));
    if (
        (opts.reviewed ?? []).some(
            (entry) => currentAuthorizations.get(entry.id) !== entry.fingerprint,
        )
    )
        return pageChanged();
    // Catalog I/O has finished. The complete seed page (retained warnings
    // included) and dependency warnings are now fenced with the media graph
    // in the same transaction that applies any authorized individual writes.
    const applied = await applyReconciliation(
        sql,
        seriesMediaId,
        0,
        authorized.map((entry) => entry.externalId),
        catalog,
        { entries: authorized, actor, reviewed: true, fenceEntries: [...seeds, ...entries] },
    );
    if (applied.pageChanged) return pageChanged();
    return {
        accepted: applied.resolvedQuarantineIds.length,
        appliedExternalIds: applied.appliedExternalIds,
        updatedTitles: applied.updatedTitles,
        skipped: entries.length - applied.resolvedQuarantineIds.length,
        blockedReview,
        ...paging,
    };
}

export interface RecheckQuarantineResult {
    examined: number;
    resolved: number;
    retained: number;
    continuation?: string;
    retainedReasons: Record<string, number>;
    retainedReview: { warningId: string; episodeId: string; reason: string }[];
}

export type CurrentMatchRetainedReason =
    | 'invalid-historical-proposal'
    | 'historical-target-unconfirmed'
    | 'missing-current-episode'
    | 'inactive-or-protected'
    | 'wrong-series-or-season'
    | 'wrong-series-tmdb'
    | 'wrong-episode-identity'
    | 'wrong-title-or-position'
    | 'no-default-file'
    | 'identity-bound'
    | 'not-position-bound';

export interface CurrentMatchReview {
    id: string;
    fingerprint: string;
    episodeId: string;
    proposedTitle: string | null;
    proposedTmdbEpisodeId: string | null;
    proposedSeasonNumber: number | null;
    proposedEpisodeNumber: number | null;
    currentTitle: string | null;
    currentTmdbEpisodeId: string | null;
    currentSeasonNumber: number | null;
    currentEpisodeNumber: number | null;
    currentSeriesId: string | null;
    titleBinding: string | null;
    eligible: boolean;
    retainedReason?: CurrentMatchRetainedReason;
}

export interface ConfirmCurrentMatchResult {
    examined: number;
    resolved: number;
    retained: number;
    continuation?: string;
    reviewedPage?: ReviewedQuarantinePage;
    review?: CurrentMatchReview[];
    pageChanged?: boolean;
}

function currentMatchReview(
    entry: QuarantineSnapshot,
    seriesId: string,
    current: QuarantineCurrentMatch | null,
    evidenceImage: string,
): CurrentMatchReview {
    const p = payloadFields(entry.payload);
    const target = typeof p['matchedTmdbEpisodeId'] === 'string' ? p['matchedTmdbEpisodeId'] : null;
    const title = typeof p['proposedTitle'] === 'string' ? p['proposedTitle'] : null;
    const season = isPostgresOrdinal(p['seasonNumber']) ? p['seasonNumber'] : null;
    const episode = isPostgresOrdinal(p['episodeNumber']) ? p['episodeNumber'] : null;
    let retainedReason: CurrentMatchRetainedReason | undefined;
    if (
        entry.provider !== RECONCILE_QUARANTINE_PROVIDER ||
        entry.mediaType !== 'episode' ||
        (entry.expectedSeriesId !== null && entry.expectedSeriesId !== seriesId) ||
        (entry.expectedSeriesId === null && p['seriesMediaId'] !== seriesId) ||
        (p['seriesMediaId'] !== undefined && p['seriesMediaId'] !== seriesId) ||
        !UUID_RE.test(entry.externalId) ||
        season === null ||
        episode === null ||
        !title?.trim()
    )
        retainedReason = 'invalid-historical-proposal';
    else if (
        entry.reason !== 'reconcile-backfill:matched' ||
        !target ||
        !/^[1-9][0-9]*$/.test(target)
    )
        retainedReason =
            entry.reason === 'reconcile-backfill:below-threshold' && !target
                ? 'historical-target-unconfirmed'
                : 'invalid-historical-proposal';
    else if (!current) retainedReason = 'missing-current-episode';
    else if (
        current.episodeStatus !== 'active' ||
        current.seasonStatus !== 'active' ||
        current.seriesStatus !== 'active' ||
        current.episodeLocked ||
        current.seasonLocked ||
        current.seriesLocked
    )
        retainedReason = 'inactive-or-protected';
    else if (
        current.seriesId !== seriesId ||
        current.episodeSeasonNumber !== season ||
        current.seasonNumber !== season ||
        current.episodeNumber !== episode
    )
        retainedReason = 'wrong-series-or-season';
    else if (entry.parentTmdbId !== null && current.seriesTmdbId !== entry.parentTmdbId)
        retainedReason = 'wrong-series-tmdb';
    else if (current.episodeTmdbId !== target) retainedReason = 'wrong-episode-identity';
    else if (current.title !== title) retainedReason = 'wrong-title-or-position';
    else if (current.defaultFileCount < 1) retainedReason = 'no-default-file';
    else if (current.titleBinding === 'identity') retainedReason = 'identity-bound';
    else if (current.titleBinding !== 'position') retainedReason = 'not-position-bound';

    return {
        id: entry.id,
        fingerprint: digest([entry.rowVersion, entry.rowImage, evidenceImage, current]),
        episodeId: entry.externalId,
        proposedTitle: title,
        proposedTmdbEpisodeId: target,
        proposedSeasonNumber: season,
        proposedEpisodeNumber: episode,
        currentTitle: current?.title ?? null,
        currentTmdbEpisodeId: current?.episodeTmdbId ?? null,
        currentSeasonNumber: current?.seasonNumber ?? null,
        currentEpisodeNumber: current?.episodeNumber ?? null,
        currentSeriesId: current?.seriesId ?? null,
        titleBinding: current?.titleBinding ?? null,
        eligible: retainedReason === undefined,
        ...(retainedReason ? { retainedReason } : {}),
    };
}

/** A selected acknowledgement of unchanged current metadata. It never changes
 * media or binding and never substitutes for the strict automatic recheck. */
export async function confirmQuarantinedCurrentMatchesForSeries(
    sql: postgres.Sql,
    seriesId: string,
    actor: string,
    opts: {
        after?: string;
        limit?: number;
        preview: boolean;
        reviewed?: { id: string; fingerprint: string }[];
        reviewedPage?: ReviewedQuarantinePage;
    },
): Promise<ConfirmCurrentMatchResult> {
    const dispositionBatchId = randomUUID();
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 100)));
    const all = await listQuarantineSnapshots(sql, {
        seriesId,
        after: opts.after,
        limit: limit + 1,
    });
    const entries = all.slice(0, limit);
    const continuation = all.length > limit ? entries[entries.length - 1]?.id : undefined;
    const subjects = entries.map((entry) => entry.externalId).filter((id) => UUID_RE.test(id));
    const evidence = await getReconciliationEvidence(sql, seriesId, subjects);
    const reviewedPage: ReviewedQuarantinePage = {
        ids: entries.map((entry) => entry.id),
        fingerprint: digest([
            pageFingerprint(seriesId, opts.after, limit, continuation, entries),
            evidence.image,
        ]),
        ...(continuation ? { continuation } : {}),
    };
    const review: CurrentMatchReview[] = [];
    for (const entry of entries) {
        const current = UUID_RE.test(entry.externalId)
            ? await getQuarantineCurrentMatch(sql, entry.externalId)
            : null;
        review.push(currentMatchReview(entry, seriesId, current, evidence.image));
    }
    if (opts.preview)
        return {
            examined: entries.length,
            resolved: 0,
            retained: entries.length,
            ...(continuation ? { continuation } : {}),
            reviewedPage,
            review,
        };
    const stale = (): ConfirmCurrentMatchResult => ({
        examined: 0,
        resolved: 0,
        retained: 0,
        pageChanged: true,
    });
    if (
        !opts.reviewedPage ||
        opts.reviewedPage.fingerprint !== reviewedPage.fingerprint ||
        opts.reviewedPage.continuation !== continuation ||
        JSON.stringify(opts.reviewedPage.ids) !== JSON.stringify(reviewedPage.ids)
    )
        return stale();
    const approved = new Map((opts.reviewed ?? []).map((item) => [item.id, item.fingerprint]));
    if (
        approved.size === 0 ||
        approved.size !== opts.reviewed?.length ||
        [...approved].some(
            ([id, fingerprint]) =>
                !review.some(
                    (item) => item.id === id && item.fingerprint === fingerprint && item.eligible,
                ),
        )
    )
        return stale();
    try {
        return await withTx(sql, async (tx) => {
            await tx`SELECT set_config('lock_timeout', '10s', true)`;
            await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesId})::bigint)`;
            await lockQuarantineEvidence(tx, evidence);
            if (
                !(await lockQuarantineSnapshots(tx, entries)) ||
                (await getReconciliationEvidence(tx, seriesId, subjects)).image !== evidence.image
            )
                throw new Error('current-match-stale');
            for (const entry of entries) {
                const current = UUID_RE.test(entry.externalId)
                    ? await getQuarantineCurrentMatch(tx, entry.externalId)
                    : null;
                const fresh = currentMatchReview(entry, seriesId, current, evidence.image);
                const expected = review.find((item) => item.id === entry.id);
                if (
                    !expected ||
                    fresh.fingerprint !== expected.fingerprint ||
                    fresh.eligible !== expected.eligible
                )
                    throw new Error('current-match-stale');
            }
            for (const entry of entries) {
                if (!approved.has(entry.id)) continue;
                if (
                    !(await archiveQuarantineSnapshot(
                        tx,
                        entry,
                        actor,
                        'hidden',
                        'dismissed',
                        dispositionBatchId,
                    ))
                )
                    throw new Error('current-match-stale');
                const after = await getQuarantineSnapshot(tx, entry.id);
                await insertAdminAuditEvent(tx, {
                    instanceId: config.INSTANCE_ID,
                    actor,
                    action: 'confirmed_current_match',
                    target: entry.id,
                    outcome: 'ok',
                    detail: {
                        operation: 'confirmed_current_match',
                        before: entry.rowImage,
                        after: after?.rowImage ?? null,
                        currentMediaEvidenceFingerprint: digest(evidence.image),
                        review: review.find((item) => item.id === entry.id),
                    },
                });
            }
            return {
                examined: entries.length,
                resolved: approved.size,
                retained: entries.length - approved.size,
                ...(continuation ? { continuation } : {}),
            };
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'current-match-stale') return stale();
        throw error;
    }
}

/** Verify a historical ordinary proposal against locked live evidence. No
 * provider calls and no catalog writes: title equality alone is never enough.
 */
function isPostgresOrdinal(value: unknown): value is number {
    return (
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647
    );
}

async function resolveCompletedProposal(
    sql: postgres.Sql,
    entry: QuarantineSnapshot,
    seriesId: string,
    actor: string,
    batchId?: string,
): Promise<boolean> {
    const p = payloadFields(entry.payload);
    if (
        entry.reason !== 'reconcile-backfill:matched' ||
        entry.mediaType !== 'episode' ||
        (entry.expectedSeriesId !== null && entry.expectedSeriesId !== seriesId) ||
        (p['seriesMediaId'] !== undefined && p['seriesMediaId'] !== seriesId) ||
        typeof p['matchedTmdbEpisodeId'] !== 'string' ||
        !/^[1-9][0-9]*$/.test(p['matchedTmdbEpisodeId']) ||
        typeof p['proposedTitle'] !== 'string' ||
        p['proposedTitle'].trim().length === 0 ||
        !isPostgresOrdinal(p['seasonNumber']) ||
        !isPostgresOrdinal(p['episodeNumber'])
    )
        return false;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only maintenance verifies one exact episode and expected hierarchy under evidence locks
    const [evidence] = await sql<{ id: string }[]>`
        SELECT ep.id FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
        JOIN external_ids ei ON ei.media_id = ep.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
        WHERE ep.id::text = ${entry.externalId} AND ep.media_type = 'episode'
          AND series.id = ${seriesId} AND ep.status = 'active' AND season.status = 'active' AND series.status = 'active'
          AND NOT ep.metadata_locked AND NOT season.metadata_locked AND NOT series.metadata_locked
          AND ep.title_binding = 'identity' AND ep.title = ${p['proposedTitle']}
          AND ei.external_id = ${p['matchedTmdbEpisodeId']}
          AND ep.season_number = ${p['seasonNumber']} AND season.season_number = ${p['seasonNumber']}
          AND ep.episode_number = ${p['episodeNumber']}
          AND (${entry.parentTmdbId}::text IS NULL OR EXISTS (
              SELECT 1 FROM external_ids se WHERE se.media_id = series.id AND se.provider = 'tmdb'
                AND se.media_type = 'tv' AND se.external_id = ${entry.parentTmdbId}
          ))
          AND EXISTS (SELECT 1 FROM media_file_items mfi JOIN media_files mf ON mf.id = mfi.file_id
              WHERE mfi.media_item_id = ep.id AND mfi.is_default AND NOT mf.is_missing)
    `;
    return (
        !!evidence &&
        (await archiveQuarantineSnapshot(sql, entry, actor, 'completed', 'reattached', batchId))
    );
}

/** Retire only the historical writer's explicit no-proposal result. Unknown,
 * malformed, collision and provider-conflict warnings remain choices. A live
 * active, unlocked hierarchy and a default physical file are required. */
async function retireHistoricalNoProposal(
    sql: postgres.Sql,
    entry: QuarantineSnapshot,
    seriesId: string,
    actor: string,
    batchId?: string,
): Promise<boolean> {
    const p = payloadFields(entry.payload);
    if (
        entry.provider !== RECONCILE_QUARANTINE_PROVIDER ||
        entry.mediaType !== 'episode' ||
        entry.reason !== 'reconcile-backfill:below-threshold' ||
        !UUID_RE.test(entry.externalId) ||
        p['seriesMediaId'] !== seriesId ||
        (entry.expectedSeriesId !== null && entry.expectedSeriesId !== seriesId) ||
        p['proposedTitle'] !== null ||
        p['matchedTmdbEpisodeId'] !== null ||
        p['confidence'] !== 0 ||
        typeof p['currentTitle'] !== 'string' ||
        !isPostgresOrdinal(p['seasonNumber']) ||
        !isPostgresOrdinal(p['episodeNumber'])
    )
        return false;
    const current = await getQuarantineCurrentMatch(sql, entry.externalId);
    if (
        !current ||
        current.seriesId !== seriesId ||
        current.episodeStatus !== 'active' ||
        current.seasonStatus !== 'active' ||
        current.seriesStatus !== 'active' ||
        current.episodeLocked ||
        current.seasonLocked ||
        current.seriesLocked ||
        current.defaultFileCount === 0 ||
        current.title !== p['currentTitle'] ||
        current.seasonNumber !== p['seasonNumber'] ||
        current.episodeSeasonNumber !== p['seasonNumber'] ||
        current.episodeNumber !== p['episodeNumber'] ||
        (entry.parentTmdbId !== null && current.seriesTmdbId !== entry.parentTmdbId)
    )
        return false;
    return archiveQuarantineSnapshot(sql, entry, actor, 'no-proposal', 'dismissed', batchId);
}

/** Stable immutable-id keyset traversal survives removals and same-row rewrites.
 * A retained ambiguous row is passed once, so it cannot starve later candidates.
 */
export async function recheckQuarantinedMatchesForSeries(
    sql: postgres.Sql,
    seriesId: string,
    actor: string,
    opts: { after?: string; limit?: number } = {},
): Promise<RecheckQuarantineResult> {
    const batchId = randomUUID();
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 250)));
    const all = await listQuarantineSnapshots(sql, {
        seriesId,
        after: opts.after,
        limit: limit + 1,
    });
    const entries = all.slice(0, limit);
    let resolved = 0;
    const subjects = entries.map((entry) => entry.externalId).filter((id) => UUID_RE.test(id));
    const evidence = await getReconciliationEvidence(sql, seriesId, subjects);
    const resolvedIds = new Set<string>();
    let evidenceChanged = false;
    if (entries.length > 0)
        await withTx(sql, async (tx) => {
            await tx`SELECT set_config('lock_timeout', '10s', true)`;
            await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesId})::bigint)`;
            await lockQuarantineEvidence(tx, evidence);
            if (
                (await getReconciliationEvidence(tx, seriesId, subjects)).image !== evidence.image
            ) {
                evidenceChanged = true;
                return;
            }
            for (const entry of entries) {
                if (await resolveCompletedProposal(tx, entry, seriesId, actor, batchId)) {
                    resolved++;
                    resolvedIds.add(entry.id);
                }
            }
        });
    const retainedReview: RecheckQuarantineResult['retainedReview'] = [];
    const retainedReasons: Record<string, number> = {};
    for (const entry of entries) {
        if (resolvedIds.has(entry.id)) continue;
        const current = UUID_RE.test(entry.externalId)
            ? await getQuarantineCurrentMatch(sql, entry.externalId)
            : null;
        const projection = currentMatchReview(entry, seriesId, current, evidence.image);
        const reason = evidenceChanged
            ? 'changed-during-recheck'
            : projection.eligible
              ? 'position-bound-current-match'
              : projection.retainedReason === 'identity-bound'
                ? 'changed-warning-or-evidence'
                : (projection.retainedReason ?? 'invalid-historical-proposal');
        retainedReasons[reason] = (retainedReasons[reason] ?? 0) + 1;
        retainedReview.push({ warningId: entry.id, episodeId: entry.externalId, reason });
    }
    return {
        examined: entries.length,
        resolved,
        retained: entries.length - resolved,
        retainedReasons,
        retainedReview,
        ...(all.length > limit ? { continuation: entries[entries.length - 1].id } : {}),
    };
}

/** Default cap on rows examined per `reevaluateQuarantineBacklog` run. */
const DEFAULT_QUARANTINE_REEVAL_CAP = 500;

export interface QuarantineReevalResult {
    /** Unresolved reconcile-backfill rows examined this run (bounded by `cap`). */
    rowsExamined: number;
    /** Resolved 'dismissed' because the backing episode row no longer exists. */
    dismissedGone: number;
    /** Distinct series re-matched via a fresh `backfillReconcileSeries` pass. */
    seriesRevisited: number;
    /** Rows that were unresolved before the series re-match and resolved after it (i.e. reattached by the fresh match). */
    reattached: number;
    continuation?: string;
    failedSeries: number;
    noProposalRetired: number;
}

/**
 * Self-draining re-evaluation pass for the reconciliation-backfill quarantine
 * backlog. Runs on the task's full drain (see reconciliation-backfill.ts)
 * and does two things a plain re-run of the series drain does NOT do on its
 * own:
 *
 *   1. Dismisses rows whose quarantined episode no longer exists (deleted file,
 *      merged/re-identified series, etc). `backfillReconcileSeries` only ever
 *      re-quarantines episodes it still finds in the series' current episode
 *      list — a since-deleted episode's stale row is invisible to it and would
 *      otherwise linger unresolved forever.
 *   2. Re-runs the matcher (`backfillReconcileSeries`) for every series that
 *      still carries unresolved reconcile-backfill rows, OUTSIDE that series'
 *      normal 7-day `reconcile_backfill_at` watermark cadence — a confident
 *      match (new TMDB data, a corrected chapter set, etc) doesn't have to
 *      wait out the stale window to auto-resolve its quarantine rows.
 *
 * Rows with an ambiguous proposal stay unresolved until safely applied or
 * reviewed. Validated historical no-proposal rows retire into recoverable
 * history. New no-match results are logged instead of re-quarantined.
 * warningOnly reuses this traversal for scheduled receipt-only cleanup without
 * provider calls, media writes or missing-subject inference.
 *
 * Bounded by `cap` (default {@link DEFAULT_QUARANTINE_REEVAL_CAP}) rows
 * examined per call so a large backlog can't turn one run into an unbounded
 * sweep. The task persists the immutable-id continuation between runs; a
 * retained ambiguous row cannot keep later rows out of reach.
 */
export async function reevaluateQuarantineBacklog(
    sql: postgres.Sql,
    opts: {
        cap?: number;
        actor?: string;
        after?: string;
        warningOnly?: boolean;
        signal?: AbortSignal;
    } = {},
): Promise<QuarantineReevalResult> {
    const cap = Math.max(1, Math.min(1000, opts.cap ?? DEFAULT_QUARANTINE_REEVAL_CAP));
    const actor = opts.actor ?? 'reconciliation-backfill';

    const result: QuarantineReevalResult = {
        rowsExamined: 0,
        dismissedGone: 0,
        seriesRevisited: 0,
        reattached: 0,
        failedSeries: 0,
        noProposalRetired: 0,
    };

    const all = await listQuarantineSnapshots(sql, { after: opts.after, limit: cap + 1 });
    const entries = all.slice(0, cap);
    if (all.length > cap) result.continuation = entries[entries.length - 1].id;
    result.rowsExamined = entries.length;
    if (entries.length === 0) return result;

    // Pass 1: dismiss rows whose episode row is gone. Cheap (one lookup per
    // row, no TMDB calls) — do this before touching any series so a deleted
    // episode never gets swept into the (expensive) re-match pass below.
    const goneBatchId = randomUUID();
    const stillLive: QuarantineSnapshot[] = [];
    for (const entry of entries) {
        if (opts.signal?.aborted) return result;
        if (opts.warningOnly) {
            stillLive.push(entry);
            continue;
        }
        const exists = await episodeRowExists(sql, entry.externalId);
        if (exists) {
            stillLive.push(entry);
            continue;
        }
        try {
            if (
                await archiveQuarantineSnapshot(
                    sql,
                    entry,
                    `${actor}:auto-dismiss-episode-gone`,
                    'gone',
                    'dismissed',
                    goneBatchId,
                )
            )
                result.dismissedGone++;
        } catch {
            // Already resolved by an admin between the list and this call — benign.
        }
    }

    // Pass 2: re-run the matcher for every distinct series still carrying a
    // live unresolved row, outside the normal watermark cadence.

    const seriesIds = new Set<string>();
    for (const entry of stillLive) {
        const seriesId = seriesIdOf(entry);
        if (seriesId) seriesIds.add(seriesId);
    }

    for (const seriesId of seriesIds) {
        if (opts.signal?.aborted) break;
        const completedBatchId = randomUUID();
        const noProposalBatchId = randomUUID();
        const beforeIds = new Set(
            stillLive.filter((e) => seriesIdOf(e) === seriesId).map((e) => e.id),
        );
        try {
            // Same defaults reconciliation-backfill.ts uses when the caller
            // doesn't override them (DEFAULT_MIN_CONFIDENCE / DEFAULT_QUARANTINE_FLOOR
            // there) — this pass re-runs the identical matcher, just off-cadence.
            const applied = opts.warningOnly
                ? { resolvedQuarantineIds: [], supersededQuarantineIds: [] }
                : await backfillReconcileSeries(sql, seriesId, {
                      minConfidence: 0.9,
                      quarantineFloor: 0.5,
                      actor: `${actor}:reeval`,
                  });
            result.seriesRevisited++;

            const resolvedIds = new Set(applied.resolvedQuarantineIds);
            const retiredIds = new Set<string>();
            // Completed historical decisions have no new matcher write. Recheck
            // this exact page as well, without loading an unbounded series list.
            const page = stillLive.filter((e) => seriesIdOf(e) === seriesId);
            const subjects = page.map((e) => e.externalId).filter((id) => UUID_RE.test(id));
            const evidence = await getReconciliationEvidence(sql, seriesId, subjects);
            await withTx(sql, async (tx) => {
                await tx`SELECT set_config('lock_timeout', '10s', true)`;
                await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesId})::bigint)`;
                await lockQuarantineEvidence(tx, evidence);
                if (
                    (await getReconciliationEvidence(tx, seriesId, subjects)).image !==
                    evidence.image
                )
                    return;
                for (const entry of page) {
                    if (opts.signal?.aborted) break;
                    if (
                        await resolveCompletedProposal(
                            tx,
                            entry,
                            seriesId,
                            `${actor}:reeval`,
                            completedBatchId,
                        )
                    )
                        resolvedIds.add(entry.id);
                    else if (
                        await retireHistoricalNoProposal(
                            tx,
                            entry,
                            seriesId,
                            `${actor}:reeval`,
                            noProposalBatchId,
                        )
                    )
                        retiredIds.add(entry.id);
                }
            });
            result.noProposalRetired += retiredIds.size;
            const superseded = new Set(applied.supersededQuarantineIds);
            for (const id of beforeIds)
                if (resolvedIds.has(id) && !superseded.has(id)) result.reattached++;
        } catch (err) {
            result.failedSeries++;
            logger.warn(
                'Quarantine re-evaluation: series failed; retained for next bounded traversal',
                {
                    seriesId,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
            // Advance only the independent traversal position. Failed rows are
            // still unresolved and are retried on the next complete keyset cycle.
            // This needs constant-size cursor state and never rescans a prefix
            // until the tail has been reached. Top-level/request failures still
            // reject, so the task keeps the previous cursor in that case.
        }
    }

    return result;
}

export type { BackfillSeriesCandidate };

/**
 * Page through backfill candidate series. Thin re-export wrapper so the task
 * layer depends only on the service, not directly on the query module.
 */
export async function listReconcileBackfillCandidates(
    sql: postgres.Sql,
    opts: { limit: number; staleOnly: boolean; staleBefore: Date },
): Promise<BackfillSeriesCandidate[]> {
    return listBackfillSeriesCandidates(sql, opts);
}
