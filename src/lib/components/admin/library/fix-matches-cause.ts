// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Why a "Broken match" row is broken, read from the stored stage error, so the
 * Fix matches view can put the right action first instead of offering the same
 * three buttons for every cause.
 *
 * The queue only holds rows a stage marked `retryable: false`, but that flag is
 * sometimes wrong: a provider timeout ("The operation was aborted due to
 * timeout") has been stored as permanent. Those get Retry, not "re-identify".
 */

export type BrokenMatchCause =
    /** Provider was slow or unreachable — retrying is the fix. */
    | 'temporary'
    /** The stored provider id no longer resolves (404, "has no …"). */
    | 'stale-id'
    /** Matched as the wrong kind (movie vs series). */
    | 'wrong-type'
    /** The stage gave no usable reason. */
    | 'unknown';

const TEMPORARY =
    /\btime(?:d)?[ -]?out\b|timeout|\baborted\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network error|\b(?:429|502|503|504)\b|rate.?limit|too many requests|service unavailable/i;
const WRONG_TYPE =
    /wrong (?:media )?type|media[ _-]?type mismatch|type mismatch|not a (?:movie|series|tv show)/i;
const STALE_ID =
    /\b404\b|not found|has no (?:series|movie|show|season|episode)|no longer (?:exists|resolves)|stale|invalid (?:tmdb|imdb|tvdb|provider) id/i;

export function classifyBrokenMatch(input: {
    errorMessage?: string | null;
    errorCode?: string | null;
}): BrokenMatchCause {
    const text = `${input.errorCode ?? ''} ${input.errorMessage ?? ''}`;
    if (TEMPORARY.test(text)) return 'temporary';
    if (WRONG_TYPE.test(text)) return 'wrong-type';
    if (STALE_ID.test(text)) return 'stale-id';
    return 'unknown';
}

/** The run-wrapper's fallback when a stage gave no reason — carries no information. */
export const GENERIC_PERMANENT_FAILURE = 'Task reported a permanent failure';
