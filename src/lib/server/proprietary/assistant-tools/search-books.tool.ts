// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `search_books` tool — search the Kavita library (books / manga / comics).
 *
 * Thin wrapper over the existing `kavita.search()` (the same client the search
 * route uses). Only registered when Kavita is configured (`features.kavita`);
 * also re-checks defensively. TEXT-ONLY — books are not movie/tv cards, so no
 * `media`/`music` is returned. Returns the matched series only (the unit the
 * library is organized around).
 *
 * @module server/proprietary/assistant-tools/search-books.tool
 */

import {
    searchBooksArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type SearchBooksArgs,
} from '../../../schemas/assistant-tools.js';
import * as kavita from '../../plugins/kavita/index.js';
import { features } from '../../config.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { resultCounts } from './result-counts.js';

const MAX_RESULTS = 15;

export const searchBooksTool: AssistantTool<SearchBooksArgs> = {
    name: ASSISTANT_TOOL_NAMES.SEARCH_BOOKS,
    description:
        'Search the Kavita library (e-books, manga, comics) by title or series ("do we have Berserk", "the Mistborn books"). Returns matching series. Use only for books/manga/comics, not audiobooks or movies.',
    argsSchema: searchBooksArgsSchema,

    async execute(
        args: SearchBooksArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        if (!features.kavita) {
            return {
                summaryForModel: JSON.stringify({
                    available: false,
                    note: 'Books (Kavita) are not configured on this server.',
                }),
            };
        }

        let series;
        try {
            const result = await kavita.search({
                query: args.query,
                includeChapterAndFiles: false,
            });
            series = (Array.isArray(result.series) ? result.series : []).slice(0, MAX_RESULTS);
        } catch (err) {
            ctx.logger?.warn('search_books failed', {
                query: args.query,
                error: err instanceof Error ? err.message : String(err),
            });
            return {
                summaryForModel: JSON.stringify({
                    available: true,
                    error: true,
                    note: 'The book service could not be reached right now.',
                }),
            };
        }

        ctx.logger?.debug('search_books executed', {
            query: args.query,
            returned: series.length,
        });

        return {
            summaryForModel: JSON.stringify({
                available: true,
                found: series.length > 0,
                // Kavita is asked for at most MAX_RESULTS, so this list is a
                // page like every other tool's — say so in the same words.
                ...resultCounts(series.length, MAX_RESULTS),
                results: series.map((s) => ({
                    title: s.name,
                    originalName: s.originalName ?? undefined,
                    library: s.libraryName ?? undefined,
                })),
                note: series.length === 0 ? `No books match "${args.query}".` : undefined,
            }),
        };
    },
};
