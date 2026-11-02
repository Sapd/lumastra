// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { findCollaborationArtists } from './artist-merge.queries.js';
import {
    CONJUNCTION_SYMBOL_REGEX_ERE,
    CONJUNCTION_WORD_REGEX_ERE,
} from '$lib/shared/artist-conjunction.js';

/**
 * BLOCKING-TIER coverage of the query that drives a REAL merge/split.
 *
 * `findCollaborationArtists` is the expensive half of the conjunction
 * heuristic: `music-hygiene.queries.ts` only COUNTS and LISTS these rows, this
 * one feeds the pass that rewrites them. Until now it had no blocking-tier test
 * at all — the `[[:space:]]*[&+][[:space:]]*` bug that queued the band `+44` for
 * SPLITTING could be reintroduced here on a green PR.
 *
 * What the marker regexes MATCH is asserted in
 * `$lib/shared/artist-conjunction.test.ts`; this file asserts that the SQL
 * actually shipped is still that module's rendering, and that the scope clauses
 * which keep the pass off the wrong rows are still present.
 */

/**
 * Render the query to its SQL text through a tagged-template stub.
 *
 * Joins the COOKED strings, not `strings.raw`. That is what postgres.js hands
 * the server, and it is the only rendering that can see the trap this series has
 * hit twice: inside a template literal JS strips the unrecognised escape `\.`
 * down to `.` — "any character" — before Postgres ever sees it, and `.raw` would
 * show the backslash that is no longer there. This query writes `\\.` and `\\s`
 * precisely so the cooked text keeps a real backslash.
 *
 * Nested SQL fragments now carry the reviewed-state fingerprint. Render those
 * fragments recursively while keeping the cooked marker regexes visible.
 */
async function collaborationArtistsSql(): Promise<string> {
    const stub = ((strings: TemplateStringsArray | string, ...vals: unknown[]) => {
        if (typeof strings === 'string') return strings;
        return Array.from(strings)
            .map((part, index) => part + (index < vals.length ? String(vals[index]) : ''))
            .join('');
    }) as unknown as postgres.Sql;

    const text = (await findCollaborationArtists(stub)) as unknown as string;
    return text;
}

describe('findCollaborationArtists — emitted SQL', () => {
    /**
     * The seam. `artist-conjunction.ts` owns the DEFINITION and this asserts the
     * shipped literal is that definition, so editing the regex here without
     * editing the table fails CI — and the semantics table in that module's own
     * suite is then provably describing the SQL that runs.
     *
     * Revert-check (INVERT): put the `*` quantifiers back and this fails; change
     * the shared table instead and the same assertion fails from the other side,
     * because the file literal no longer matches the rendering.
     */
    it('carries this repo`s ONE conjunction-marker rendering, verbatim', async () => {
        const sql = await collaborationArtistsSql();

        expect(sql).toContain(`title ~* '${CONJUNCTION_WORD_REGEX_ERE}'`);
        expect(sql).toContain(`title ~ '${CONJUNCTION_SYMBOL_REGEX_ERE}'`);
    });

    /**
     * The specific shape of the bug, spelled out so a reviewer reading a failure
     * sees what it was. Zero-or-more on each side reduces to "the name contains
     * an `&` or a `+` ANYWHERE" — `+44` with no conjunction present.
     */
    it('never accepts a zero-or-more quantifier around the symbol marker', async () => {
        const sql = await collaborationArtistsSql();

        expect(sql).not.toContain('\\s*[&+]');
        expect(sql).not.toContain('[&+]\\s*');
    });

    /**
     * The operator escape hatch for "Above & Lanterns". Losing this clause makes
     * the pass re-split every row a curator has already ruled on, which is the
     * one failure here that cannot be undone by acknowledging a count.
     */
    it('keeps the no_split escape hatch', async () => {
        const sql = await collaborationArtistsSql();

        expect(sql).toContain(`COALESCE(mi.custom_metadata->>'no_split', '') <> 'true'`);
        expect(sql).toContain(`mi.custom_metadata->>'collaboration_reviewed'`);
    });

    /**
     * The scope this query does NOT share with the hygiene fragment, pinned so
     * the two are not "reconciled" by copying clauses across. `parent_id IS
     * NULL` keeps the pass off child rows and `status = 'active'` off soft
     * deletes — a merge that walked either would rewrite rows no surface shows.
     */
    it('restricts to top-level active artist rows', async () => {
        const sql = await collaborationArtistsSql();

        expect(sql).toContain(`media_type = 'artist'`);
        expect(sql).toContain(`status = 'active'`);
        expect(sql).toContain('parent_id IS NULL');
    });
});
