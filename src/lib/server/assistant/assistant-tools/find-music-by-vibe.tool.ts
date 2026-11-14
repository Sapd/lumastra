// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `find_music_by_vibe` tool — CLAP text-to-sound search over the user's MUSIC
 * library. Unlike `get_music_picks` (taste-based, not mood-aware) or
 * `search_music` (name lookup), this matches actual AUDIO character to a
 * described sound. Gated on the `textToSound` feature — only registered when
 * the CLAP text-embedding backend is configured.
 *
 * WHAT THIS SPACE CAN AND CANNOT DO (measured on the 28k-vector production
 * corpus, msclap-2023, cosine over the shared 1024-dim projection):
 *
 *   - It represents TIMBRE, INSTRUMENTATION, ENERGY and PRODUCTION well.
 *     "calm solo piano" tops out at 0.564, "aggressive heavy metal guitar" at
 *     0.483 with 214 tracks above 0.40.
 *   - It does NOT represent an ACTIVITY or SITUATION. CLAP is trained on audio
 *     captions — on what is audible — and "cooking" has no audible correlate.
 *     "music for cooking" tops out at 0.336 across the whole corpus, so its
 *     top-k is just the corpus centroid: the reported bug returned Rod
 *     Stewart's Christmas album and Conway Twitty, faithfully.
 *   - It does NOT represent an ERA. cos("90s rock","80s rock") = 0.970 and
 *     cos("90s rock","rock music") = 0.827 — the decade token moves the vector
 *     LESS than deleting it does. See {@link stripEraTerms}.
 *   - The text encoder is ENGLISH-ONLY. cos("music for cooking","Musik zum
 *     Kochen") is only 0.524, while cos("Musik zum Kochen","rock music") is
 *     0.679 — a German phrase is a different, worse query, not a translation.
 *
 * Hence the two gates below: a confidence floor that turns "CLAP did not
 * understand this" into an explicit refusal instead of noise, and era-term
 * stripping that says so plainly instead of pretending to filter.
 *
 * TEXT-ONLY: music is not a movie/tv card, so this returns no `media` — the
 * model relays the matches in its reply.
 *
 * @module server/assistant/assistant-tools/find-music-by-vibe.tool
 */

import {
    findMusicByVibeArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type FindMusicByVibeArgs,
} from '../../../schemas/assistant-tools.js';
import { embedTextQuery } from '../../services/sonic-embedding.service.js';
import { textSoundSearch } from '../../database/queries/text-sound-search.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { musicCardFromVibeResult } from './music-card-builder.js';
import { resultCounts } from './result-counts.js';

const DEFAULT_LIMIT = 12;

/**
 * Cosine-similarity floor below which a CLAP hit is corpus noise, not a match.
 *
 * Measured on production (28 024 msclap-2023 vectors) — best score in the whole
 * corpus per query, and how many tracks clear 0.40:
 *
 * | query                          |   max | ≥ 0.40 |
 * |--------------------------------|-------|--------|
 * | music for cooking              | 0.336 |      0 |
 * | Musik zum Kochen               | 0.385 |      0 |
 * | workout energy                 | 0.397 |      0 |
 * | rainy evening music            | 0.422 |      8 |
 * | something chill for studying   | 0.423 |      7 |
 * | 90s rock                       | 0.468 |    376 |
 * | aggressive heavy metal guitar  | 0.483 |    214 |
 * | upbeat dance electronic beat   | 0.530 |   2672 |
 * | acoustic guitar folk singer    | 0.563 |    943 |
 * | calm solo piano                | 0.564 |     65 |
 *
 * 0.40 is where the corpus splits: every query CLAP can actually represent has
 * real matches above it, and every query it cannot has literally nothing above
 * it. It is deliberately NOT a quality bar — plenty of good matches sit at
 * 0.41 — it is the line between "this description landed somewhere" and "this
 * description landed on the centroid".
 *
 * The floor is applied in TS, never as a SQL `WHERE`: a never-satisfiable
 * predicate next to `ORDER BY embedding <=> vec LIMIT n` makes the planner walk
 * the whole HNSW index hunting for survivors that do not exist (the same trap
 * the query module's `denyAll` short-circuit exists to avoid). And because the
 * rows already arrive in descending similarity, no over-fetch is needed: the
 * best `limit` rows ARE the best `limit` rows above the floor.
 */
export const SIMILARITY_FLOOR = 0.4;

/**
 * Decade tokens in EN ("90s", "1990s", "eighties") and DE ("90er", "1980er
 * Jahre"). Global + case-insensitive so every occurrence is caught.
 */
const ERA_TERM_PATTERN =
    /\b(?:(?:19|20)?\d0s|(?:19|20)?\d0ern?(?:\s+jahren?)?|(?:twen|thir|for|fif|six|seven|eigh|nine)ties)\b/gi;

/** Result of {@link stripEraTerms}. */
export interface StrippedEraQuery {
    /** The query with era tokens removed (or the original, if removing them left nothing). */
    query: string;
    /** The era tokens found, in order of appearance. Empty when the query has none. */
    eraTerms: string[];
}

/**
 * Remove decade/era tokens from a vibe query.
 *
 * The embedding has no era axis at all, so a decade token contributes only
 * noise — it pulls the vector away from the genre the user actually named
 * (cos("90s rock","rock music") = 0.827) without encoding any period. Dropping
 * it produces a cleaner genre query; the caller then tells the model the era
 * was NOT honoured rather than letting it relabel a 1971 Yes track as 90s.
 *
 * If stripping leaves nothing usable (the query WAS the decade, e.g. "90s"),
 * the original is kept — a bad query still beats an empty one.
 */
export function stripEraTerms(query: string): StrippedEraQuery {
    const eraTerms = query.match(ERA_TERM_PATTERN) ?? [];
    if (eraTerms.length === 0) return { query, eraTerms: [] };

    const stripped = query.replace(ERA_TERM_PATTERN, ' ').replace(/\s+/g, ' ').trim();
    return { query: stripped.length >= 3 ? stripped : query, eraTerms };
}

/**
 * Shared tail for every note the model sees: what this search did NOT do.
 * `find_music_by_vibe` matches sound only — the library has no reliable
 * release-year data for music (`media_items.year` on an album is the year of
 * THAT pressing, so 64% of albums claim 2010 or later in a catalogue full of
 * Yes and Toto) and no music genre data at all.
 */
const SCOPE_NOTE =
    'This search matched SOUND only. It is not filtered by decade, era or genre, and this library has no reliable release-year data for music — never state or imply a release year, decade or era for these tracks.';

export const findMusicByVibeTool: AssistantTool<FindMusicByVibeArgs> = {
    name: ASSISTANT_TOOL_NAMES.FIND_MUSIC_BY_VIBE,
    description:
        'Search music by how it SOUNDS: timbre, instrumentation, voice, energy, tempo, production — "calm solo piano", "distorted aggressive guitar", "sparse acoustic folk with a soft male voice", "upbeat electronic dance beat". It matches the audio itself, not metadata, so restate the user\'s mood/activity as AUDIBLE QUALITIES in ENGLISH before calling ("music for cooking" -> "warm relaxed acoustic background music"; "workout" -> "fast driving high-energy beat"). It CANNOT filter by decade, era or genre name, and a bare activity or situation will not match anything. When nothing is close enough it returns no_confident_match — relay that plainly instead of guessing.',
    argsSchema: findMusicByVibeArgsSchema,

    async execute(
        args: FindMusicByVibeArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const limit = args.limit ?? DEFAULT_LIMIT;
        const { query: soundQuery, eraTerms } = stripEraTerms(args.query);
        // Only present when the user (or the model) asked for a decade, so the
        // model is told the era was dropped exactly when that matters.
        const eraFields =
            eraTerms.length > 0 ? { eraFilterApplied: false, eraTermsIgnored: eraTerms } : {};

        const vector = await embedTextQuery(soundQuery);
        if (vector === null) {
            ctx.logger?.warn('find_music_by_vibe: text-embedding backend unavailable', {
                query: soundQuery,
            });
            return {
                summaryForModel: JSON.stringify({
                    error: 'mood_search_unavailable',
                    note: 'The mood/vibe music search backend is currently unavailable. Tell the user you cannot filter music by mood right now, and offer get_music_picks or search_music instead.',
                }),
            };
        }

        // Project the context onto the required-by-shape boundary. Do NOT
        // hand-rebuild a field literal here: omitting an axis silently widened
        // access, which is exactly what MediaAccessBoundary exists to prevent.
        const rows = await textSoundSearch(
            ctx.sql,
            vector,
            limit,
            searchAccessBoundary(ctx.accessCtx),
        );

        const confident = rows.filter((r) => r.similarity_score >= SIMILARITY_FLOOR);

        if (confident.length === 0) {
            const best = rows.length > 0 ? Math.max(...rows.map((r) => r.similarity_score)) : null;
            ctx.logger?.debug('find_music_by_vibe: no confident match', {
                query: soundQuery,
                candidates: rows.length,
                best,
            });
            return {
                // No matches and no cards: below the floor the nearest tracks
                // are the corpus centroid, and showing them is the bug.
                summaryForModel: JSON.stringify({
                    error: 'no_confident_match',
                    similarityFloor: SIMILARITY_FLOOR,
                    bestSimilarity: best === null ? null : Number(best.toFixed(3)),
                    ...eraFields,
                    note: `Nothing in the music library sounds close enough to that description — the audio search found no track above the confidence threshold, so there is no answer to give. Tell the user plainly that you could not match that description against how the music actually sounds. Descriptions of an ACTIVITY or SITUATION (cooking, cleaning, a party) usually have no audible signature and cannot be matched; a description of the SOUND ("calm piano", "fast distorted guitar") can, so offer to retry with one. Otherwise offer get_music_picks or search_music. Do NOT name any track — none were returned. ${SCOPE_NOTE}`,
                }),
            };
        }

        const summaryForModel = JSON.stringify({
            ...resultCounts(confident.length, limit),
            similarityFloor: SIMILARITY_FLOOR,
            ...eraFields,
            note: `These are sonic (audio-character) matches to the requested sound, all above the confidence threshold. ${SCOPE_NOTE} If the user asked for a decade, genre or activity, say plainly that these are matched on sound alone.`,
            matches: confident.map((r) => ({
                title: r.title,
                artist: r.artist_title ?? undefined,
                album: r.album_title ?? undefined,
                similarity: Number(r.similarity_score.toFixed(3)),
            })),
        });

        ctx.logger?.debug('find_music_by_vibe executed', {
            query: soundQuery,
            candidates: rows.length,
            returned: confident.length,
        });

        return { summaryForModel, music: confident.map(musicCardFromVibeResult) };
    },
};
