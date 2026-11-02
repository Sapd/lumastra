// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The single title → internal-UUID step shared by every WRITE tool.
 *
 * Two properties matter here, and both are the reason this is centralised
 * rather than repeated in four tools:
 *
 * 1. **Resolution IS the access gate.** `searchMediaByTitle` applies
 *    `buildLibraryAccessFilter` + `buildAgeRatingFilter`, so a title the caller
 *    may not see never comes back — which is also why "denied" and "does not
 *    exist" are indistinguishable to the model by construction, not by a
 *    hand-written check a later edit could drop.
 *
 * 2. **A write against the wrong "Fargo" is not recoverable by re-reading.**
 *    A read tool that picks the wrong same-named title shows the user something
 *    odd and they ask again; a write tool rates, watchlists, or marks the wrong
 *    item and nothing surfaces it. So when the top candidates are genuinely
 *    interchangeable, this refuses instead of picking, and the tool asks.
 *
 * The UUID this returns is the ONLY id a write tool may hand downstream —
 * always as `externalIds: { internal: row.media_id }`, never as a provider id.
 * `resolveExternalIdsToMediaId` short-circuits on `internal`; a provider id
 * falls through to `resolveOrCreateMediaId`, which CREATES a stub
 * `media_items` row for an id it doesn't know. An LLM-hallucinated TMDB id
 * would then write catalogue rows.
 *
 * @module server/proprietary/assistant-tools/resolve-title
 */

import {
    searchMediaByTitle,
    type AssistantMovieRow,
} from '../../database/queries/assistant-rag.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain.js';
import type { AssistantToolContext } from './types.js';

/** One of several equally-plausible matches, in the model's vocabulary. */
export interface AmbiguousCandidate {
    title: string;
    year: number | null;
    /**
     * PUBLIC vocabulary ('series', never 'tv') — this is what the model echoes
     * back. Null when the row's type maps to nothing the client renders; the
     * candidate is still worth naming, just without a type label.
     */
    mediaType: 'movie' | 'series' | null;
}

export type ResolvedTitle =
    | { kind: 'match'; row: AssistantMovieRow }
    | { kind: 'not_found' }
    | { kind: 'ambiguous'; candidates: AmbiguousCandidate[] };

export interface ResolveTitleArgs {
    title: string;
    year?: number;
    mediaType?: 'movie' | 'tv';
}

/**
 * How many candidates to pull. `searchMediaByTitle` defaults to 1, which would
 * make the ambiguity check below structurally impossible — the second-best
 * match is exactly the evidence it needs.
 */
const CANDIDATE_LIMIT = 5;
/** How many near-misses to name back when the title does not match exactly. */
const AMBIGUOUS_CANDIDATE_LIMIT = 3;

/** Year from the `YYYY-01-01` string the query synthesises, or null. */
function yearOf(row: AssistantMovieRow): number | null {
    const parsed = Number(String(row.release_date ?? '').slice(0, 4));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Fold a title to its comparable core: case, punctuation and spacing all vary
 * between a library title and how a user types it ("WALL-E" / "Wall E"), and
 * none of those differences distinguish two DIFFERENT works. Lowercase FIRST —
 * a `[^a-z0-9]` strip applied to a mixed-case string silently eats every
 * uppercase letter.
 */
function normalizeTitle(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function toCandidate(row: AssistantMovieRow): AmbiguousCandidate {
    return {
        title: row.title,
        year: yearOf(row),
        mediaType: toMovieOrSeries(row.media_type),
    };
}

/**
 * Resolve a model-supplied title to exactly one library row the caller may
 * access, or refuse.
 *
 * Refuses (`ambiguous`) when ANY two rows carrying the same normalised title
 * are different works — a film and a series, or two remakes from different
 * years — and the model gave no `year`/`mediaType` that separates them. All of
 * them, not just the top two: duplicate rows of one work would otherwise mask a
 * third that is genuinely different. The caller reports the candidates and
 * asks; it must not pick one.
 */
export async function resolveTitleForWrite(
    ctx: AssistantToolContext,
    args: ResolveTitleArgs,
): Promise<ResolvedTitle> {
    const rows = await searchMediaByTitle(ctx.sql, {
        title: args.title,
        year: args.year,
        limit: CANDIDATE_LIMIT,
        access: searchAccessBoundary(ctx.accessCtx),
    });

    if (rows.length === 0) return { kind: 'not_found' };

    // A requested mediaType is a HARD filter here, unlike get_details.
    //
    // get_details prefers the requested type and falls back to the ranked list,
    // which is right for a read: showing the film when the user said "series"
    // is a mild annoyance. On a write it is not. `mark_watched({title:'Fargo',
    // mediaType:'movie'})` against a library holding only the series would fall
    // back to the series and fan the write out across every episode — and the
    // payload only reports `fannedOutToWholeSeries` AFTER the write.
    const candidates = args.mediaType ? rows.filter((r) => r.media_type === args.mediaType) : rows;
    if (candidates.length === 0) return { kind: 'not_found' };

    const [top] = candidates;
    if (!top?.media_id) return { kind: 'not_found' };

    // The title must actually MATCH. searchMediaByTitle's first branch is
    // `mi.title ILIKE '%<title>%'` and its ORDER BY puts every substring hit
    // above every trigram hit, so the 0.45 similarity threshold gates only the
    // trigram branch — never the row returned. Without this check the function
    // can never return `not_found` for any string that is a substring of an
    // accessible title, and a mutation lands on a neighbouring work: no series
    // "Dark" but a "Dark Matter" in the library turns
    // `mark_watched({title:'Dark', watched:false})` into markSeriesUnwatched on
    // a show the user never named, wiping per-episode state that cannot be
    // restored.
    //
    // Requiring an exact normalised match is deliberately strict for a write.
    // A near-miss is reported as `ambiguous` so the model has to name what it
    // found and ask, which the payload and the prompt rule already support.
    const requested = normalizeTitle(args.title);
    if (normalizeTitle(top.title) !== requested) {
        const near = candidates.slice(0, AMBIGUOUS_CANDIDATE_LIMIT).map(toCandidate);
        return near.length > 0 ? { kind: 'ambiguous', candidates: near } : { kind: 'not_found' };
    }

    // Every row carrying the same title, not just the runner-up. Checking only
    // `candidates[1]` meant two DUPLICATE catalog rows of one work — same type,
    // same year, which they often are — read as "no ambiguity" and hid a third
    // row that is a genuinely different work. The write then landed on the
    // remake, or on the series when the user meant the film, silently.
    const sameTitle = candidates.filter((r) => r.media_id && normalizeTitle(r.title) === requested);
    const differentWork = sameTitle.some(
        (r) => r.media_type !== top.media_type || yearOf(r) !== yearOf(top),
    );
    if (differentWork) {
        return { kind: 'ambiguous', candidates: sameTitle.map(toCandidate) };
    }

    return { kind: 'match', row: top };
}
