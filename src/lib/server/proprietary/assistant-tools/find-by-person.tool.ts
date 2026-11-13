// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `find_by_person` tool — library titles featuring a specific actor or
 * director. This is what makes "what else is <actor> in" / "movies with the
 * cast of X" answerable from real data instead of guesswork. Card-bearing,
 * access-scoped, ghost-excluded.
 *
 * @module server/proprietary/assistant-tools/find-by-person.tool
 */

import {
    findByPersonArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type FindByPersonArgs,
} from '../../../schemas/assistant-tools.js';
import {
    findMediaByPerson,
    type AssistantMovieRow,
} from '../../database/queries/assistant-rag.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { summarizeMediaForModel } from './media-summary.js';

const DEFAULT_LIMIT = 10;

export const findByPersonTool: AssistantTool<FindByPersonArgs> = {
    name: ASSISTANT_TOOL_NAMES.FIND_BY_PERSON,
    description:
        'Find titles in the library that feature a specific ACTOR or DIRECTOR (by name). Use for "what else is <actor> in", "other movies by <director>", or "what else have the cast of X been in" (first get_details on X to read its cast, then call this per actor). Only returns real matches from the library — never guess a person\'s filmography.',
    argsSchema: findByPersonArgsSchema,

    async execute(
        args: FindByPersonArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const media: AssistantMovieRow[] = await findMediaByPerson(ctx.sql, {
            person: args.person,
            mediaTypes: args.mediaType ? [args.mediaType] : ['movie', 'tv'],
            limit: args.limit ?? DEFAULT_LIMIT,
            userId: ctx.userId,
            access: searchAccessBoundary(ctx.accessCtx),
        });

        ctx.logger?.debug('find_by_person executed', {
            person: args.person,
            returned: media.length,
        });

        return {
            summaryForModel: summarizeMediaForModel(media, args.limit ?? DEFAULT_LIMIT),
            media,
        };
    },
};
