// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared result payloads for the WRITE tools.
 *
 * Three rules are encoded here rather than restated in each tool:
 *
 * 1. **A write tool never throws.** The dispatch loop deliberately replaces any
 *    thrown error with `Error: tool "X" failed.` so `err.message` cannot leak
 *    SQL to the model. For a read tool that is fine; for a write it destroys
 *    the only truthful thing the tool knew — whether the write happened. So
 *    every failure comes back as a JSON refusal the model can quote.
 *
 * 2. **Every refusal ends with an explicit negative sentence** ("Nothing was
 *    saved.", "The rating was not saved."). `ok: false` alone is too easy for a
 *    model to skim past on its way to "I've added it for you!"; a plain-prose
 *    denial in the payload is what actually stops that sentence being written.
 *
 * 3. **"Not accessible" and "does not exist" are the SAME refusal.** Both come
 *    back as `not_found` with identical wording. A distinct "you may not touch
 *    that" reason would confirm the item exists, which is exactly the leak the
 *    404-not-403 convention elsewhere in this codebase exists to prevent.
 *
 * @module server/assistant/assistant-tools/write-result
 */

import { toMovieOrSeries } from '$lib/shared/media-type-domain.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';
import type { AmbiguousCandidate } from './resolve-title.js';
import type { AssistantToolExecuteResult } from './types.js';

/**
 * The clickable handle the model cites, e.g. `[Fargo](ref:275:movie)`.
 *
 * MUST use the PUBLIC vocabulary — `series`, never `tv`. Card refs are matched
 * as `${id}:${card.mediaType}` and cards carry the public type, so a `:tv` ref
 * is a dead link. Null when the row has no primary provider id (a real case:
 * some active rows carry no TMDB primary id at all).
 */
export function mediaRef(row: AssistantMovieRow): string | null {
    const type = publicMediaType(row);
    // No id, or a type the cards have no vocabulary for, means no link. An
    // approximate ref is worse than none: it renders as a click that goes
    // nowhere.
    if (!row.primary_ext_id || !type) return null;
    return `${row.primary_ext_id}:${type}`;
}

/**
 * Row media type in the PUBLIC vocabulary, or null when it maps to nothing the
 * client can render. Never defaulted — a fabricated 'movie' for an unmapped
 * type would have the model describe a series as a film.
 */
export function publicMediaType(row: AssistantMovieRow): 'movie' | 'series' | null {
    return toMovieOrSeries(row.media_type);
}

/** Year from the `YYYY-01-01` string the access-scoped query synthesises. */
export function mediaYear(row: AssistantMovieRow): number | null {
    const parsed = Number(String(row.release_date ?? '').slice(0, 4));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function payload(body: Record<string, unknown>): AssistantToolExecuteResult {
    return { summaryForModel: JSON.stringify(body) };
}

/**
 * No accessible title matched. Used for BOTH "no such title" and "the caller
 * may not see it" — see rule 3 above; do not split these.
 */
export function refuseNotFound(
    args: { title: string; year?: number; mediaType?: 'movie' | 'tv' },
    nothingHappened: string,
): AssistantToolExecuteResult {
    // Name the TYPE when the caller constrained it. resolveTitleForWrite applies
    // `mediaType` as a HARD filter, so asking for the movie when the library
    // holds only the series lands here — and the unqualified "No movie or show
    // matching X is available here" told the user the title was absent
    // altogether. It exists; it is the other type. Saying which was asked for
    // lets the model drop the constraint instead of giving up.
    //
    // This does NOT split the two meanings of not_found (rule 3): a row removed
    // by the type filter had already passed the access boundary, so naming the
    // requested type leaks nothing about what the caller may not see.
    const subject =
        args.mediaType === 'movie' ? 'movie' : args.mediaType === 'tv' ? 'show' : 'movie or show';
    return payload({
        ok: false,
        reason: 'not_found',
        note: `No ${subject} matching "${args.title}"${args.year ? ` (${args.year})` : ''} is available here. ${nothingHappened} Do not retry with a different spelling more than once; tell the user it could not be found${args.mediaType ? ' as a ' + subject : ''}.`,
    });
}

/** Several equally-plausible matches — the model must ask, not guess. */
export function refuseAmbiguous(
    candidates: AmbiguousCandidate[],
    nothingHappened: string,
): AssistantToolExecuteResult {
    return payload({
        ok: false,
        reason: 'ambiguous',
        candidates,
        note: `Several different titles match. ${nothingHappened} Name the candidates to the user and ask which one they mean — do NOT pick one yourself.`,
    });
}

/** The write itself failed (DB error, dependency down). */
export function refuseFailed(nothingHappened: string): AssistantToolExecuteResult {
    return payload({
        ok: false,
        reason: 'failed',
        note: `The change could not be applied. ${nothingHappened} Say so plainly and suggest the user try again later.`,
    });
}

/**
 * Defence in depth: this run may not mutate user state at all. Should be
 * unreachable — `buildAssistantTools` does not register write tools when
 * `writesAllowed` is false, so the model never sees them.
 */
export function refuseWritesDisabled(nothingHappened: string): AssistantToolExecuteResult {
    return payload({
        ok: false,
        reason: 'not_allowed',
        note: `Changing saved data is not available in this context. ${nothingHappened}`,
    });
}

/** A successful write. `body` carries the action-specific fields. */
export function writeOk(body: Record<string, unknown>): AssistantToolExecuteResult {
    return payload({ ok: true, ...body });
}
