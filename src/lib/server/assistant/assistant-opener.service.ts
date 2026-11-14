// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The proactive chat opener — one suggestion, picked from data the user
 * already has.
 *
 * Deliberately NOT an LLM call. This runs on every chat open, and a model call
 * there would spend the user's daily token budget before they have asked
 * anything, add seconds of latency to a page load, and (on this assistant's
 * track record) occasionally invent a title. Everything here is an indexed
 * read through a query that already exists.
 *
 * It returns STRUCTURED data, never prose: the client owns the wording, so the
 * greeting and the suggestion are localised by paraglide on the side that has
 * the message catalogue, and the user's own clock decides "good morning".
 *
 * Priority is by intent, strongest first — something you already started beats
 * something you saved, which beats something that merely arrived.
 *
 * @module server/assistant/assistant-opener.service
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import type { SearchAccessContext } from '$lib/server/utils/search-access-context';
import { searchAccessBoundary } from '$lib/server/utils/search-access-context';
import { getAudiobooksInProgress } from '../database/queries/audiobook-browse.queries.js';
import { findMediaByConstraints } from '../database/queries/assistant-rag.queries.js';
import { getUserWatchlistMedia } from '../database/queries/watchlist-media.queries.js';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('AssistantOpener');

/** How recent an addition still counts as "new". */
const NEW_ARRIVAL_DAYS = 14;
/** Enough rows that a titleless one at the front doesn't cost us the hook. */
const WATCHLIST_PROBE_LIMIT = 5;

/**
 * Which hook was chosen. The client maps this to a localised line and to the
 * question it drops into the input box.
 */
export type AssistantOpenerHookKind =
    'resume_audiobook' | 'new_arrival' | 'watchlist' | 'top_rated';

export interface AssistantOpenerHook {
    kind: AssistantOpenerHookKind;
    /** The title to name. Always a real row — never a placeholder. */
    title: string;
    /** Whole minutes left, `resume_audiobook` only and only when the length is known. */
    remainingMinutes?: number;
}

export interface AssistantOpener {
    /** `null` means "say hello, suggest nothing" — a legitimate outcome. */
    hook: AssistantOpenerHook | null;
}

export interface AssistantOpenerArgs {
    sql: postgres.Sql;
    userId: UserId;
    accessCtx: SearchAccessContext;
}

/** No hook. Used for every failure and every genuine empty. */
const NOTHING: AssistantOpener = { hook: null };

/**
 * Pick one opener hook for this user, or none.
 *
 * Never throws: this decorates a page the user opened to do something else, so
 * a database hiccup must cost the greeting, not the chat.
 */
export async function buildAssistantOpener(args: AssistantOpenerArgs): Promise<AssistantOpener> {
    const { sql, userId, accessCtx } = args;
    const access = searchAccessBoundary(accessCtx);

    try {
        // 1. Mid-way through a book — the strongest signal there is, because the
        //    user already committed hours to it.
        const [book] = await getAudiobooksInProgress(sql, { userId, access, limit: 1 });
        if (book?.title) {
            // Under a minute left rounds to 0, and "dir fehlen noch 0 min bei X"
            // is not a thing to say to someone. `undefined` is already the
            // "how much is left is not worth stating" case: the client renders
            // the no-time wording for it.
            const remainingMs =
                typeof book.durationMs === 'number' ? book.durationMs - book.positionMs : 0;
            const remaining = remainingMs >= 60_000 ? Math.round(remainingMs / 60_000) : undefined;
            return {
                hook: { kind: 'resume_audiobook', title: book.title, remainingMinutes: remaining },
            };
        }

        // 2. Something arrived recently that they have not seen. `addedWithinDays`
        //    is INGEST date, not release year — see findMediaByConstraints.
        const [fresh] = await findMediaByConstraints(sql, {
            userId,
            access,
            addedWithinDays: NEW_ARRIVAL_DAYS,
            sortBy: 'newest_added',
            watched: false,
            limit: 1,
        });
        if (fresh?.title) return { hook: { kind: 'new_arrival', title: fresh.title } };

        // 3. Something they deliberately saved.
        // Paged, like the three lookups around it. Omitting the page returns the
        // WHOLE watchlist just to read one title off the front, on every cache
        // miss. A few rows rather than one: the first is not guaranteed to carry
        // a title, which is what the `.find()` below is for.
        const saved = await getUserWatchlistMedia(
            sql,
            userId,
            {
                deniedGroupIds: accessCtx.deniedGroupIds,
                ageRating: accessCtx.ageRating,
            },
            { limit: WATCHLIST_PROBE_LIMIT, offset: 0 },
        );
        const savedTitle = saved.find((row) => Boolean(row?.title))?.title;
        if (savedTitle) return { hook: { kind: 'watchlist', title: savedTitle } };

        // 4. Last resort: the best-reviewed thing they have not watched. Since the
        //    rating sort was fixed this is a real ranking, not alphabetical order.
        const [best] = await findMediaByConstraints(sql, {
            userId,
            access,
            sortBy: 'rating',
            watched: false,
            limit: 1,
        });
        if (best?.title) return { hook: { kind: 'top_rated', title: best.title } };

        return NOTHING;
    } catch (error) {
        logger.warn('Opener suggestion unavailable; falling back to a plain greeting', {
            error: error instanceof Error ? error.message : String(error),
        });
        return NOTHING;
    }
}
