// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared helpers to turn raw `AssistantMovieRow`s into the compact,
 * model-facing summaries tools return. Centralized so every tool emits the
 * same shape (and so cards build consistently downstream).
 *
 * @module server/proprietary/assistant-tools/media-summary
 */

import type { AssistantToolMediaSummary } from '../../../schemas/assistant-tools.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import { resultCounts } from './result-counts.js';

/** Extract a 4-digit year from a "YYYY-01-01" release_date, or null. */
function yearOf(row: AssistantMovieRow): number | null {
    if (!row.release_date) return null;
    const y = Number(String(row.release_date).slice(0, 4));
    return Number.isFinite(y) ? y : null;
}

/**
 * Cap overview length fed to the model. Full overviews (often 300+ chars) are
 * re-sent every tool-loop round and dominate the tool-result token cost; the
 * model only needs the gist to phrase a recommendation. Truncates on a word
 * boundary with an ellipsis. The full overview still reaches the UI cards via
 * the separate card path.
 */
const OVERVIEW_MAX_CHARS = 200;
function trimOverview(overview: string | null | undefined): string | null {
    if (!overview) return null;
    if (overview.length <= OVERVIEW_MAX_CHARS) return overview;
    const slice = overview.slice(0, OVERVIEW_MAX_CHARS);
    const lastSpace = slice.lastIndexOf(' ');
    return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…';
}

/**
 * Genre NAMES for the model, tolerant of every shape
 * `provider_metadata.metadata->'genres'` is stored in: `[{id,name}]` objects,
 * bare `["Comedy"]` strings, and bare `[35]` ids (dropped — an id means nothing
 * to the model, and emitting "35" as a genre would invite it to guess).
 */
function genreNames(row: AssistantMovieRow): string[] {
    const raw: unknown = row.genres;
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const g of raw) {
        if (typeof g === 'string') out.push(g);
        else if (g && typeof g === 'object' && 'name' in g) {
            const name = (g as { name?: unknown }).name;
            if (typeof name === 'string' && name !== '') out.push(name);
        }
    }
    return out;
}

/** Map a single library row to its model-facing summary. */
export function toMediaSummary(row: AssistantMovieRow): AssistantToolMediaSummary {
    // Every assistant-rag query this row can come from filters
    // `mi.media_type IN mediaTypes`, where `mediaTypes` defaults to
    // ['movie', 'tv'] and the only caller-supplied override
    // (`toolMediaTypeSchema`) is `z.enum(['movie', 'tv'])` — this can never be
    // anything else.
    // eslint-disable-next-line callback-safety/no-inline-media-type-default -- summary rows are movie/TV-only.
    const mediaType = toMovieOrSeries(row.media_type) ?? 'movie';
    return {
        // Stable handle the model cites to make the title clickable, e.g.
        // [Die Hard](ref:562:movie). Resolved client-side against the cards.
        ref: row.primary_ext_id ? `${row.primary_ext_id}:${mediaType}` : null,
        title: row.title,
        mediaType,
        year: yearOf(row),
        overview: trimOverview(row.overview),
        imdbRating: row.imdb_rating ?? null,
        // null here means "we have no score", NEVER "unrated". The model is
        // instructed to say so rather than fill the gap from its own memory —
        // which is exactly what it did when find_media returned no RT data at all.
        rtRating: row.rt_rating ?? null,
        rtAudienceScore: row.rt_audience_score ?? null,
        runtimeMinutes: row.runtime_minutes ?? null,
        genres: genreNames(row),
        userRating: row.user_rating ?? null,
        isAvailable: Boolean(row.is_available),
        canRequest: Boolean(row.can_request),
        // Whether THIS user has already watched the title. Lets the model avoid
        // presenting a seen title as a fresh discovery (null → treated as false).
        watched: Boolean(row.watched),
    };
}

/**
 * Serialize rows into the compact JSON string fed back to the model in a
 * `tool` message. Includes a short note when empty so the model phrases the
 * "nothing found" case correctly instead of inventing results.
 */
export function summarizeMediaForModel(rows: AssistantMovieRow[], limit?: number): string {
    if (rows.length === 0) {
        return JSON.stringify({
            ...resultCounts(0, limit),
            results: [],
            note: 'No matching titles in the accessible library.',
        });
    }
    // A full page is indistinguishable from a complete result set unless we say
    // so, and the model kept turning the row count into a library total —
    // "wir haben 10 Tom-Hanks-Filme", "du hast zehn Titel abgebrochen", where
    // ten was simply the limit. See result-counts.ts for why the marker is
    // unconditional and why the field is no longer called `count`.
    return JSON.stringify({
        ...resultCounts(rows.length, limit),
        results: rows.map(toMediaSummary),
    });
}
