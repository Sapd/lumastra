// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `search_audiobooks` tool — search the local audiobook catalog.
 *
 * Queries `media_items` via `getAudiobookEntries` — the SAME boundary-scoped
 * query module `get_audiobook_progress` (its sibling assistant tool) uses —
 * rather than calling AudiobookShelf directly. The tool used to be a thin
 * wrapper over `audiobookshelfClient.search()`, which fans a query out across
 * every ABS library using the server's own admin token: it had no concept of
 * Lumastra's `library_group_permissions` or age-rating ceiling, so it
 * returned audiobooks a caller's own account is explicitly denied. Both
 * `getAudiobookEntries` and `get_audiobook_progress`'s `getAudiobooksInProgress`
 * apply the same pair of builders (`buildLibraryGroupColumnFilter` +
 * `buildAgeRatingFilter`) from `audiobook-browse.queries.ts` — the
 * file-less-row-aware equivalent of the standard library/age filter, since
 * ABS books have no `media_files` row for the usual filter to key off (see
 * that module's own header comment). Security review 4, C9 (2026-09-18).
 *
 * `query` free-texts over title, derived series name, authors and narrators
 * (see `AudiobookFilter.query`'s doc comment), matching this tool's own
 * "title, author, or series" description. Only registered when Audiobookshelf
 * is configured (`features.audiobooks`); also re-checks defensively.
 * TEXT-ONLY — audiobooks are not movie/tv cards, so no `media`/`music` is
 * returned.
 *
 * @module server/proprietary/assistant-tools/search-audiobooks.tool
 */

import {
    searchAudiobooksArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type SearchAudiobooksArgs,
} from '../../../schemas/assistant-tools.js';
import { getAudiobookEntries } from '../../database/queries/audiobook-browse.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import { features } from '../../config.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { resultCounts } from './result-counts.js';

const MAX_RESULTS = 15;

export const searchAudiobooksTool: AssistantTool<SearchAudiobooksArgs> = {
    name: ASSISTANT_TOOL_NAMES.SEARCH_AUDIOBOOKS,
    description:
        'Search the audiobook library by title, author, or series ("do we have the Dune audiobook", "audiobooks by Brandon Sanderson"). Returns matching audiobooks. Use only for audiobooks, not e-books or movies.',
    argsSchema: searchAudiobooksArgsSchema,

    async execute(
        args: SearchAudiobooksArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        if (!features.audiobooks) {
            return {
                summaryForModel: JSON.stringify({
                    available: false,
                    note: 'Audiobooks are not configured on this server.',
                }),
            };
        }

        let result;
        try {
            result = await getAudiobookEntries(ctx.sql, {
                access: searchAccessBoundary(ctx.accessCtx),
                query: args.query,
                limit: MAX_RESULTS,
                offset: 0,
                sort: 'title_asc',
            });
        } catch (err) {
            ctx.logger?.warn('search_audiobooks failed', {
                query: args.query,
                error: err instanceof Error ? err.message : String(err),
            });
            return {
                summaryForModel: JSON.stringify({
                    available: true,
                    error: true,
                    note: 'The audiobook service could not be reached right now.',
                }),
            };
        }

        ctx.logger?.debug('search_audiobooks executed', {
            query: args.query,
            returned: result.entries.length,
        });

        const mapped = result.entries.map((entry) => ({
            title: entry.title,
            // A collapsed series entry's "author" is the same array on every
            // book in it (derived from the first book by sequence) — accurate
            // for the entry as a whole, not a guess.
            author: entry.authors[0] ?? undefined,
            authors: entry.authors.length > 1 ? entry.authors : undefined,
            series: entry.kind === 'series' ? entry.title : (entry.seriesName ?? undefined),
            bookCount: entry.kind === 'series' ? entry.bookCount : undefined,
            year: entry.year ?? undefined,
        }));

        return {
            summaryForModel: JSON.stringify({
                available: true,
                found: mapped.length > 0,
                // Capped at MAX_RESULTS upstream — a page, not a catalogue count.
                ...resultCounts(mapped.length, MAX_RESULTS),
                results: mapped,
                note: mapped.length === 0 ? `No audiobooks match "${args.query}".` : undefined,
            }),
        };
    },
};
