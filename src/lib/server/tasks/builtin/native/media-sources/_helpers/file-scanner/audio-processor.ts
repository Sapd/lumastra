// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Audio file processor for the file scanner.
 *
 * Handles the artist → album → track hierarchy creation, album art persistence,
 * MusicBrainz cover art fetching, and collaboration artist merging.
 */

import path from 'node:path';
import { persistAlbumReleaseIdentifiers } from '$lib/server/database/queries/album-local-art.queries.js';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import { backfillMusicNfo } from './music-nfo-backfill.js';
import {
    VARIOUS_ARTISTS_LABEL,
    VARIOUS_ARTISTS_ALIASES,
    COMPILATION_ARTIST_THRESHOLD,
} from '$lib/shared/various-artists.js';
import type postgres from 'postgres';
import { isTrack } from '$lib/server/utils/media-types.js';
import type { FileScannerContext } from './shared.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import { parseAudioTags, hasReplacementChar, trackTitleSource } from './audio-tag-parser.js';
import { findExistingFolderAlbum } from './album-folder-resolver.js';
import { albumArtistDecision, alignFolderAlbumParent } from './album-artist-evidence.js';
import { normalizeAlbumArtist, type AlbumArtistDecision } from './album-artist-rule.js';
import { resolveFolderAlbumArtist } from './folder-album-artist.js';
import { walkArtwork, isAudioFile } from '../../../../../../utils/walk-directory.js';
import {
    insertScannedMediaItem,
    findOrCreateMusicArtist,
    findOrCreateMusicAlbum,
    findMusicArtistByName,
} from '../../../../../../database/queries/media-items.queries.js';
import { extractRemixerCandidates } from '$lib/shared/remix-credit.js';
import { VERSION_ONLY_SQL_PATTERN } from '$lib/shared/music-title-normalize.js';
import {
    upsertMediaFile,
    attachFileToItem,
    touchLibraryAddedAt,
    findAllLinkedMediaItemsByFilePath,
    findTrackIdsWithUnverifiedTitleSourceByFilePath,
    findMediaFileByPath,
    updateFileStat,
    recordFileScanIssue,
    clearFileScanIssue,
    getFileScanRetryAt,
    propagateHasFiles,
    recomputeHasFilesBatch,
    type KnownFileRow,
} from '../../../../../../database/queries/media-files.queries.js';
import { config } from '$lib/server/config.js';
import { refreshSortTitles } from '$lib/server/database/queries/sort-title.queries.js';
import {
    getLocalArtwork,
    getOwnLocalArtwork,
    deleteArtworkById,
} from '../../../../../../database/queries/media-artwork.queries.js';
import {
    restoreScannedFile,
    initFileChangeDetection,
    tryHashFileHead,
    sniffNewFileForScan,
    sniffContentChangeForScan,
    clearStaleRefusalAndEnsureChangeDetection,
    filesAllMissingFromLibrary,
} from './shared.js';
import { detectFileChanges } from './change-detection.js';
import { applySidecarLyricsToTrack } from './lyrics-sidecar.js';
import {
    parseArtistNames,
    resolveArtistCredit,
    countArtistCreditAtoms,
    NO_ARTIST_CREDIT_EVIDENCE,
    type ArtistCreditEvidence,
} from './artist-credit.js';
import { getArtistCreditEvidence } from './artist-credit-evidence.js';
import {
    resolveAlbumDir,
    extractYearFromFolder,
    findSidecarLyrics,
    cleanAlbumTitle,
    splitDiscSuffix,
    folderAlbumTitle,
    deriveArtistName,
    parseVAFolderPattern,
    isCompilationArtistName,
    normalizeUnderscoreStem,
    spaceUnderscoreWords,
    trackNumberFromFilename,
} from '../../../../../../utils/music-scanner-utils.js';
import {
    hasValidOwnPoster,
    isSharedAlbumDir,
    persistAlbumArt,
    isPathUnder,
    findAlbumFolderPoster,
} from '$lib/server/services/album-local-art.js';
import {
    findCollaborationArtists,
    getTrackIdsForArtist,
    getTrackIdsReferencingArtistId,
    getAlbumsForArtist,
    deleteEmptyAlbum,
    mergeAdditionalArtistIds,
    replaceArtistIdInTracks,
    dedupeAdditionalArtistIds,
    deleteEmptyArtist,
} from '../../../../../../database/queries/artist-merge.queries.js';
import { assessFilePresence } from '../../../../../../utils/file-presence.js';
import { hashFileHead } from '$lib/server/utils/file-hash.js';
import { withTx } from '../../../../../../database/with-tx.js';
import {
    reconcileTrackArtistCredits,
    reconcileTitleRemixerMembership,
} from '$lib/server/services/music/artist-credit-ingestion.js';
import {
    findReclaimableByHash,
    findActiveItemByLiveHeadHash,
    findTracksWithFilesByIdentity,
    undismissMediaItem,
} from '../../../../../../database/queries/file-rematch.queries.js';
import type { ReclaimCandidate } from '../../../../../../database/queries/file-rematch.queries.js';
import { MediaLifecycleService } from '../../../../../../services/media-lifecycle.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Artist-credit splitting lives in `artist-credit.ts` (evidence-based since the
// "Rob & Chris" → "Rob", "Chris" over-split); re-exported for existing importers.
export { parseArtistNames };

/**
 * Resolve the list of distinct artist names for a tag pair. Prefers a
 * properly-tagged multi-value array (Vorbis multi-ARTIST, ID3v2.4
 * null-separated TPE1, etc.); falls back to resolving the scalar string with
 * `resolveArtistCredit` against the library's evidence (no evidence → every
 * ambiguous "A & B" group stays whole). Returns null when nothing usable is
 * present.
 */
export function resolveArtistNamesFromTags(
    multiValue: string[] | undefined,
    scalar: string | undefined,
    evidence: ArtistCreditEvidence = NO_ARTIST_CREDIT_EVIDENCE,
): string[] | null {
    // Tags stored by a scan before the parser spaced "Corin_Vale" are
    // spaced here too, or the per-scan relink would re-create the old row.
    const cleaned = (multiValue ?? [])
        .map((s) => (typeof s === 'string' ? spaceUnderscoreWords(s.trim()) : ''))
        .filter((s) => s.length > 0);
    if (cleaned.length > 1) return cleaned;
    // Degraded multi-value (≤1 usable entry): fall through and let the
    // scalar / single-survivor path drive resolveArtistCredit so we don't lose
    // tag info encoded as a single delimited string.
    const value = (cleaned[0] || spaceUnderscoreWords(scalar?.trim() ?? '')).trim();
    if (!value) return null;
    return resolveArtistCredit(value, evidence);
}

// ---------------------------------------------------------------------------
// Artist links
// ---------------------------------------------------------------------------

export async function ensureTrackArtistLinks(
    sql: postgres.Sql,
    trackId: string,
    context: FileScannerContext,
    libraryGroupId?: string | null,
): Promise<void> {
    const changed = await reconcileTrackArtistCredits(sql, trackId, {
        libraryGroupId,
        evidence: await getArtistCreditEvidence(sql),
    });
    if (changed) context.logger.debug('[FileScanner] Reconciled track artist credits', { trackId });
}

// ---------------------------------------------------------------------------
// Collaboration Artist Merge
// ---------------------------------------------------------------------------

/**
 * Post-scan pass: find artist records whose title is actually a collaboration
 * credit (feat., ft., &, +, vs., und) and merge them into the base (primary)
 * artist. Albums under the collaboration artist are re-parented, and the
 * secondary artist ids are added to each track's
 * custom_metadata.additional_artist_ids so the track still appears when browsing
 * the secondary artist. Rows flagged `custom_metadata.no_split = true` are
 * excluded by `findCollaborationArtists` (single acts like "Above & Lanterns").
 *
 * Compilation tracks credit the collaboration artist only through
 * additional_artist_ids (their album sits under Various Artists), so those
 * references are remapped from the combined row to the split artists before the
 * combined row is deleted — otherwise they'd be left pointing at a dead id.
 */
export async function mergeCollaborationArtists(
    sql: postgres.Sql,
    context: FileScannerContext,
): Promise<number> {
    const collabArtists = await findCollaborationArtists(sql);
    if (collabArtists.length === 0) return 0;
    // Decide on the COMPLETE library, including everything this scan just
    // inserted — and refresh the shared snapshot for the passes after this one.
    const evidence = await getArtistCreditEvidence(sql, { fresh: true });
    let mergedCount = 0;

    for (const collab of collabArtists) {
        // A legacy mega-credit ("A, B, C, ..., Pinball X Topmodelz, ..., Z") can
        // carry a collab marker deep inside a comma list. The resolver splits
        // at that marker and returns just the two halves, so merging
        // here would create two giant bogus artist rows out of one compilation.
        // Comma count is the honest signal for "this is a sampler tracklist, not
        // a collaboration" — hand those to `mergeOversizedCompilationArtists`,
        // which collapses them to Various Artists. A real collab with internal
        // commas ("Crosby, Stills & Nash") is nowhere near the threshold.
        if (collab.title.split(',').length >= COMPILATION_ARTIST_THRESHOLD) continue;

        // An ambiguous "A & B" row is split only where the library proves a part
        // is an artist in its own right (`artist-credit.ts`); "Rob & Chris",
        // "Harris & Ford", "Echo & the Bunnymen" stay one row.
        const names = resolveArtistCredit(collab.title, evidence);
        if (names.length <= 1) continue;

        // The comma count above cannot see a sampler credit joined by
        // something else, and `findCollaborationArtists` matches far more than
        // commas: &, +, feat., ft., featuring, vs., x, und. So "A & B & C & D
        // & E & F" carries zero commas, sails past that guard, and is split as
        // if it were a two-artist collaboration — taking EVERY album of the row
        // to whoever happens to be named first.
        //
        // That is how one legitimate artist row came to parent 190
        // compilations on the production library. It was created from its own
        // artist.nfo the day before, so `findOrCreateMusicArtist(names[0])`
        // found it rather than creating anything, and 190 albums that belong
        // under Various Artists moved onto a real artist who appears on
        // exactly none of them. It then rendered as the #1 Top Artist with
        // "190 albums", more than double the next-largest.
        //
        // Counting every name the credit could hold (`countArtistCreditAtoms`)
        // closes that: it is separator-agnostic, it does not depend on what the
        // evidence decided to keep glued, and it is the same threshold the
        // comma guard was reaching for.
        if (countArtistCreditAtoms(collab.title) >= COMPILATION_ARTIST_THRESHOLD) continue;

        const primaryName = names[0];
        const baseArtistId = await findOrCreateMusicArtist(sql, {
            name: primaryName,
            libraryGroupId: collab.library_group_id,
        });
        if (baseArtistId === collab.id) continue;

        const secondaryIds: string[] = [];
        for (const extraName of names.slice(1)) {
            const extraId = await findOrCreateMusicArtist(sql, {
                name: extraName,
                libraryGroupId: collab.library_group_id,
            });
            if (extraId !== baseArtistId) secondaryIds.push(extraId);
        }

        const collabTrackIds = await getTrackIdsForArtist(sql, collab.id);
        const collabAlbums = await getAlbumsForArtist(sql, collab.id);
        // Compilation tracks credit this collab artist only via
        // additional_artist_ids (their album lives under Various Artists, so the
        // album re-parenting below never reaches them). Capture them BEFORE any
        // mutation so we can remap those references to the split artists.
        const collabRefTrackIds = await getTrackIdsReferencingArtistId(sql, collab.id);

        for (const album of collabAlbums) {
            const decision = await albumArtistDecision(sql, album.id, context);
            if (
                !decision ||
                decision.locked ||
                normalizeAlbumArtist(decision.artist) !== normalizeAlbumArtist(primaryName)
            )
                continue;
            await alignFolderAlbumParent(sql, album.id, baseArtistId, decision.source);
        }

        if (secondaryIds.length > 0 && collabTrackIds.length > 0) {
            for (const trackId of collabTrackIds) {
                await mergeAdditionalArtistIds(sql, trackId, secondaryIds);
            }
        }

        // Remap compilation tracks that referenced the combined row: rename the
        // combined id → primary across all tracks, then add the secondary ids to
        // the tracks that carried it, and dedupe any resulting duplicate primary.
        if (collabRefTrackIds.length > 0) {
            await replaceArtistIdInTracks(sql, collab.id, baseArtistId);
            if (secondaryIds.length > 0) {
                for (const trackId of collabRefTrackIds) {
                    await mergeAdditionalArtistIds(sql, trackId, secondaryIds);
                }
            }
            await dedupeAdditionalArtistIds(sql, baseArtistId);
        }

        // Remapping a combined UUID to the primary alone is insufficient for
        // structured credits: rebuild all affected performers after every split.
        const freshEvidence = await getArtistCreditEvidence(sql, { fresh: true });
        for (const trackId of new Set([...collabTrackIds, ...collabRefTrackIds])) {
            await reconcileTrackArtistCredits(sql, trackId, {
                libraryGroupId: collab.library_group_id,
                evidence: freshEvidence,
            });
        }
        const deleted = await deleteEmptyArtist(sql, collab.id);
        if (deleted) {
            context.logger.info(
                `[FileScanner] Merged artist "${collab.title}" → "${primaryName}"`,
                {
                    secondaryArtists: names.slice(1),
                },
            );
            mergedCount++;
        } else {
            context.logger.info(
                `[FileScanner] Kept referenced artist "${collab.title}" after credit reconciliation`,
                {
                    secondaryArtists: names.slice(1),
                },
            );
        }
    }

    return mergedCount;
}

// ---------------------------------------------------------------------------
// Remixer Credit Links (match-only)
// ---------------------------------------------------------------------------

const idList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/** The custom_metadata patch linkRemixerArtists writes for a track. */
function remixerPatch(
    meta: Record<string, unknown>,
    remixerIds: string[],
): Record<string, string[]> {
    const membership = reconcileTitleRemixerMembership(meta, remixerIds);
    const previous = new Set(idList(meta.remixer_artist_ids));
    const nextIds = [
        ...new Set([
            ...idList(meta.additional_artist_ids).filter((id) => !previous.has(id)),
            ...idList(meta.file_artist_ids),
            ...idList(meta.album_artist_ids),
            ...membership.remixer_artist_ids,
        ]),
    ];
    return { additional_artist_ids: nextIds, ...membership };
}

/** Whether {@link remixerPatch} would change `meta` (jsonb `||` merge, arrays compared in order). */
function remixerPatchChanges(meta: Record<string, unknown>, remixerIds: string[]): boolean {
    const patch = remixerPatch(meta, remixerIds);
    return Object.entries(patch).some(
        ([key, value]) => JSON.stringify(meta[key]) !== JSON.stringify(value),
    );
}

/**
 * Post-scan pass: resolve remixer credits embedded in track titles
 * ("Summertime (Ekowraith Remix)") against EXISTING artists and record the
 * match in custom_metadata.additional_artist_ids, so the title linkifies
 * and the remix lists on the remixer's artist page.
 *
 * Match-only by design: an unmatched credit writes nothing and never
 * creates an artist ("(Nobody Known Remix)" stays plain text). Idempotent —
 * re-running finds the ids already present and skips. Because it runs on
 * every scan it is also the backfill for previously scanned libraries, and
 * it picks up old remix titles automatically once the remixer's artist is
 * added to the library later.
 *
 * Returns the number of tracks updated.
 */
export async function linkRemixerArtists(
    sql: postgres.Sql,
    context: FileScannerContext,
): Promise<number> {
    // Prefilter: only version-tagged titles can carry a remix credit.
    const tracks = await sql<
        {
            id: string;
            title: string;
            custom_metadata: Record<string, unknown> | null;
            metadata_locked: boolean | null;
            hierarchy_artist_id: string | null;
        }[]
    >`
        SELECT
            track.id,
            track.title,
            track.custom_metadata,
            track.metadata_locked,
            artist.id AS hierarchy_artist_id
        FROM media_items track
        LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        WHERE track.media_type = 'track'
          AND track.status = 'active'
          AND (COALESCE(track.title, '') ~* ${VERSION_ONLY_SQL_PATTERN}
               -- Every scanned track carries these keys as EMPTY arrays, so a
               -- bare key test selected the whole music library, every scan.
               -- Only a track with remixer ids (or performer ids missing from
               -- additional_artist_ids) has anything for this pass to change.
               OR ((track.custom_metadata ? 'title_remixer_artist_ids'
                    OR track.custom_metadata ? 'remixer_artist_ids')
                   AND (COALESCE(track.custom_metadata->'title_remixer_artist_ids', '[]'::jsonb) <> '[]'::jsonb
                        OR COALESCE(track.custom_metadata->'remixer_artist_ids', '[]'::jsonb) <> '[]'::jsonb
                        OR COALESCE(track.custom_metadata->'independent_remixer_artist_ids', '[]'::jsonb) <> '[]'::jsonb
                        OR NOT (COALESCE(track.custom_metadata->'additional_artist_ids', '[]'::jsonb)
                                    @> COALESCE(track.custom_metadata->'file_artist_ids', '[]'::jsonb)
                                AND COALESCE(track.custom_metadata->'additional_artist_ids', '[]'::jsonb)
                                    @> COALESCE(track.custom_metadata->'album_artist_ids', '[]'::jsonb)))))
    `;
    if (tracks.length === 0) return 0;

    // One lookup per DISTINCT candidate name across the whole pass —
    // "(Original-style)" prefixes repeat massively across a library.
    const idByName = new Map<string, string | null>();
    const evidence = await getArtistCreditEvidence(sql);
    let updatedCount = 0;

    for (const track of tracks) {
        const names = extractRemixerCandidates(track.title).flatMap((candidate) =>
            resolveArtistCredit(candidate, evidence),
        );
        const remixerIds: string[] = [];
        for (const name of names) {
            const cacheKey = name.toLowerCase();
            let artistId = idByName.get(cacheKey);
            if (artistId === undefined) {
                artistId = await findMusicArtistByName(sql, name);
                idByName.set(cacheKey, artistId);
            }
            if (artistId !== null && !remixerIds.includes(artistId)) remixerIds.push(artistId);
        }
        // Nothing to write on the row as read above: skip it without taking
        // its lock. A concurrent change is picked up by the next scan.
        // A locked track, including legacy rows without structured credits, is never
        // written (the guard under the lock below); skip it here too, without the lock.
        const meta = track.custom_metadata ?? {};
        if (track.metadata_locked) continue;
        if (!remixerPatchChanges(meta, remixerIds)) continue;
        const changed = await withTx(sql, async (tx): Promise<boolean> => {
            const [current] = await tx<
                { custom_metadata: Record<string, unknown>; metadata_locked: boolean }[]
            >`
                SELECT COALESCE(custom_metadata, '{}'::jsonb) AS custom_metadata, metadata_locked FROM media_items
                WHERE id = ${track.id} AND title = ${track.title} FOR UPDATE
            `;
            if (!current || current.metadata_locked) return false;
            const patch = remixerPatch(current.custom_metadata, remixerIds);
            const [updated] = await tx<{ id: string }[]>`
                UPDATE media_items SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb)
                    || ${tx.json(patch as unknown as Record<string, never>)}
                WHERE id = ${track.id} AND COALESCE(custom_metadata, '{}'::jsonb) IS DISTINCT FROM
                    COALESCE(custom_metadata, '{}'::jsonb) || ${tx.json(patch as unknown as Record<string, never>)}
                RETURNING id
            `;
            return Boolean(updated);
        });
        if (!changed) continue;
        updatedCount++;
        context.logger.debug('[FileScanner] Linked remixer credit(s)', {
            trackId: track.id,
            title: track.title,
            matchedArtistCount: remixerIds.length,
        });
    }
    return updatedCount;
}

// ---------------------------------------------------------------------------
// Various Artists alias merge
// ---------------------------------------------------------------------------

/**
 * Post-scan pass: find artist rows whose title is a VA alias ("Various",
 * "VA", "V.A.", "V/A", etc.) and merge them into the canonical
 * "Various Artists" row. Albums are re-parented (duplicate titles merged),
 * and any `additional_artist_ids` references are updated.
 *
 * Idempotent — safe to run on every scan.
 */
export async function mergeVariousArtistsAliases(
    sql: postgres.Sql,
    context: FileScannerContext,
): Promise<number> {
    // Match all known normalized forms except the canonical label itself.
    // regexp_replace strips punctuation so "V.A." → "va", "V/A" → "va",
    // "Various" → "various", "Various Artist" → "various artist".
    // Three-pass normalization handles the known Various Artists aliases:
    // 1. normalize(title, NFC) — collapse NFD/NFC Unicode encoding differences
    //    before ASCII-folding so e.g. combining-accent "é" and precomposed "é"
    //    compare equal, 2. strip punctuation ([^a-z0-9 ]), 3. collapse multiple
    //    spaces (' +' → ' '). This handles "Various  Artists" (double-space)
    //    and similar whitespace variants.
    const aliases = await sql<{ id: string; title: string; library_group_id: string | null }[]>`
        SELECT id, title, library_group_id FROM media_items
        WHERE media_type = 'artist'
          AND parent_id IS NULL
          AND title != ${VARIOUS_ARTISTS_LABEL}
          AND (
            regexp_replace(
                regexp_replace(LOWER(TRIM(normalize(title, NFC))), '[^a-z0-9 ]', '', 'g'),
                ' +', ' ', 'g'
            ) = ANY(ARRAY['va', 'various', 'various artist', 'various artists'])
            OR LOWER(normalize(TRIM(title), NFC)) = ANY(ARRAY(SELECT LOWER(a) FROM unnest(${VARIOUS_ARTISTS_ALIASES}::text[]) a))
          )
    `;
    if (aliases.length === 0) return 0;

    // Resolve one canonical "Various Artists" per library group so cross-group
    // aliases don't collapse into a single global row.
    const canonicalByGroup = new Map<string, string>();
    const groupKey = (lgid: string | null): string => lgid ?? '__null__';
    const resolveCanonical = async (lgid: string | null): Promise<string> => {
        const key = groupKey(lgid);
        const cached = canonicalByGroup.get(key);
        if (cached) return cached;
        const id = await findOrCreateMusicArtist(sql, {
            name: VARIOUS_ARTISTS_LABEL,
            libraryGroupId: lgid,
        });
        canonicalByGroup.set(key, id);
        return id;
    };
    let mergedCount = 0;

    for (const alias of aliases) {
        const canonicalId = await resolveCanonical(alias.library_group_id);
        // Flag the canonical row even if it pre-existed unflagged (e.g. before
        // Task 3's insert-time flag). Idempotent — guarded by the WHERE clause.
        await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${canonicalId} AND is_various_artists = false`;
        if (canonicalId === alias.id) continue;
        const aliasAlbums = await getAlbumsForArtist(sql, alias.id);

        for (const album of aliasAlbums) {
            const decision = await albumArtistDecision(sql, album.id, context);
            if (!decision || decision.locked || !decision.various) continue;
            await alignFolderAlbumParent(sql, album.id, canonicalId, decision.source);
        }

        await replaceArtistIdInTracks(sql, alias.id, canonicalId);
        const deleted = await deleteEmptyArtist(sql, alias.id);
        if (deleted) {
            context.logger.info(
                `[FileScanner] Merged VA alias "${alias.title}" → "${VARIOUS_ARTISTS_LABEL}"`,
            );
            mergedCount++;
        } else {
            context.logger.info(
                `[FileScanner] Retained VA alias "${alias.title}" — album rule or remaining references require it`,
            );
        }
    }

    return mergedCount;
}

// ---------------------------------------------------------------------------
// Oversized compilation-artist collapse
// ---------------------------------------------------------------------------

/**
 * Post-scan pass: find legacy artist rows whose title is really a list of many
 * distinct artists (a compilation credit squashed into one row, e.g.
 * "89ers, Scotty, Aquagen, …, Deso Latee" from a radio sampler) and collapse
 * them into the canonical "Various Artists" record. Albums are re-parented
 * (duplicate titles merged), `additional_artist_ids` references are rewritten,
 * and each moved track is re-linked to its own per-track artists via
 * `ensureTrackArtistLinks` so individual contributors stay browsable.
 *
 * New ingestion never creates these rows (the scanner collapses oversized
 * credits at parse time), so this pass is purely self-healing for data that
 * predates that guard. Idempotent — safe to run on every scan.
 *
 * SQL pre-filters cheaply on any of the separators a credit can be joined by —
 * not comma alone. A comma-only prefilter let a row joined entirely by "&"
 * (e.g. "Pinball & Topmodelz & Aquagen & Scotty & 89ers & Deso Latee") skip
 * this pass forever: zero comma parts means it never reaches the count below,
 * no matter how many names it really holds. The prefilter over-selects on
 * purpose — it is cheap and `countArtistCreditAtoms` does the real,
 * separator-aware count right after, exactly as at ingest time.
 */
export async function mergeOversizedCompilationArtists(
    sql: postgres.Sql,
    context: FileScannerContext,
): Promise<number> {
    const candidates = await sql<{ id: string; title: string; library_group_id: string | null }[]>`
        SELECT id, title, library_group_id FROM media_items
        WHERE media_type = 'artist'
          AND parent_id IS NULL
          AND title != ${VARIOUS_ARTISTS_LABEL}
          AND (title ~ '[,&+]' OR title ~* '\y(feat|ft|featuring|vs|und|and)\y')
    `;
    if (candidates.length === 0) return 0;

    // Resolve one canonical "Various Artists" per library group so cross-group
    // compilations don't collapse into a single global row.
    const canonicalByGroup = new Map<string, string>();
    const groupKey = (lgid: string | null): string => lgid ?? '__null__';
    const resolveCanonical = async (lgid: string | null): Promise<string> => {
        const key = groupKey(lgid);
        const cached = canonicalByGroup.get(key);
        if (cached) return cached;
        const id = await findOrCreateMusicArtist(sql, {
            name: VARIOUS_ARTISTS_LABEL,
            libraryGroupId: lgid,
        });
        canonicalByGroup.set(key, id);
        return id;
    };

    let mergedCount = 0;

    for (const artist of candidates) {
        // Confirm the real parsed split count — drops false positives like
        // "Tyler, The Creator" whose comma stays inside one name.
        const parsedArtistCount = countArtistCreditAtoms(artist.title);
        if (parsedArtistCount < COMPILATION_ARTIST_THRESHOLD) continue;

        const canonicalId = await resolveCanonical(artist.library_group_id);
        if (canonicalId === artist.id) continue;

        // Capture tracks before re-parenting so we can re-link their own
        // per-track artists once they live under "Various Artists".
        const trackIds = await getTrackIdsForArtist(sql, artist.id);
        const albums = await getAlbumsForArtist(sql, artist.id);

        for (const album of albums) {
            const decision = await albumArtistDecision(sql, album.id, context);
            if (!decision || decision.locked || !decision.various) continue;
            await alignFolderAlbumParent(sql, album.id, canonicalId, decision.source);
        }

        await replaceArtistIdInTracks(sql, artist.id, canonicalId);

        for (const trackId of trackIds) {
            await ensureTrackArtistLinks(sql, trackId, context, artist.library_group_id);
        }

        const deleted = await deleteEmptyArtist(sql, artist.id);
        if (deleted) {
            context.logger.info(
                `[FileScanner] Collapsed oversized compilation artist "${artist.title}" → "${VARIOUS_ARTISTS_LABEL}"`,
                { parsedArtistCount },
            );
            mergedCount++;
        } else {
            context.logger.info(
                `[FileScanner] Retained oversized artist "${artist.title}" — album rule or remaining references require it`,
            );
        }
    }

    return mergedCount;
}

// ---------------------------------------------------------------------------
// Rematch "Unknown Artist" tracks
// ---------------------------------------------------------------------------

/**
 * Max tracks re-evaluated per invocation. The whole rematch runs inside ONE
 * advisory-locked transaction (see the `withAdvisoryLock` caller in
 * file-scanner.ts) — an unbounded serial loop over the entire "unknown artist"
 * backlog held that lock long enough to starve other scanners on a large music
 * library. Bounding the batch keeps the lock-hold proportional to a fixed unit
 * of work; the rest is picked up on the next scan (this pass is idempotent and
 * self-healing, and runs on every scan).
 */
export const MAX_REMATCH_TRACKS_PER_RUN = 500;

/**
 * Stamp a track's `custom_metadata.rematch_attempted_at` with the current time.
 *
 * This is what makes the per-run window ADVANCE across scans. A track that is
 * examined but stays "Unknown Artist" (no usable tag/path signal, or resolves
 * back to an unknown-artist row) never leaves the backlog, so without a marker
 * Postgres returns the same physical rows in the same order every scan and the
 * {@link MAX_REMATCH_TRACKS_PER_RUN} cap re-consumes the SAME unrematchable
 * prefix forever — starving any rematchable track sitting past the cap window.
 * The tracks query orders by this column (NULLS FIRST), so a freshly-stamped
 * track sinks behind the never-attempted (and less-recently-attempted) tracks
 * on the next scan, guaranteeing the eligible set rotates and every track is
 * eventually examined.
 */
async function markRematchAttempted(
    sql: postgres.Sql,
    trackId: string,
    attemptedAt: string,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb)
                               || jsonb_build_object('rematch_attempted_at', ${attemptedAt}::text)
        WHERE id = ${trackId}
    `;
}

/** The longest library path containing `filePath`, if any. */
function libraryRootOf(filePath: string, roots: string[]): string | undefined {
    let best: string | undefined;
    for (const root of roots) {
        const rel = path.relative(root, filePath);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        if (!best || root.length > best.length) best = root;
    }
    return best;
}

/**
 * Post-scan pass: re-evaluate tracks currently parented under an "Unknown
 * Artist" row using the improved tag → filename → folder derivation, and
 * re-parent anything that now resolves to a real artist.
 *
 * Idempotent and self-healing — safe to run on every scan. Tracks whose tags
 * remain empty AND whose file path still gives no usable signal stay put.
 * Empty albums and the Unknown Artist node are deleted when they are no
 * longer referenced.
 *
 * Bounded to {@link MAX_REMATCH_TRACKS_PER_RUN} tracks per invocation and
 * abort-aware — see the constant's note for the lock-starvation rationale. The
 * per-artist tracks query is ordered by `rematch_attempted_at` (NULLS FIRST) and
 * examined-but-unmatched tracks are stamped via {@link markRematchAttempted}, so
 * the per-run cap window ROTATES across scans instead of re-examining the same
 * unrematchable prefix every time (see {@link markRematchAttempted}).
 */
export async function rematchUnknownArtistTracks(
    sql: postgres.Sql,
    context: FileScannerContext,
): Promise<number> {
    const unknownArtists = await sql<{ id: string; library_group_id: string | null }[]>`
        SELECT id, library_group_id FROM media_items
        WHERE media_type = 'artist'
          AND parent_id IS NULL
          AND regexp_replace(LOWER(TRIM(normalize(title, NFC))), '[^a-z0-9 ]', '', 'g') = 'unknown artist'
    `;
    if (unknownArtists.length === 0) return 0;

    // Prevent oscillation when multiple "Unknown Artist" rows exist — tracks would
    // otherwise ping-pong between them on successive scans. findOrCreateMusicArtist
    // may resolve a new derived name back to a different unknown-artist row if the
    // derivation normalizes to "unknown artist" (e.g. "UNKNOWN ARTIST!").
    const unknownArtistIdSet = new Set(unknownArtists.map((a) => a.id));
    // The folder fallback in deriveArtistName must know each file's library
    // root. Loaded once, at the first track that needs it.
    let rematchLibraryPaths: LibraryPathRow[] | undefined;

    let rematched = 0;
    // Total tracks examined this invocation — bounds the lock-hold window.
    let processed = 0;
    // Set when the per-run cap is hit so we stop scanning further artists and
    // leave the remaining backlog for the next scan.
    let capped = false;
    // Cooperative-abort flag: breaks out of BOTH loops when the scan is
    // cancelled (soft budget / operator stop) so the held transaction commits
    // the work done so far promptly instead of running the whole backlog.
    let stop = false;
    // One stamp for the whole invocation — every track examined-but-unmatched
    // this run is marked with it so the ORDER BY sinks them behind the
    // never-attempted tracks next scan (window rotation; see markRematchAttempted).
    const attemptedAt = new Date().toISOString();

    for (const unknownArtist of unknownArtists) {
        if (context.abortSignal?.aborted) break;
        const tracks = await sql<
            {
                track_id: string;
                album_id: string;
                album_title: string;
                album_year: number | null;
                file_path: string | null;
            }[]
        >`
            SELECT
                t.id AS track_id,
                a.id AS album_id,
                a.title AS album_title,
                a.year AS album_year,
                mf.file_path
            FROM media_items t
            JOIN media_items a ON a.id = t.parent_id AND a.media_type = 'album'
            LEFT JOIN media_file_items mfi
                ON mfi.media_item_id = t.id AND mfi.is_default = true
            LEFT JOIN media_files mf ON mf.id = mfi.file_id
            WHERE t.media_type = 'track'
              AND a.parent_id = ${unknownArtist.id}
            -- Least-recently-attempted first: never-attempted tracks (NULL) lead,
            -- then oldest stamp. Combined with the markRematchAttempted stamp on
            -- unmatched tracks, this rotates the per-run cap window across scans
            -- so a rematchable track past the cap is eventually examined instead
            -- of being permanently starved behind an unrematchable prefix. ISO
            -- timestamps sort chronologically as text, so no cast is needed.
            ORDER BY (t.custom_metadata->>'rematch_attempted_at') ASC NULLS FIRST, t.id ASC
        `;

        const albumPlacements = new Map<string, string>();
        const folderDecisions = new Map<string, Awaited<ReturnType<typeof albumArtistDecision>>>();
        const albumDecisions = new Map<string, Awaited<ReturnType<typeof albumArtistDecision>>>();

        for (const track of tracks) {
            if (context.abortSignal?.aborted) {
                stop = true;
                break;
            }
            if (processed >= MAX_REMATCH_TRACKS_PER_RUN) {
                capped = true;
                stop = true;
                break;
            }
            processed++;
            // Heartbeat pulse so the enclosing scan doesn't look stalled while
            // this pass grinds through the backlog. Denominator is the per-run
            // cap so the bar reads 100% exactly when we stop on the cap.
            context.onProgress?.(processed, Math.max(processed, MAX_REMATCH_TRACKS_PER_RUN), {
                phase: 'Rematching unknown-artist tracks',
            });

            if (!track.file_path) {
                // No default media_file_items link — can't derive artist from path.
                // Surface it so operators can investigate the orphaned track.
                context.logger.warn(
                    '[FileScanner] Skipping Unknown-Artist rematch for track with no default media file',
                    { trackId: track.track_id, albumId: track.album_id },
                );
                // Stamp so this file-less track rotates out of the cap window
                // next scan instead of re-consuming a slot every run.
                await markRematchAttempted(sql, track.track_id, attemptedAt);
                continue;
            }

            let tagAlbumArtist: string | undefined;
            let tagArtist: string | undefined;
            let tagAlbumArtists: string[] | undefined;
            let rematchTags: Awaited<ReturnType<typeof parseAudioTags>> = {};
            try {
                const tags = await parseAudioTags(track.file_path, {
                    signal: context.abortSignal,
                });
                rematchTags = tags;
                tagAlbumArtist = tags.albumArtist;
                tagArtist = tags.artist;
                tagAlbumArtists = tags.albumArtists;
            } catch {
                // File missing or unreadable — fall through to path-only derivation
            }

            const { albumDir } = resolveAlbumDir(track.file_path);
            rematchLibraryPaths ??= await sql<LibraryPathRow[]>`SELECT * FROM library_paths`;
            const libraryRoot = libraryRootOf(
                track.file_path,
                rematchLibraryPaths.map((p) => p.path),
            );
            const rematchPath = rematchLibraryPaths.find((p) => p.path === libraryRoot);
            if (!albumDecisions.has(track.album_id))
                albumDecisions.set(
                    track.album_id,
                    await albumArtistDecision(sql, track.album_id, context),
                );
            const currentDecision = albumDecisions.get(track.album_id);
            if (currentDecision?.locked) continue;
            const derived = deriveArtistName({
                tagAlbumArtist,
                tagArtist,
                filePath: track.file_path,
                albumDir,
                libraryRoot,
            });
            if (derived === 'Unknown Artist') {
                // Still no usable artist signal — stamp so this track sinks
                // behind never-attempted tracks next scan (window rotation).
                await markRematchAttempted(sql, track.track_id, attemptedAt);
                continue;
            }

            if (!folderDecisions.has(track.album_id)) {
                folderDecisions.set(
                    track.album_id,
                    rematchPath
                        ? await resolveFolderAlbumArtist(
                              sql,
                              track.file_path,
                              rematchTags,
                              rematchPath,
                              context,
                          )
                        : currentDecision,
                );
            }
            const folderDecision = folderDecisions.get(track.album_id);
            const allNames = [folderDecision?.artist ?? derived];
            const newArtistId = await findOrCreateMusicArtist(sql, {
                name: allNames[0],
                libraryGroupId: unknownArtist.library_group_id ?? undefined,
            });
            // Guards against BOTH the current row and any sibling Unknown Artist rows
            // so tracks don't oscillate between multiple unknown-artist nodes.
            if (unknownArtistIdSet.has(newArtistId)) {
                // Derivation still resolves to an unknown-artist node — stamp so
                // it rotates out of the cap window next scan (window rotation).
                await markRematchAttempted(sql, track.track_id, attemptedAt);
                continue;
            }

            let newAlbumId = albumPlacements.get(track.album_id);
            if (!newAlbumId) {
                newAlbumId = await alignFolderAlbumParent(
                    sql,
                    track.album_id,
                    newArtistId,
                    folderDecision?.source ?? 'fallback',
                );
                albumPlacements.set(track.album_id, newAlbumId);
            }

            // Re-parent AND refresh stale custom_metadata.artist / album_artist so
            // downstream readers don't see "Unknown Artist" after the hierarchy move.
            const metaPatch: Record<string, unknown> = {
                artist: tagArtist ?? rematchTags.artistFromFilename ?? derived,
                ...(tagAlbumArtist ? { album_artist: tagAlbumArtist } : {}),
            };
            if (tagAlbumArtists && tagAlbumArtists.length > 1) {
                metaPatch.album_artists = tagAlbumArtists;
            }
            await sql`
                UPDATE media_items
                SET parent_id = ${newAlbumId},
                    custom_metadata = (COALESCE(custom_metadata, '{}'::jsonb) - 'album_artist' - 'album_artists')
                                       || ${sql.json(metaPatch as unknown as Record<string, never>)}
                WHERE id = ${track.track_id}
            `;

            if (allNames.length > 1) {
                const additionalIds: string[] = [];
                for (const extraName of allNames.slice(1)) {
                    const extraId = await findOrCreateMusicArtist(sql, {
                        name: extraName,
                        libraryGroupId: unknownArtist.library_group_id ?? undefined,
                    });
                    if (extraId !== newArtistId) additionalIds.push(extraId);
                }
                if (additionalIds.length > 0) {
                    await mergeAdditionalArtistIds(sql, track.track_id, additionalIds);
                }
            }

            rematched++;
        }

        if (await deleteEmptyArtist(sql, unknownArtist.id)) {
            context.logger.info('[FileScanner] Removed empty "Unknown Artist" node after rematch', {
                unknownArtistId: unknownArtist.id,
            });
        }

        if (stop) break;
    }

    if (capped) {
        context.logger.info(
            '[FileScanner] Unknown-artist rematch hit its per-run cap — remaining tracks will be handled on the next scan',
            { processed, cap: MAX_REMATCH_TRACKS_PER_RUN, rematched },
        );
    }

    return rematched;
}

// ---------------------------------------------------------------------------
// Track Custom Metadata
// ---------------------------------------------------------------------------

/**
 * Build the custom_metadata JSONB object stored on a track media_item.
 * Includes all audio tag fields and embedded lyrics if present.
 */
/** Only these file-owned fields are replaced when the bytes change. */
const SCANNER_TAG_KEYS = [
    'compilation',
    'musicbrainz_album_artist_ids',
    'artist',
    'artists',
    'album_artist',
    'album_artists',
    'album',
    'barcode',
    'catalogue_number',
    'track_number',
    'track_number_source',
    'disc_number',
    'disc_total',
    'genre',
    'recording_mbid',
    'musicbrainz_album_id',
    'musicbrainz_releasegroup_id',
    'year',
    'codec',
    'sample_rate',
    'bitrate',
    'channels',
    'duration_seconds',
    'raw_artist_tags',
    'musicbrainz_artist_ids',
];

function buildTrackCustomMetadata(
    tags: Awaited<ReturnType<typeof parseAudioTags>>,
): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    if (tags.rawArtistTags) meta.raw_artist_tags = tags.rawArtistTags;
    if (tags.musicbrainzArtistIds) meta.musicbrainz_artist_ids = tags.musicbrainzArtistIds;

    // Surface the filename-derived artist as `artist` when no embedded tag was
    // present. This is what `ensureTrackArtistLinks` reads to create per-track
    // artist rows on tag-less compilation albums (e.g. VA folders where every
    // file has the real artist embedded in the filename via `Artist - Title`
    // or `Artist _ Title` patterns).
    if (tags.artist !== undefined) meta.artist = tags.artist;
    else if (tags.artistFromFilename !== undefined) meta.artist = tags.artistFromFilename;
    if (tags.albumArtist !== undefined) meta.album_artist = tags.albumArtist;
    if (tags.compilation !== undefined) meta.compilation = tags.compilation;
    if (tags.musicbrainzAlbumArtistIds?.length)
        meta.musicbrainz_album_artist_ids = tags.musicbrainzAlbumArtistIds;
    // Persist multi-value tag arrays so downstream pieces (ensureTrackArtistLinks,
    // future re-scans, embeddings) can consume them losslessly without re-running
    // the splitter heuristic.
    if (tags.artists && tags.artists.length > 1) meta.artists = tags.artists;
    if (tags.albumArtists && tags.albumArtists.length > 1) meta.album_artists = tags.albumArtists;
    if (tags.album !== undefined) meta.album = tags.album;
    if (tags.barcode) meta.barcode = tags.barcode;
    if (tags.catalogueNumber) meta.catalogue_number = tags.catalogueNumber;
    if (tags.trackNumber !== undefined) meta.track_number = tags.trackNumber;
    if (tags.discNumber !== undefined) meta.disc_number = tags.discNumber;
    if (tags.discTotal !== undefined) meta.disc_total = tags.discTotal;
    if (tags.genre !== undefined && tags.genre.length > 0) meta.genre = tags.genre;
    if (tags.recordingMbid !== undefined) meta.recording_mbid = tags.recordingMbid;
    if (tags.releaseMbid !== undefined) meta.musicbrainz_album_id = tags.releaseMbid;
    if (tags.releaseGroupMbid !== undefined)
        meta.musicbrainz_releasegroup_id = tags.releaseGroupMbid;
    if (tags.year !== undefined) meta.year = tags.year;
    if (tags.codec !== undefined) meta.codec = tags.codec;
    if (tags.sampleRate !== undefined) meta.sample_rate = tags.sampleRate;
    if (tags.bitrate !== undefined) meta.bitrate = tags.bitrate;
    if (tags.channels !== undefined) meta.channels = tags.channels;
    if (tags.duration !== undefined) meta.duration_seconds = tags.duration;

    if (tags.lyrics) {
        meta.lyrics = {
            plain: tags.lyrics,
            synced: null,
            format: null,
            source: 'embedded',
        };
    }

    return meta;
}

// ---------------------------------------------------------------------------
// Main Audio File Processor
// ---------------------------------------------------------------------------

/**
 * Process a single audio file: parse tags → create artist/album/track hierarchy.
 *
 * Hierarchy:
 *   artist (media_type='artist', parent_id=NULL)
 *     └─ album  (media_type='album', parent_id=artist.id)
 *          └─ track (media_type='track', parent_id=album.id)
 *
 * Tag metadata is stored in custom_metadata JSONB on the track row.
 * Embedded lyrics, if present, are stored in custom_metadata.lyrics.
 *
 * Artist/album identity is determined by (title, media_type, parent_id) to
 * prevent duplicates across re-scans. Track identity uses file_path via
 * findAllLinkedMediaItemsByFilePath() — same pattern as all other scanner paths.
 *
 * Returns the scan outcome, or 'error' on unexpected failure.
 */

/** Where a track belongs in the artist → album hierarchy, derived from its tags and path. */
interface TrackPlacement {
    albumDir: string;
    folderDiscNumber: number | null;
    allArtistNames: string[];
    isOversizedCompilation: boolean;
    inconsistentAlbumArtists: boolean;
    ruleSource: AlbumArtistDecision['source'];
    discEvidence: boolean;
    artistName: string;
    albumName: string;
    effectiveYear: number | undefined;
}

/**
 * Artist and album a track file belongs under: tags first, then the
 * filename/folder fallbacks, the artist-credit split and the compilation
 * collapse. Shared by the new-file path and the retag path, so a retagged track
 * lands exactly where a new file with the same tags would.
 */
async function resolveTrackPlacement(
    sql: postgres.Sql,
    filePath: string,
    tags: Awaited<ReturnType<typeof parseAudioTags>>,
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
): Promise<TrackPlacement> {
    const { albumDir, discNumber: folderDiscNumber } = resolveAlbumDir(filePath);

    // Detect "Various - Album" folder naming for untagged compilations.
    // Only applies when no artist tags are present (tags take priority).
    const vaFolder =
        !tags.albumArtist && !tags.artist
            ? parseVAFolderPattern(path.basename(albumDir), folderDiscNumber !== null)
            : null;

    // Tag → filename → folder fallback chain. Without this, files with empty
    // ID3 tags end up under "Unknown Artist" even when the Plex/Jellyfin folder
    // convention (/Artist/Album/Track.ext) makes the artist obvious.
    const rawArtistName =
        vaFolder?.artist ??
        deriveArtistName({
            tagAlbumArtist: tags.albumArtist,
            tagArtist: tags.artist,
            filePath,
            albumDir,
            libraryRoot: libraryPath.path,
        });

    // Prefer the properly-tagged multi-value array (Vorbis / ID3v2.4) when the
    // file carries one — that's the lossless source of truth. Otherwise resolve
    // the derived scalar via resolveArtistCredit: "feat." / "x" / "vs." always
    // split, an ambiguous "A & B" only where the library proves the parts are
    // separate artists (see artist-credit.ts). First name becomes the primary
    // artist in the hierarchy; others are linked via
    // custom_metadata.additional_artist_ids on the track.
    const usesMultiValueAlbumArtists =
        vaFolder?.artist == null && tags.albumArtists !== undefined && tags.albumArtists.length > 1;
    const allArtistNames = usesMultiValueAlbumArtists
        ? (tags.albumArtists as string[])
        : resolveArtistCredit(rawArtistName, await getArtistCreditEvidence(sql));

    const decision = await resolveFolderAlbumArtist(sql, filePath, tags, libraryPath, context);
    const artistName = decision.artist;
    // Oversized TRACK credits affect track links only, never the album parent.
    const isOversizedCompilation = decision.various;

    const rawAlbumName =
        tags.album?.trim() || vaFolder?.album || path.basename(albumDir) || 'Unknown Album';
    const albumName = folderAlbumTitle(rawAlbumName, decision.discEvidence, artistName);
    const effectiveYear = tags.year ?? extractYearFromFolder(path.basename(albumDir)) ?? undefined;

    return {
        albumDir,
        folderDiscNumber,
        allArtistNames,
        isOversizedCompilation,
        inconsistentAlbumArtists: decision.inconsistentAlbumArtists,
        ruleSource: decision.source,
        discEvidence: decision.discEvidence,
        artistName,
        albumName,
        effectiveYear,
    };
}

/** Custom-metadata keys {@link resolveTrackPlacement} derives the album and artist from. */
const PLACEMENT_TAG_KEYS = [
    'album',
    'album_artist',
    'album_artists',
    'artist',
    'artists',
    'compilation',
    'musicbrainz_album_artist_ids',
    'musicbrainz_album_id',
    'musicbrainz_releasegroup_id',
    'year',
] as const;

/** Whether the new tags change a key that places the track (compared with what is stored). */
async function placementTagsChanged(
    sql: postgres.Sql,
    trackId: string,
    newMeta: Record<string, unknown>,
    readDiscEvidence: () => Promise<boolean>,
): Promise<boolean> {
    const [row] = await sql<{ stored: Record<string, unknown> | null }[]>`
        SELECT custom_metadata AS stored FROM media_items WHERE id = ${trackId}
    `;
    const stored = row?.stored ?? {};
    const same = (k: string, a: unknown, b: unknown): boolean =>
        JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed = PLACEMENT_TAG_KEYS.filter((k) => !same(k, stored[k], newMeta[k]));
    if (changed.length === 0) return false;
    if (changed.length > 1 || changed[0] !== 'album') return true;
    // Only the album tag changed. A disc-marker-only change ("X CD1" -> "X
    // CD 1") keeps a curated/merged placement; needs folder disc evidence.
    if (typeof stored.album !== 'string' || typeof newMeta.album !== 'string') return true;
    const discEvidence = await readDiscEvidence();
    return (
        folderAlbumTitle(stored.album, discEvidence) !==
        folderAlbumTitle(newMeta.album, discEvidence)
    );
}

/**
 * Move a retagged track to the album its new tags name (see
 * {@link resolveTrackPlacement}). Called only when a placement tag changed.
 * Stays put when the track or its current album is metadata-locked (an admin
 * placed it), or when the new read has neither an album nor an artist tag (a
 * file read mid-write would otherwise move to a folder-derived album). In one
 * transaction under a lock on the old album: re-parent, relink artists,
 * has_files for the new chain, fold an emptied old album into the new one
 * (deleteEmptyAlbum moves its references), re-derive the old chain. Returns
 * false on failure, so the caller keeps the old file stat and the next scan
 * retries.
 */
async function moveRetaggedTrack(
    sql: postgres.Sql,
    trackId: string,
    filePath: string,
    tags: Awaited<ReturnType<typeof parseAudioTags>>,
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
): Promise<boolean> {
    if (!tags.album?.trim() && !tags.albumArtist?.trim() && !tags.artist?.trim()) return true;
    try {
        const placement = await resolveTrackPlacement(sql, filePath, tags, libraryPath, context);
        const artistId = await findOrCreateMusicArtist(sql, {
            name: placement.artistName,
            libraryGroupId: libraryPath.library_group_id,
        });
        const candidateAlbumId =
            (await findExistingFolderAlbum(
                sql,
                placement.albumDir,
                placement.albumName,
                tags,
                libraryPath.library_group_id,
                filePath,
                placement.inconsistentAlbumArtists,
                placement.discEvidence,
                placement.isOversizedCompilation,
            )) ??
            (await findOrCreateMusicAlbum(sql, {
                title: placement.albumName,
                artistId,
                year: placement.effectiveYear,
                libraryGroupId: libraryPath.library_group_id,
            }));
        const albumId = await alignFolderAlbumParent(
            sql,
            candidateAlbumId,
            artistId,
            placement.ruleSource,
        );
        const moved = await withTx(sql, async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;
            const [track] = await tx<
                {
                    parent_id: string | null;
                    old_artist_id: string | null;
                    locked: boolean;
                }[]
            >`
                SELECT t.parent_id, al.parent_id AS old_artist_id,
                       (t.metadata_locked OR COALESCE(al.metadata_locked, false)) AS locked
                  FROM media_items t
                  LEFT JOIN media_items al ON al.id = t.parent_id
                 WHERE t.id = ${trackId}
            `;
            if (!track || track.locked || albumId === track.parent_id) return null;
            if (track.parent_id) {
                await tx`SELECT pg_advisory_xact_lock(hashtext(${`music-album-move:${track.parent_id}`}))`;
            }
            await tx`UPDATE media_items SET parent_id = ${albumId}, updated_at = NOW() WHERE id = ${trackId}`;
            await ensureTrackArtistLinks(tx, trackId, context, libraryPath.library_group_id);
            // The new album and artist show in the library now; the old ones
            // only while they still hold a track with a file.
            await propagateHasFiles(tx, trackId);
            if (track.parent_id)
                await deleteEmptyAlbum(tx, track.parent_id, albumId, placement.ruleSource);
            const oldChain = [track.parent_id, track.old_artist_id].filter(
                (id): id is string => id !== null,
            );
            if (oldChain.length > 0) await recomputeHasFilesBatch(tx, oldChain);
            return track.parent_id;
        });
        if (moved !== null) {
            context.logger.info('[FileScanner] Retagged track moved to its new album', {
                trackId,
                fromAlbumId: moved,
                toAlbumId: albumId,
                album: placement.albumName,
                artist: placement.artistName,
            });
        }
        return true;
    } catch (err) {
        context.logger.warn(
            '[FileScanner] Could not move a retagged track to its new album; the next scan retries',
            {
                trackId,
                filePath,
                error: err instanceof Error ? err.message : String(err),
            },
        );
        return false;
    }
}

/**
 * Bug #3 (rename reconnect-by-hash) for audio.
 *
 * Mirror of video-processor.tryReclaimByHash: look for a recently
 * soft-dismissed track whose previous file shared the new file's 64KB
 * head hash. When found, reattach the new file to the resurrected
 * track media_item so user data (play counts, ratings, playlist
 * memberships) is preserved.
 *
 * Returns the reclaimed media_item_id on success, or null otherwise.
 */
async function tryReclaimAudioByHash(
    sql: postgres.Sql,
    filePath: string,
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
): Promise<string | null> {
    let contentHash: string;
    try {
        contentHash = await hashFileHead(filePath);
    } catch (err) {
        context.logger.debug(
            '[FileScanner] Reclaim-by-hash (audio): head hash failed; skipping reclaim',
            {
                filePath,
                error: err instanceof Error ? err.message : String(err),
            },
        );
        return null;
    }

    const match: ReclaimCandidate | null = await findReclaimableByHash(sql, contentHash);
    // Cross-library moves must not attach an audio file to a video item.
    const candidate = match && isTrack(match.media_type) ? match : null;
    let mediaItemId = candidate?.media_item_id ?? null;

    // Order-independent fallback (rename-race fix #4): when the `add` for the
    // renamed path is processed BEFORE the `unlink(oldPath)` commits, the old
    // track is still active and undismissed — the dismissed-hash lookup above
    // misses. Tracks have no external-id net, so without this a new UUID is
    // minted and the user's listening history/ratings are stranded. Match the
    // still-active track by its LIVE media_files head hash instead;
    // undismissMediaItem below is a no-op on an already-active row.
    if (!mediaItemId) {
        const live = await findActiveItemByLiveHeadHash(sql, contentHash, ['track']);
        mediaItemId = live?.media_item_id ?? null;
    }
    if (!mediaItemId) return null;
    const reclaimedId = mediaItemId;
    const matchedViaLiveHash = !candidate;

    let aborted = false;
    let alreadyLinkedId: string | null = null;
    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SET LOCAL lock_timeout = '30s'`;
        // Same ownership election as the new-track path. Lock file before item
        // so a scan/watcher winner cannot gain a second owner via hash reclaim.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`media-file-link:${filePath}`}, 0))`;
        alreadyLinkedId = (await findAllLinkedMediaItemsByFilePath(tx, filePath))[0] ?? null;
        if (alreadyLinkedId) return;
        // Finding-3 guard (live-hash path only). findActiveItemByLiveHeadHash
        // matched a single-file item OUTSIDE any lock; two concurrent copies of
        // the same file could both pass that count==1 check and then both
        // attach, inflating the item to 3+ files. Take the same advisory lock
        // attachFileToItem uses and re-verify the single-file invariant in-tx;
        // if another reclaim already added a file, back off so this copy mints a
        // distinct item (the "copies stay distinct" intent). The dismissed
        // snapshot path is exempt — that item has zero files, so 0→1 is fine.
        if (matchedViaLiveHash) {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${reclaimedId}))`;
            const rows = await tx<{ count: string }[]>`
                SELECT count(*)::text AS count
                  FROM media_file_items WHERE media_item_id = ${reclaimedId}
            `;
            if (parseInt(rows[0]?.count ?? '0', 10) !== 1) {
                aborted = true;
                return;
            }
        }
        const { id: fileId } = await upsertMediaFile(tx, {
            filePath,
            libraryGroupId: libraryPath.library_group_id,
        });
        await attachFileToItem(tx, fileId, reclaimedId);
        await touchLibraryAddedAt(tx, reclaimedId, config.RECENTLY_ADDED_PROPAGATE_TO_SERIES);
        await undismissMediaItem(tx, reclaimedId);
        await tx`
            UPDATE media_files
               SET file_hash_head = ${contentHash},
                   updated_at = NOW()
             WHERE id = ${fileId}
        `;
    });
    if (alreadyLinkedId) return alreadyLinkedId;
    if (aborted) {
        context.logger.debug(
            '[FileScanner] Live-hash reclaim (audio) backed off: item gained a file concurrently; minting distinct item',
            { mediaItemId: reclaimedId, filePath },
        );
        return null;
    }

    context.logger.info('[FileScanner] Reclaimed track via hash match (rename reconnect)', {
        mediaItemId: reclaimedId,
        newFilePath: filePath,
        contentHashPrefix: contentHash.slice(0, 12),
        matchedVia: candidate ? 'dismissed-snapshot' : 'live-head-hash',
    });

    MediaLifecycleService.afterReclaimed(reclaimedId, sql).catch((err: unknown) => {
        if (process.env.NODE_ENV !== 'production') throw err;
        context.logger.warn('[FileScanner] afterReclaimed enqueue failed (audio)', {
            mediaItemId: reclaimedId,
            error: err instanceof Error ? err.message : String(err),
        });
    });

    return reclaimedId;
}

/**
 * Look up a file-less "orphan" track under the given album that matches the
 * incoming file's title/track-number/disc-number.
 *
 * Guards the new-track path in {@link processAudioFile} against a specific
 * historical non-idempotency gap: track creation used separate statements
 * (artist upsert, album upsert, `insertScannedMediaItem`, then
 * `attachFileToItem`). If a prior scan died between the track insert and the
 * file attach, the `media_files` row it already upserted is left with
 * `is_linked = false` while the track row it created has zero linked files.
 * The next scan's short-circuit (`existingFile.is_linked === false`) treats
 * that as "no link" and falls through to the same new-track path, which
 * would otherwise insert a SECOND track for the same physical file —
 * a permanent duplicate. New inserts and attaches are now atomic, but old
 * installs can still carry these orphans.
 *
 * Restricting the match to tracks with zero rows in `media_file_items`
 * targets exactly that orphan instead of merging genuinely distinct tracks
 * that happen to share title/track/disc metadata but already have their own
 * file (e.g. two legitimately different recordings tagged identically).
 *
 * The disc comparison is done on TEXT, not via `::int`. `custom_metadata` is
 * a freeform jsonb column and `PUT /api/admin/media/bulk-metadata` merges an
 * arbitrary admin-supplied object into it verbatim, so a string ("1/2", the
 * raw ID3 combined form) can reach this key even though the scanner itself
 * only ever writes a JSON number. A bare cast raises
 * `invalid input syntax for type integer` for the whole statement, failing
 * the file's scan outright. Text comparison is exactly equivalent for every
 * value the scanner writes — `->>` renders a JSON number `1` as `'1'`, and a
 * missing key as NULL, so both the matching and the `IS NOT DISTINCT FROM`
 * NULL-vs-NULL cases behave as before — while a garbage value simply fails
 * to match instead of throwing. Deliberately NOT the `jsonb_typeof(...) =
 * 'number'` guard used in the ORDER BY sites (music.queries.ts,
 * music-admin.queries.ts, admin-media.queries.ts): that yields NULL for
 * garbage, and under `IS NOT DISTINCT FROM` NULL is a MATCHABLE value, so an
 * untagged incoming file would adopt a `"1/2"`-tagged orphan. NULL-as-unknown
 * is right for sorting and wrong for equality.
 */
export async function findAdoptableOrphanTrack(
    sql: postgres.Sql,
    params: {
        albumId: string;
        title: string;
        trackNumber: number | null;
        discNumber: number | null;
    },
): Promise<string | null> {
    const [row] = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_items mi
        WHERE mi.media_type = 'track'
          AND mi.parent_id = ${params.albumId}
          AND mi.title = ${params.title}
          AND mi.sort_order IS NOT DISTINCT FROM ${params.trackNumber}
          AND mi.custom_metadata ->> 'disc_number' IS NOT DISTINCT FROM ${
              params.discNumber === null ? null : String(params.discNumber)
          }
          AND NOT EXISTS (
              SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id
          )
        ORDER BY mi.created_at ASC
        LIMIT 1
    `;
    return row?.id ?? null;
}

/**
 * A track whose file was replaced since the last scan (song.mp3 removed,
 * song.flac added): an active track of this album with the same title, track
 * and disc number whose files are ALL gone from this library. A full scan meets
 * the new file before it retires the old one, so the track still has its old
 * file and `findAdoptableOrphanTrack` (zero files only) misses it; a new track
 * was minted and the old one dismissed with its plays, ratings and playlist
 * entries. Returns that track, or null when there is none or more than one, or
 * when an old file is still there (two formats side by side stay two tracks,
 * as before).
 */
async function findReplacedTrack(
    sql: postgres.Sql,
    identity: {
        albumId: string;
        title: string;
        trackNumber: number | null;
        discNumber: number | null;
    },
    libraryRoot: string,
    filePath: string,
): Promise<string | null> {
    const candidates = await findTracksWithFilesByIdentity(sql, identity);
    const replaced: string[] = [];
    for (const track of candidates) {
        if (track.file_paths.includes(filePath)) return null;
        if (await filesAllMissingFromLibrary(track.file_paths, libraryRoot))
            replaced.push(track.id);
    }
    return replaced.length === 1 ? replaced[0] : null;
}

export async function processAudioFile(
    sql: postgres.Sql,
    filePath: string,
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
    abortSignal?: AbortSignal,
    knownFiles?: Map<string, KnownFileRow>,
): Promise<'added' | 'updated' | 'skipped' | 'error'> {
    if (abortSignal?.aborted) return 'skipped';

    // Guard against transient NFS unmounts — same pattern as video-processor.ts.
    // If the parent directory is also missing, the mount is likely offline;
    // skip rather than logging a spurious error.
    const presence = await assessFilePresence(filePath, abortSignal);
    if (presence === 'transient') {
        context.logger.warn('FILE_SCANNER_AUDIO_TRANSIENT_UNMOUNT', {
            filePath,
        });
        return 'skipped';
    }

    // Reject non-audio files (e.g. cover.jpg that somehow reached the scanner)
    const ext = path.extname(filePath).toLowerCase();
    if (!isAudioFile(ext)) {
        return 'skipped';
    }

    // Short-circuit: file already registered AND linked to a media_item.
    // Use the bulk-loaded knownFiles map when available to avoid a per-file
    // DB round-trip for the common unchanged case.
    const existingFile = knownFiles
        ? (knownFiles.get(filePath) ?? null)
        : await findMediaFileByPath(sql, filePath);
    if (existingFile) {
        if (existingFile.is_missing) await restoreScannedFile(sql, existingFile.id, filePath);
        // If the media_file exists but has no linked media_item (e.g. after a
        // migration that deleted music rows), fall through to re-create the
        // artist/album/track hierarchy.
        // Resolve linked item once — audio files are 1:1 with tracks, so we
        // fetch all IDs but expect at most one.
        //
        // When is_linked is already known from the bulk-loaded knownFiles map,
        // skip the separate linked-items query for the "no link, fall through"
        // case — only fetch linked IDs when we know the file is actually linked.
        let linkedId: string | null = null;
        let linkedItemCount = 0;
        if (knownFiles && existingFile.is_linked === false) {
            // knownFiles confirms no link — fall through to re-create hierarchy.
            // linkedId stays null so the block below falls through.
        } else {
            const linkedIds = await findAllLinkedMediaItemsByFilePath(sql, filePath);
            linkedId = linkedIds[0] ?? null;
            linkedItemCount = linkedIds.length;
        }
        if (!linkedId) {
            // Fall through to the new-file creation path below
        } else {
            let outcome: 'skipped' | 'updated' = 'skipped';
            const changeResult = await detectFileChanges(existingFile, filePath);
            switch (changeResult.status) {
                case 'content-changed': {
                    // Ruling T7-music: a track whose bytes changed into a
                    // playlist/manifest body is retired exactly like a video
                    // file (sniffContentChangeForScan, shared.ts). An abort or
                    // a transient read error writes nothing — above all not
                    // the new stat/hash — so the next scan sniffs again.
                    const sniff = await sniffContentChangeForScan(
                        sql,
                        filePath,
                        libraryPath.library_group_id,
                        context,
                        abortSignal,
                    );
                    if (sniff.kind === 'refused') return 'error';
                    if (sniff.kind === 'aborted') return 'skipped';
                    if (sniff.kind === 'failed') return 'error';

                    const tags = await parseAudioTags(filePath, {
                        signal: abortSignal,
                    });
                    // Same parseError guard as the new-file path: never
                    // overwrite real tag-derived metadata with the
                    // filename-derived fallback that gets returned on
                    // parse failure. Record the failure so the admin UI
                    // surfaces it and the next scan honors the backoff
                    // cooldown (otherwise this linked file would still
                    // burn a 30 s parseFile timeout every pass).
                    if (tags.parseError && tags.parseError !== 'aborted') {
                        const issueType =
                            tags.parseError === 'timeout'
                                ? 'tag_parse_timeout'
                                : 'tag_parse_corrupt';
                        try {
                            await recordFileScanIssue(sql, {
                                filePath,
                                libraryGroupId: libraryPath.library_group_id,
                                type: issueType,
                                detail: `content-changed re-parse failed: ${tags.parseError}`,
                            });
                        } catch (recErr) {
                            context.logger.warn(
                                '[FileScanner] Failed to record scan issue (content-changed)',
                                {
                                    filePath,
                                    error:
                                        recErr instanceof Error ? recErr.message : String(recErr),
                                },
                            );
                        }
                        context.logger.warn(
                            '[FileScanner] Skipping content-changed update — tag parse failed; recorded as scan issue',
                            {
                                filePath,
                                reason: tags.parseError,
                                linkedId,
                            },
                        );
                        outcome = 'skipped';
                        break;
                    }
                    // Successful re-parse — clear stale scan-failure markers.
                    try {
                        await clearFileScanIssue(sql, filePath, [
                            'tag_parse_timeout',
                            'tag_parse_corrupt',
                        ]);
                    } catch (err) {
                        context.logger.debug(
                            '[FileScanner] Failed to clear scan-issue marker (content-changed; non-fatal)',
                            {
                                filePath,
                                error: err instanceof Error ? err.message : String(err),
                            },
                        );
                    }
                    // Folder disc evidence parses the sibling files, so it is
                    // read only when a decision needs it (a disc marker in the
                    // album tag, no tag or folder disc). A ReplayGain write or
                    // cover embed on an unsuffixed album never pays for it.
                    let discEvidenceRead: boolean | undefined;
                    const readDiscEvidence = async (): Promise<boolean> => {
                        if (discEvidenceRead !== undefined) return discEvidenceRead;
                        try {
                            discEvidenceRead = (
                                await resolveFolderAlbumArtist(
                                    sql,
                                    filePath,
                                    tags,
                                    libraryPath,
                                    context,
                                )
                            ).discEvidence;
                        } catch {
                            discEvidenceRead = false;
                        }
                        return discEvidenceRead;
                    };
                    const albumHasDiscMarker =
                        splitDiscSuffix(cleanAlbumTitle(tags.album ?? ''), true).disc !== null;
                    const trackMeta = buildTrackCustomMetadata(tags);
                    if (
                        trackMeta.disc_number === undefined &&
                        tags.discNumber === undefined &&
                        resolveAlbumDir(filePath).discNumber === null &&
                        albumHasDiscMarker
                    ) {
                        trackMeta.disc_number =
                            splitDiscSuffix(
                                cleanAlbumTitle(tags.album ?? ''),
                                await readDiscEvidence(),
                            ).disc ?? undefined;
                    }
                    trackMeta.disc_number ??=
                        tags.discNumber ?? resolveAlbumDir(filePath).discNumber ?? undefined;
                    if (trackMeta.track_number === undefined) {
                        const disc =
                            typeof trackMeta.disc_number === 'number'
                                ? trackMeta.disc_number
                                : null;
                        const number = trackNumberFromFilename(filePath, disc);
                        if (number !== null) {
                            trackMeta.track_number = number;
                            trackMeta.track_number_source = 'filename';
                        }
                    }
                    // The tags that decide the track's album and artist, as
                    // stored before this rewrite: the track moves only when
                    // one of them changed (not on a ReplayGain write or a
                    // cover embed, which would re-split a merged album).
                    const placementChanged = await placementTagsChanged(
                        sql,
                        linkedId,
                        trackMeta,
                        readDiscEvidence,
                    );
                    // Scanner-path invariant (same rule as video-processor.ts):
                    // tag-derived METADATA never overwrites a row an admin
                    // locked by hand. Re-tagging or re-encoding a file used to
                    // silently revert a hand-corrected track title here.
                    // runtime_seconds stays unconditional — it is a measured
                    // property of the file, not a metadata opinion, and a stale
                    // duration breaks seeking and gapless playback.
                    // When the file's artist evidence changed, the derived
                    // canonical credit describes the OLD tags. Drop it with
                    // the tags so the reads fall back to the new tags until
                    // the reconcile below succeeds (a failed one is retried
                    // on the next scan); ownership ids stay for that
                    // reconcile's bookkeeping, and the old credit moves to
                    // `artist_credit_previous` so it can still keep the
                    // established identity of a name that did not change. No
                    // MusicBrainz ids and `[]` (what the metadata backfill
                    // stores) are the same evidence.
                    const rawArtistTags =
                        trackMeta.raw_artist_tags === undefined
                            ? null
                            : sql.json(trackMeta.raw_artist_tags as Record<string, never>);
                    const providerArtistIds =
                        trackMeta.musicbrainz_artist_ids === undefined
                            ? null
                            : sql.json(trackMeta.musicbrainz_artist_ids as never);
                    const artistEvidenceChanged = sql`(
                        custom_metadata->'raw_artist_tags' IS DISTINCT FROM ${rawArtistTags}::jsonb
                        OR COALESCE(custom_metadata->'musicbrainz_artist_ids', '[]'::jsonb)
                           IS DISTINCT FROM COALESCE(${providerArtistIds}::jsonb, '[]'::jsonb))`;
                    await sql`
                        UPDATE media_items
                        SET custom_metadata = CASE WHEN metadata_locked THEN custom_metadata
                                                   ELSE ((CASE WHEN custom_metadata->'lyrics'->>'source' = 'embedded'
                                                            THEN custom_metadata - 'lyrics'
                                                            ELSE COALESCE(custom_metadata, '{}'::jsonb) END) - ${sql.array(SCANNER_TAG_KEYS)}::text[]
                                                         - (CASE WHEN ${artistEvidenceChanged}
                                                                 THEN ARRAY['track_artist_credits', 'artist_credit_source']
                                                                 ELSE ARRAY[]::text[] END))
                                                       || (CASE WHEN ${artistEvidenceChanged}
                                                                 AND jsonb_typeof(custom_metadata->'track_artist_credits') = 'array'
                                                                THEN jsonb_build_object('artist_credit_previous', jsonb_build_object(
                                                                    'credits', custom_metadata->'track_artist_credits',
                                                                    'source', custom_metadata->'artist_credit_source'))
                                                                ELSE '{}'::jsonb END)
                                                       || ${sql.json(trackMeta as Record<string, never>)} END,
                            title           = CASE WHEN metadata_locked THEN title
                                                   ELSE ${tags.title ?? path.basename(filePath)} END,
                            title_source    = CASE WHEN metadata_locked THEN title_source
                                                   ELSE ${trackTitleSource(tags)} END,
                            runtime_seconds = ${tags.duration ?? null},
                            sort_order      = CASE WHEN metadata_locked THEN sort_order
                                                   ELSE ${(trackMeta.track_number as number | undefined) ?? null} END
                        WHERE id = ${linkedId}
                    `;
                    await refreshSortTitles(sql, [linkedId]);
                    // A retag can name another album or album artist: move the
                    // track where a new file with these tags would land. It
                    // used to stay under the old album forever. The track keeps
                    // its id; an album left empty is folded into the new one.
                    const moved = placementChanged
                        ? await moveRetaggedTrack(
                              sql,
                              linkedId,
                              filePath,
                              tags,
                              libraryPath,
                              context,
                          )
                        : true;
                    if (moved && (tags.barcode || tags.catalogueNumber)) {
                        const [parent] = await sql<
                            { parent_id: string | null }[]
                        >`SELECT parent_id FROM media_items WHERE id = ${linkedId}`;
                        if (parent?.parent_id)
                            await persistAlbumReleaseIdentifiers(sql, parent.parent_id, tags);
                    }
                    // A failed move keeps the old stat, so the next scan sees the
                    // change again and retries it.
                    if (moved && changeResult.fileStat && changeResult.currentHash) {
                        await updateFileStat(
                            sql,
                            existingFile.id,
                            changeResult.fileStat.mtime,
                            changeResult.fileStat.size,
                            changeResult.currentHash,
                        );
                    }
                    // Finish invalidation before later scanner work or its caller
                    // can start another operation. Its transaction locks the file
                    // before reading links; an overlapping cleanup can take the
                    // link-table lock first and deadlock waiting for that file.
                    await MediaLifecycleService.onFileContentChanged(
                        sql,
                        existingFile.id,
                        filePath,
                    ).catch((err: unknown) => {
                        if (process.env.NODE_ENV !== 'production') throw err;
                        context.logger.warn(
                            '[FileScanner] onFileContentChanged enqueue failed (audio content-changed)',
                            {
                                mediaItemId: linkedId,
                                fileId: existingFile.id,
                                error: err instanceof Error ? err.message : String(err),
                            },
                        );
                    });
                    outcome = 'updated';
                    break;
                }
                case 'first-backfill':
                case 'metadata-only':
                    if (changeResult.fileStat && changeResult.currentHash) {
                        await updateFileStat(
                            sql,
                            existingFile.id,
                            changeResult.fileStat.mtime,
                            changeResult.fileStat.size,
                            changeResult.currentHash,
                        );
                    }
                    break;
                case 'unchanged':
                case 'deleted':
                case 'error':
                    break;
            }

            // Mojibake self-heal: a row written by the pre-recovery scanner
            // may contain U+FFFD in title/artist/album fields. Detect and
            // re-parse so existing rows fix themselves on the next scan
            // without requiring a full re-import. Only runs when the cheap
            // change-detection path classified the file as unchanged — the
            // 'content-changed' branch above already re-parsed.
            if (outcome === 'skipped') {
                // A physical file can have multiple links. Apply whole-file
                // title evidence to every eligible whole-file track, without
                // borrowing a segment's identity or depending on junction order.
                const titleCheckIds = await findTrackIdsWithUnverifiedTitleSourceByFilePath(
                    sql,
                    filePath,
                );
                const repairIds = titleCheckIds.length > 0 ? titleCheckIds : [linkedId];
                for (const repairId of repairIds) {
                    try {
                        const [storedRow] = await sql<
                            {
                                title: string | null;
                                title_source: string | null;
                                custom_metadata: Record<string, unknown> | null;
                            }[]
                        >`SELECT title, title_source, custom_metadata FROM media_items WHERE id = ${repairId}`;
                        const storedMeta = storedRow?.custom_metadata ?? {};
                        const needsHeal =
                            hasReplacementChar(storedRow?.title) ||
                            hasReplacementChar(storedMeta.artist) ||
                            hasReplacementChar(storedMeta.album_artist) ||
                            hasReplacementChar(storedMeta.album);
                        // A `filename` title source is also a reason to re-read the
                        // tags once. The 16.276.0 backfill marked every track whose
                        // title equalled its file stem, so on prod 1000 of the 1217
                        // `filename` rows carry a TITLE tag that was never read. The
                        // content-changed path only runs when the file changes, so
                        // those rows never healed. Rows the tags confirm as untagged
                        // get `title_source_verified` so they are not re-read again.
                        const needsFilenameCheck =
                            !needsHeal &&
                            storedRow?.title_source === 'filename' &&
                            storedMeta.title_source_verified !== true;
                        if (needsHeal) {
                            const healedTags = await parseAudioTags(filePath, {
                                signal: abortSignal,
                            });
                            // A fallback from a failed/cancelled parse is not tag
                            // evidence and must not replace any stored metadata.
                            if (healedTags.parseError || abortSignal?.aborted) continue;
                            const stillBroken =
                                hasReplacementChar(healedTags.title) &&
                                hasReplacementChar(healedTags.artist) &&
                                hasReplacementChar(healedTags.album);
                            if (!stillBroken) {
                                const healedMeta = buildTrackCustomMetadata(healedTags);
                                // Drop FFFD-bearing keys from storedMeta so the
                                // spread doesn't preserve broken values for fields
                                // the file no longer carries a tag for. Without
                                // this, a stored row with U+FFFD in artist would
                                // keep that broken value when the file's ARTIST
                                // tag is missing entirely.
                                const cleanedMeta: Record<string, unknown> = {};
                                for (const [k, v] of Object.entries(storedMeta)) {
                                    if (!hasReplacementChar(v)) cleanedMeta[k] = v;
                                }
                                const merged = {
                                    ...cleanedMeta,
                                    ...healedMeta,
                                    // This successful parse also completes title
                                    // verification, including a locked broken title
                                    // that the admin intentionally keeps unchanged.
                                    ...(storedRow?.title_source === 'filename'
                                        ? { title_source_verified: true }
                                        : {}),
                                };
                                // A locked row is the admin's: they may have
                                // already retyped the title by hand while a
                                // U+FFFD elsewhere in custom_metadata still trips
                                // needsHeal. Heal the metadata, leave their title.
                                await sql`
                                UPDATE media_items
                                SET custom_metadata = ${sql.json(merged as unknown as Record<string, never>)},
                                    title           = CASE WHEN metadata_locked THEN title
                                                           ELSE ${healedTags.title ?? path.basename(filePath)} END,
                                    title_source    = CASE WHEN metadata_locked THEN title_source
                                                           ELSE ${trackTitleSource(healedTags)} END
                                WHERE id = ${repairId}
                            `;
                                await refreshSortTitles(sql, [repairId]);
                                outcome = 'updated';
                                context.logger.info('[FileScanner] Healed mojibake in track tags', {
                                    trackId: repairId,
                                    title: healedTags.title,
                                });

                                // Propagate heal to parent album / artist rows.
                                // Their `title` columns were set on the first scan
                                // from the same broken bytes, so heal-on-track
                                // alone leaves a mojibaked album/artist title in
                                // the hierarchy forever.
                                try {
                                    const [parents] = await sql<
                                        {
                                            album_id: string | null;
                                            album_title: string | null;
                                            artist_id: string | null;
                                            artist_title: string | null;
                                        }[]
                                    >`
                                    SELECT
                                        a.id    AS album_id,
                                        a.title AS album_title,
                                        ar.id   AS artist_id,
                                        ar.title AS artist_title
                                    FROM media_items t
                                    LEFT JOIN media_items a  ON a.id  = t.parent_id
                                    LEFT JOIN media_items ar ON ar.id = a.parent_id
                                    WHERE t.id = ${repairId}
                                `;
                                    if (
                                        parents?.album_id &&
                                        hasReplacementChar(parents.album_title) &&
                                        healedTags.album &&
                                        !hasReplacementChar(healedTags.album)
                                    ) {
                                        await sql`
                                        UPDATE media_items
                                        SET title = ${healedTags.album}
                                        WHERE id = ${parents.album_id}
                                          AND metadata_locked = false
                                    `;
                                        await refreshSortTitles(sql, [parents.album_id]);
                                        context.logger.info(
                                            '[FileScanner] Healed mojibake in album title',
                                            {
                                                albumId: parents.album_id,
                                                title: healedTags.album,
                                            },
                                        );
                                    }
                                    const healedArtist =
                                        healedTags.albumArtist ?? healedTags.artist;
                                    if (
                                        parents?.artist_id &&
                                        hasReplacementChar(parents.artist_title) &&
                                        healedArtist &&
                                        !hasReplacementChar(healedArtist)
                                    ) {
                                        await sql`
                                        UPDATE media_items
                                        SET title = ${healedArtist}
                                        WHERE id = ${parents.artist_id}
                                          AND metadata_locked = false
                                    `;
                                        await refreshSortTitles(sql, [parents.artist_id]);
                                        context.logger.info(
                                            '[FileScanner] Healed mojibake in artist title',
                                            {
                                                artistId: parents.artist_id,
                                                title: healedArtist,
                                            },
                                        );
                                    }
                                } catch (parentErr) {
                                    // Parent heal is best-effort — never fail the
                                    // scan over it. Track row is already healed.
                                    context.logger.debug(
                                        '[FileScanner] Parent row mojibake heal skipped',
                                        {
                                            trackId: repairId,
                                            error:
                                                parentErr instanceof Error
                                                    ? parentErr.message
                                                    : String(parentErr),
                                        },
                                    );
                                }
                            }
                        }
                        if (needsFilenameCheck) {
                            const checkedTags = await parseAudioTags(filePath, {
                                signal: abortSignal,
                            });
                            // A parse that did not complete says nothing about the
                            // file's tags. Leave the row unmarked so the next scan asks again.
                            if (!checkedTags.parseError && !abortSignal?.aborted) {
                                // Locked rows keep both title and source, as in the
                                // mojibake heal above and the content-changed path.
                                // The verified marker is written either way, so a
                                // locked row is not re-read on every scan.
                                const [written] = await sql<{ title_source: string | null }[]>`
                                UPDATE media_items
                                SET title        = CASE WHEN metadata_locked THEN title
                                                        ELSE ${checkedTags.title ?? path.basename(filePath)} END,
                                    title_source = CASE WHEN metadata_locked THEN title_source
                                                        ELSE ${trackTitleSource(checkedTags)} END,
                                    custom_metadata = COALESCE(custom_metadata, '{}'::jsonb)
                                        || ${sql.json({ title_source_verified: true } as unknown as Record<string, never>)}
                                WHERE id = ${repairId}
                                RETURNING title_source
                            `;
                                if (written?.title_source !== storedRow?.title_source) {
                                    await refreshSortTitles(sql, [repairId]);
                                    outcome = 'updated';
                                }
                            }
                        }
                    } catch (err) {
                        // Best-effort heal — never fail the scan over it
                        context.logger.debug('[FileScanner] Mojibake self-heal skipped', {
                            trackId: repairId,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
                // The remaining unchanged maintenance assumes one track per
                // file. Do not run it against an arbitrary linked segment or
                // unrelated track after a multi-link provenance catch-up.
                if (titleCheckIds.length > 0 && linkedItemCount > 1) return outcome;
            }

            // Backfill genre / recording MBID / disc / track number data for existing
            // tracks missing them in custom_metadata (e.g. rows created before
            // a field was extracted, or files where the mtime-based skip means
            // the normal 'content-changed' full rebuild path never runs). This
            // is how a pre-existing multi-disc album (whose tracks predate
            // disc_number extraction) grows its disc headers on the next scan
            // WITHOUT a force re-import.
            try {
                const [trackMetaRow] = await sql<
                    { custom_metadata: Record<string, unknown> | null; metadata_locked: boolean }[]
                >`SELECT custom_metadata, metadata_locked FROM media_items WHERE id = ${linkedId}`;
                const existingGenre = trackMetaRow?.custom_metadata?.genre;
                const hasGenre = Array.isArray(existingGenre) && existingGenre.length > 0;
                const existingRecordingMbid = trackMetaRow?.custom_metadata?.recording_mbid;
                const hasRecordingMbid =
                    typeof existingRecordingMbid === 'string' && existingRecordingMbid.length > 0;
                const existingDiscNumber = trackMetaRow?.custom_metadata?.disc_number;
                const hasDiscNumber = typeof existingDiscNumber === 'number';
                const rawEvidence = trackMetaRow?.custom_metadata?.raw_artist_tags;
                const hasFileArtistEvidence =
                    typeof rawEvidence === 'object' &&
                    rawEvidence !== null &&
                    'source' in rawEvidence &&
                    rawEvidence.source === 'file';
                // A locked track never takes the update below; asking would
                // re-parse its tags on every scan.
                const filenameTrackNumber =
                    typeof trackMetaRow?.custom_metadata?.track_number === 'number' ||
                    trackMetaRow?.metadata_locked
                        ? null
                        : trackNumberFromFilename(
                              filePath,
                              hasDiscNumber
                                  ? existingDiscNumber
                                  : resolveAlbumDir(filePath).discNumber,
                          );
                if (
                    !hasGenre ||
                    !hasRecordingMbid ||
                    !hasDiscNumber ||
                    !hasFileArtistEvidence ||
                    filenameTrackNumber !== null
                ) {
                    const backfillTags = await parseAudioTags(filePath, {
                        signal: abortSignal,
                    });
                    if (backfillTags.parseError)
                        throw new Error(`Artist tag retry: ${backfillTags.parseError}`);
                    const updates: Record<string, unknown> = {};
                    if (!hasFileArtistEvidence) {
                        updates.raw_artist_tags = backfillTags.rawArtistTags;
                        updates.musicbrainz_artist_ids = backfillTags.musicbrainzArtistIds ?? [];
                        const parsedMetadata = buildTrackCustomMetadata(backfillTags);
                        for (const key of ['artist', 'artists', 'album_artist', 'album_artists']) {
                            if (parsedMetadata[key] !== undefined)
                                updates[key] = parsedMetadata[key];
                        }
                    }
                    if (!hasGenre && backfillTags.genre && backfillTags.genre.length > 0) {
                        updates.genre = backfillTags.genre;
                    }
                    if (!hasRecordingMbid && backfillTags.recordingMbid !== undefined) {
                        updates.recording_mbid = backfillTags.recordingMbid;
                    }
                    if (!hasDiscNumber) {
                        // Tag disc number first, then the folder-name fallback
                        // (CD1/, Disc 2/) — same precedence as the create path.
                        let disc = backfillTags.discNumber;
                        if (disc === undefined) {
                            const { discNumber: folderDisc } = resolveAlbumDir(filePath);
                            if (folderDisc !== null) disc = folderDisc;
                        }
                        // Folder evidence parses sibling files: only for an album
                        // tag that carries a disc marker at all.
                        const backfillAlbum = cleanAlbumTitle(backfillTags.album ?? '');
                        if (
                            disc === undefined &&
                            splitDiscSuffix(backfillAlbum, true).disc !== null
                        ) {
                            const { discEvidence } = await resolveFolderAlbumArtist(
                                sql,
                                filePath,
                                backfillTags,
                                libraryPath,
                                context,
                            );
                            disc = splitDiscSuffix(backfillAlbum, discEvidence).disc ?? undefined;
                        }
                        if (disc !== undefined) {
                            updates.disc_number = disc;
                            if (backfillTags.discTotal !== undefined) {
                                updates.disc_total = backfillTags.discTotal;
                            }
                        }
                    }
                    if (filenameTrackNumber !== null) {
                        // A row from before track numbers were stored can still
                        // have the tag: the tag wins, as on the create path.
                        if (backfillTags.trackNumber !== undefined) {
                            updates.track_number = backfillTags.trackNumber;
                        } else {
                            // Same disc evidence as the trigger above, so the
                            // two never disagree into a parse on every scan.
                            updates.track_number = filenameTrackNumber;
                            updates.track_number_source = 'filename';
                        }
                    }
                    if (Object.keys(updates).length > 0) {
                        await sql`
                            UPDATE media_items
                            SET custom_metadata = (COALESCE(custom_metadata, '{}'::jsonb)
                                - ${sql.array(hasFileArtistEvidence ? [] : ['artist', 'artists', 'album_artist', 'album_artists'])}::text[])
                                || ${sql.json(updates as unknown as Record<string, never>)},
                                sort_order = COALESCE(${(updates.track_number as number | undefined) ?? null}::int, sort_order)
                            WHERE id = ${linkedId} AND metadata_locked = false
                              AND COALESCE(custom_metadata, '{}'::jsonb) = ${sql.json((trackMetaRow?.custom_metadata ?? {}) as Record<string, never>)}
                        `;
                    }
                }
            } catch {
                // Best-effort genre / recording MBID backfill — don't fail the scan
            }

            try {
                await ensureTrackArtistLinks(sql, linkedId, context, libraryPath.library_group_id);
            } catch (err) {
                // Retried on every scan of this file; warn so a credit that
                // never resolves is visible.
                context.logger.warn('[FileScanner] Track artist credit reconcile failed', {
                    trackId: linkedId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            // Clear stale track-level poster rows first. A valid album poster
            // cannot help if the track has its own broken local row: the image
            // proxy resolves the track row before falling back to the album.
            try {
                await hasValidOwnPoster(sql, linkedId, context);
            } catch (err) {
                context.logger.debug('[FileScanner] Track artwork self-heal skipped', {
                    trackId: linkedId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            // Backfill album art for existing tracks whose album lacks a valid
            // poster, or whose poster leaked in from a now-shared folder.
            try {
                const [track] = await sql<
                    { parent_id: string | null }[]
                >`SELECT parent_id FROM media_items WHERE id = ${linkedId}`;
                if (track?.parent_id) {
                    const albumId = track.parent_id;
                    const { albumDir: backfillAlbumDir } = resolveAlbumDir(filePath);
                    const shared = await isSharedAlbumDir(sql, backfillAlbumDir).catch(() => true);
                    const hasValid = await hasValidOwnPoster(sql, albumId, context);

                    // Heal case: poster exists and points DIRECTLY into a now-
                    // shared folder. Nested placements (`scans/booklet.jpg`) are
                    // left alone — only top-level `cover.jpg` leaks across
                    // sibling albums in a VA directory.
                    let needsHeal = false;
                    let staleArtworkId: string | null = null;
                    if (hasValid && shared) {
                        const existing = await getLocalArtwork(sql, albumId, 'poster');
                        if (
                            existing &&
                            existing.media_item_id === albumId &&
                            existing.file_path &&
                            isPathUnder(existing.file_path, backfillAlbumDir) &&
                            path.dirname(existing.file_path) === backfillAlbumDir
                        ) {
                            needsHeal = true;
                            staleArtworkId = existing.id;
                        }
                    }

                    if (!hasValid || needsHeal) {
                        // Folder images can't be trusted in shared folders (they
                        // may belong to a sibling album). Only treat folder art
                        // as "already solved" when the directory is dedicated.
                        const artworkEntries = shared ? [] : await walkArtwork(backfillAlbumDir);
                        const hasFolderArt =
                            !shared &&
                            !!(await findAlbumFolderPoster(
                                backfillAlbumDir,
                                artworkEntries,
                                context,
                            ));

                        // Re-parse tags when we need embedded art (shared folder
                        // case, or dedicated folder with no folder art, or heal).
                        const needEmbeddedParse = shared || !hasFolderArt || needsHeal;
                        let embeddedArt: { format: string; data: Buffer } | undefined;
                        if (needEmbeddedParse) {
                            const backfillTags = await parseAudioTags(filePath, {
                                signal: abortSignal,
                            });
                            embeddedArt = backfillTags.embeddedArt;
                            await persistAlbumReleaseIdentifiers(sql, albumId, backfillTags);
                        }

                        if (hasFolderArt || embeddedArt) {
                            await persistAlbumArt(
                                sql,
                                albumId,
                                backfillAlbumDir,
                                embeddedArt,
                                context,
                                {
                                    sourceTrackId: linkedId,
                                    precomputedArtworkEntries: artworkEntries,
                                },
                            );
                        } else if (needsHeal && staleArtworkId) {
                            // Shared folder, no embedded art to offer, no
                            // trustworthy folder art — clear the leaked row so
                            // CAA can take over, otherwise the VA-folder cover
                            // would stick forever.
                            try {
                                await deleteArtworkById(sql, staleArtworkId);
                                context.logger.info(
                                    '[FileScanner] Cleared leaked shared-folder cover',
                                    { albumId, stalePath: backfillAlbumDir },
                                );
                            } catch (err) {
                                context.logger.warn(
                                    '[FileScanner] Failed to clear stale artwork row',
                                    {
                                        albumId,
                                        artworkId: staleArtworkId,
                                        error: err instanceof Error ? err.message : String(err),
                                    },
                                );
                            }
                        }

                        // Flag album for deferred Cover Art Archive fetch (post-scan job)
                        // Own row only: the artist's image is not this album's cover.
                        const artworkAfterBackfill = await getOwnLocalArtwork(
                            sql,
                            albumId,
                            'poster',
                        );
                        if (!artworkAfterBackfill) {
                            await sql`
                                UPDATE media_items
                                SET custom_metadata = custom_metadata || ${sql.json({ needs_cover_art_fetch: true })}
                                WHERE id = ${albumId}
                            `;
                        }
                    }
                }
            } catch (err) {
                // Best-effort art backfill — don't fail the scan
                context.logger.debug('[FileScanner] Album art backfill skipped', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            // Backfill/refresh sidecar lyrics — re-read if a sidecar exists on
            // disk. Sidecar files take priority over auto-fetched lyrics; only
            // user-uploaded lyrics are preserved (the gate lives in
            // applySidecarLyricsToTrack).
            try {
                await applySidecarLyricsToTrack(sql, linkedId, filePath);
            } catch {
                // Best-effort sidecar lyrics backfill
            }

            // Backfill NFO metadata for album/artist
            try {
                const { albumDir: nfoAlbumDir } = resolveAlbumDir(filePath);
                await backfillMusicNfo(
                    sql,
                    { fileId: existingFile.id, trackId: linkedId, filePath },
                    nfoAlbumDir,
                    context,
                    abortSignal,
                );
            } catch {
                // Best-effort NFO backfill
            }

            return outcome;
        } // end else (isLinked)
    }

    if (abortSignal?.aborted) return 'skipped';

    // Ruling T7-music: music-metadata accepts a text body as a track, so the
    // tag parse below is no guard. A playlist/manifest body (an ffconcat
    // script, an HLS playlist, a DASH/IMF manifest) is refused here, before
    // any path that links the file — including the reclaim-by-hash just
    // below — through the same content sniff the video plane runs
    // (sniffNewFileForScan, shared.ts). Unchanged linked tracks returned
    // above and are never sniffed.
    {
        const sniff = await sniffNewFileForScan(
            sql,
            filePath,
            libraryPath.library_group_id,
            context,
            abortSignal,
        );
        if (sniff.kind === 'refused') return 'error';
        if (sniff.kind === 'aborted') return 'skipped';
        if (sniff.kind === 'failed') return 'error';
        // A previously-refused track may reuse the SAME stub row on re-ingest.
        await clearStaleRefusalAndEnsureChangeDetection(sql, existingFile, filePath);
    }

    // Rename reconnect-by-hash (bug #3).
    //
    // The native watcher fires unlink+add pairs on rename. The unlink path can soft-
    // dismiss the original track media_item; without this check the add
    // would create a fresh artist/album/track hierarchy and strand the
    // user's listening history on the dismissed UUID. When the new file's
    // 64KB head hash matches a recently dismissed item, reattach the new
    // file to the resurrected track.
    {
        const reclaimedId = await tryReclaimAudioByHash(sql, filePath, libraryPath, context);
        if (reclaimedId) {
            // Deleted tracks are outside the active-track migration. Restore
            // their canonical credits before exposing the reclaimed identity.
            await ensureTrackArtistLinks(sql, reclaimedId, context, libraryPath.library_group_id);
            return 'updated';
        }
    }

    // Short-circuit when the file is already in the cooldown window for a
    // previous parse failure. Saves a 30s parseFile timeout on every scan
    // for files that persistently fail. Cooldown is busted when the file
    // has been modified on disk since the failure was recorded — a
    // re-tagged or replaced file gets retried right away.
    const cooldown = await getFileScanRetryAt(sql, filePath);
    if (cooldown && cooldown.retryAt.getTime() > Date.now()) {
        let mtime: Date | null = null;
        try {
            const stats = await safeStat(filePath);
            mtime = stats.mtime;
        } catch {
            // stat failure is benign — fall through and honor the cooldown.
        }
        if (mtime && mtime > cooldown.latestDetectedAt) {
            context.logger.info(
                '[FileScanner] File modified since last scan failure — busting cooldown for retry',
                {
                    filePath,
                    mtime: mtime.toISOString(),
                    detectedAt: cooldown.latestDetectedAt.toISOString(),
                },
            );
            // Fall through to parseFile.
        } else {
            context.logger.debug(
                '[FileScanner] Skipping audio file — within scan-failure cooldown',
                { filePath, retryAfter: cooldown.retryAt.toISOString() },
            );
            return 'skipped';
        }
    }

    // Parse audio tags
    const tags = await parseAudioTags(filePath, { signal: abortSignal });

    if (abortSignal?.aborted) return 'skipped';

    // Parse failure (timeout / corrupt file) — DO NOT create a track row.
    // Without this guard the filename-derived fallback title becomes the
    // permanent display title (e.g. "14-secal-désenchantée" from
    // "14-secal-désenchantée.flac"), the file row never gets linked
    // because something downstream fails, orphan cleanup then dismisses
    // the track, and the next scan repeats — producing hundreds of dup
    // rows per file. Skipping here lets the next scan retry the parse.
    //
    // Persist the failure into media_files.health_issues so admins can
    // see exactly which files need attention from the Ingest Map page
    // (Scan Issues section), AND so subsequent scans can apply the
    // exponential-backoff cooldown above.
    if (tags.parseError && tags.parseError !== 'aborted') {
        const issueType = tags.parseError === 'timeout' ? 'tag_parse_timeout' : 'tag_parse_corrupt';
        const issue = await recordFileScanIssue(sql, {
            filePath,
            libraryGroupId: libraryPath.library_group_id,
            type: issueType,
            detail: `parseAudioTags returned parseError='${tags.parseError}'`,
        });
        context.logger.warn(
            '[FileScanner] Skipping audio file — tag parse failed; recorded as scan issue',
            {
                filePath,
                reason: tags.parseError,
                attempt: issue.attempt_count,
                nextRetryAt: issue.next_retry_at ?? 'immediately',
            },
        );
        return 'error';
    }
    // Successful parse — clear any stale scan-failure marker on this file.
    // Cheap no-op when there's nothing to clear (single round-trip).
    try {
        await clearFileScanIssue(sql, filePath, ['tag_parse_timeout', 'tag_parse_corrupt']);
    } catch (err) {
        context.logger.debug('[FileScanner] Failed to clear stale scan-issue marker (non-fatal)', {
            filePath,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    const {
        albumDir,
        folderDiscNumber,
        allArtistNames,
        isOversizedCompilation,
        inconsistentAlbumArtists,
        ruleSource,
        discEvidence,
        artistName,
        albumName,
        effectiveYear,
    } = await resolveTrackPlacement(sql, filePath, tags, libraryPath, context);

    context.logger.debug('[FileScanner] Processing audio file', {
        filePath: path.basename(filePath),
        artist: artistName,
        additionalArtists: allArtistNames.slice(1),
        album: albumName,
        track: tags.title,
    });

    try {
        // 1. Find or create primary artist
        const artistId = await findOrCreateMusicArtist(sql, {
            name: artistName,
            libraryGroupId: libraryPath.library_group_id,
        });

        // 1b. Find or create additional artists (for "&", "feat." splits).
        // Skip compilation markers ("Various", "VA", "X/Various") — album_artist
        // tags like "Artist & Various" would otherwise create a bogus "Various"
        // artist row and stamp it on every track, making all tracks appear to
        // share the same extra artist. Per-track collaborations are populated
        // later by ensureTrackArtistLinks() from the track's own ARTIST tag.
        // For an oversized compilation the album-artist split would stamp every
        // contributor onto every track as a shared "additional artist" — noise.
        // Skip it; per-track ARTIST tags drive attribution via
        // ensureTrackArtistLinks() instead.
        const additionalArtistIds: string[] = [];
        if (!isOversizedCompilation) {
            for (const extraName of allArtistNames.slice(1)) {
                if (isCompilationArtistName(extraName)) continue;
                const extraId = await findOrCreateMusicArtist(sql, {
                    name: extraName,
                    libraryGroupId: libraryPath.library_group_id,
                });
                if (extraId !== artistId) {
                    additionalArtistIds.push(extraId);
                }
            }
        }

        // 2. Find or create album
        const candidateAlbumId =
            (await findExistingFolderAlbum(
                sql,
                albumDir,
                albumName,
                tags,
                libraryPath.library_group_id,
                undefined,
                inconsistentAlbumArtists,
                discEvidence,
                isOversizedCompilation,
            )) ??
            (await findOrCreateMusicAlbum(sql, {
                title: albumName,
                artistId,
                year: effectiveYear,
                libraryGroupId: libraryPath.library_group_id,
            }));

        const albumId = await alignFolderAlbumParent(sql, candidateAlbumId, artistId, ruleSource);

        await persistAlbumReleaseIdentifiers(sql, albumId, tags);

        // 3. Build custom_metadata for the track
        const trackMeta = buildTrackCustomMetadata(tags);

        // Disc number fallback from folder name when not in tags
        if (trackMeta.disc_number === undefined && folderDiscNumber !== null) {
            trackMeta.disc_number = folderDiscNumber;
        }

        if (trackMeta.disc_number === undefined) {
            const suffixDisc = splitDiscSuffix(
                cleanAlbumTitle(tags.album ?? ''),
                discEvidence,
            ).disc;
            if (suffixDisc !== null) trackMeta.disc_number = suffixDisc;
        }

        if (trackMeta.track_number === undefined) {
            const disc = typeof trackMeta.disc_number === 'number' ? trackMeta.disc_number : null;
            const number = trackNumberFromFilename(filePath, disc);
            if (number !== null) {
                trackMeta.track_number = number;
                trackMeta.track_number_source = 'filename';
            }
        }

        // Sidecar lyrics: .lrc/.txt > embedded tags
        const sidecarLyrics = await findSidecarLyrics(filePath);
        if (sidecarLyrics) {
            trackMeta.lyrics = sidecarLyrics;
        } // else: buildTrackCustomMetadata already set embedded lyrics if present

        // Store additional artist IDs so the track appears under all artists
        if (additionalArtistIds.length > 0) {
            trackMeta.additional_artist_ids = additionalArtistIds;
            trackMeta.album_artist_ids = additionalArtistIds;
        }

        const fileHashHead = await tryHashFileHead(filePath);
        const linked = await withTx(sql, async (tx) => {
            await tx`SET LOCAL lock_timeout = '30s'`;
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`media-file-link:${filePath}`}, 0))`;
            // knownFiles is a scan-start snapshot. The watcher or another scan
            // may have linked this file since our initial check (even when the
            // snapshot says it does not exist). Recheck under a cross-process
            // lock before minting a track. The M:N link table cannot enforce
            // this globally because multi-episode video files need many items.
            if ((await findAllLinkedMediaItemsByFilePath(tx, filePath)).length) return null;
            // 4. Create the track media_item — but first check for an orphaned
            // track left behind by a prior scan that died between the track
            // insert and the media_files attach (see findAdoptableOrphanTrack's
            // doc comment). Adopt it instead of inserting a permanent duplicate.
            const trackTitle =
                tags.title?.trim() ||
                normalizeUnderscoreStem(path.basename(filePath, path.extname(filePath)));
            const titleSource = trackTitleSource(tags);
            const trackIdentity = {
                albumId,
                title: trackTitle,
                trackNumber: (trackMeta.track_number as number | undefined) ?? null,
                discNumber: (trackMeta.disc_number as number | undefined) ?? null,
            };
            const fileLessTrackId = await findAdoptableOrphanTrack(tx, trackIdentity);
            const replacedTrackId = fileLessTrackId
                ? null
                : await findReplacedTrack(tx, trackIdentity, libraryPath.path, filePath);
            const orphanTrackId = fileLessTrackId ?? replacedTrackId;
            const trackId =
                orphanTrackId ??
                (await insertScannedMediaItem(tx, {
                    title: trackTitle,
                    mediaType: 'track',
                    parentId: albumId,
                    year: effectiveYear,
                    sortOrder: trackMeta.track_number as number | undefined,
                    runtimeSeconds: tags.duration,
                    customMetadata: trackMeta,
                    titleSource,
                }));
            if (orphanTrackId) {
                // The adopted row already carries this title (it was matched on
                // it); record where it came from, as the insert would have.
                await tx`
                UPDATE media_items
                SET title_source = CASE WHEN metadata_locked THEN title_source ELSE ${titleSource} END
                WHERE id = ${orphanTrackId}
            `;
                if (replacedTrackId) {
                    // The new file is another recording of the track (another
                    // format or master): its tags and length describe it now, as
                    // the insert would have stored them.
                    await tx`
                    UPDATE media_items
                    SET custom_metadata = CASE WHEN metadata_locked THEN custom_metadata
                            ELSE COALESCE(custom_metadata, '{}'::jsonb) || ${tx.json(trackMeta as never)} END,
                        runtime_seconds = CASE WHEN metadata_locked THEN runtime_seconds
                            ELSE COALESCE(${
                                tags.duration ? Math.round(tags.duration) : null
                            }::int, runtime_seconds) END,
                        year = CASE WHEN metadata_locked THEN year
                            ELSE COALESCE(${effectiveYear ?? null}::int, year) END,
                        updated_at = now()
                    WHERE id = ${replacedTrackId}
                `;
                }
                context.logger.info(
                    '[FileScanner] Adopted an existing track row (orphan of an interrupted scan, or a replaced file) instead of inserting a duplicate',
                    { filePath: path.basename(filePath), trackId },
                );
            }

            const file = await upsertMediaFile(tx, {
                filePath,
                libraryGroupId: libraryPath.library_group_id,
                fileHashHead,
            });
            await attachFileToItem(tx, file.id, trackId);
            return { trackId, fileId: file.id, created: file.created };
        });
        if (!linked) return 'updated';
        const { trackId, fileId, created } = linked;
        await ensureTrackArtistLinks(sql, trackId, context, libraryPath.library_group_id);
        await touchLibraryAddedAt(sql, trackId, config.RECENTLY_ADDED_PROPAGATE_TO_SERIES);
        if (created) await initFileChangeDetection(sql, fileId, filePath, fileHashHead);

        // Persist album cover art (first track with art wins).
        // Priority: 1) embedded/folder art, 2) Cover Art Archive fallback.
        await persistAlbumArt(sql, albumId, albumDir, tags.embeddedArt, context, {
            sourceTrackId: trackId,
        });

        // NFO backfill for album and artist
        try {
            await backfillMusicNfo(
                sql,
                { fileId, trackId, filePath, albumId, artistId },
                albumDir,
                context,
                abortSignal,
            );
        } catch (err) {
            context.logger.warn('[FileScanner] NFO backfill failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // If no local art found, flag for deferred Cover Art Archive fetch
        const [albumAfterLocalArt] = await sql<
            { custom_poster_url: string | null }[]
        >`SELECT custom_poster_url FROM media_items WHERE id = ${albumId}`;
        if (!albumAfterLocalArt?.custom_poster_url) {
            await sql`
                UPDATE media_items
                SET custom_metadata = custom_metadata || ${sql.json({ needs_cover_art_fetch: true })}
                WHERE id = ${albumId}
            `;
        }

        return created ? 'added' : 'updated';
    } catch (err) {
        // Deadlock (40P01) / serialization failure (40001): Postgres aborted this
        // file's txn with no partial commit while concurrent files of one album
        // contended on the shared album/artist rows. Both callers
        // (bulk scan, ingestSingleFile) wrap this in runWithConflictRetry, which
        // only sees a throw. Swallowing it as 'error' dropped the file for the
        // whole scan, so rethrow the retryable conflicts.
        const pgCode = (err as { code?: unknown } | null | undefined)?.code;
        if (pgCode === '40P01' || pgCode === '40001') throw err;
        context.logger.error(
            `[FileScanner] Failed to process audio file: ${filePath}`,
            err instanceof Error ? err : new Error(String(err)),
        );
        return 'error';
    }
}
