// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test — RAG vector query joined the WRONG embedding source.
 *
 * `findRelevantMediaByVector` requires `mi.has_files = true` (library-owned,
 * watchable titles). Library items carry a `library`-sourced embedding;
 * `discovery`-sourced embeddings only exist for catalog items NOT in the
 * library (`has_files = false`) — the two are mutually exclusive by design
 * (see embedding-source.ts).
 *
 * A "exclude ghosts" change (commit fe609804b) added `AND mi.has_files = true`
 * but left the embedding join on `source = 'discovery'`. The two predicates
 * can never be true together, so the query returned ZERO rows in production
 * (verified: 3093 library movies/TV, 0 with a discovery embedding, 3092 with a
 * library embedding). The assistant's get_recommendations / search-library
 * tools therefore always got an empty result and the bot replied "I don't have
 * any recommendations for you" to every open-ended request.
 *
 * Guard: the join must use the `library` source, never `discovery`.
 *
 * Citation: src/lib/server/database/queries/assistant-rag.queries.ts (findRelevantMediaByVector)
 */

import { describe, it, expect } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';

describe('findRelevantMediaByVector — embedding source matches has_files scope', () => {
    it('joins media_embeddings on the library source, not discovery', async () => {
        const { findRelevantMediaByVector } =
            await import('$lib/server/database/queries/assistant-rag.queries.js');

        let capturedQuery = '';
        const mockSql = Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => {
                capturedQuery = strings.reduce((acc, str, i) => {
                    const val = values[i] ?? '';
                    return acc + str + (typeof val === 'string' ? `'${val}'` : String(val));
                }, '');
                return Promise.resolve([]);
            },
            {
                json: (v: unknown) => v,
                unsafe: (v: string) => v,
            },
        ) as unknown as import('postgres').Sql;

        try {
            await findRelevantMediaByVector(mockSql, {
                queryEmbeddingStr: '[0.1,0.2,0.3]',
                userId: toUserId('aaaaaaaa-0000-0000-0000-000000000001'),
                access: unrestrictedAccess(),
            });
        } catch {
            // We only care about the captured SQL
        }

        // The query filters has_files = true (library-owned items)...
        expect(capturedQuery).toContain('has_files = true');
        // ...so it must join the LIBRARY embedding, which is the source those
        // items carry. Joining 'discovery' here matches nothing → empty results.
        expect(capturedQuery).toContain("me.source = 'library'");
        expect(capturedQuery).not.toContain("me.source = 'discovery'");
    });
});
