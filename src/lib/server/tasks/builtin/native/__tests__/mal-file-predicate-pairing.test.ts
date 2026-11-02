// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `recoverWhenAdditionalReasons` lists 'mal:no-files', which lets the sweep flip a
 * tombstoned series back to pending the moment eligibility.sql holds again. That is
 * only safe while the tombstone predicate and the eligibility predicate are EXACT
 * complements — tombstone iff NOT eligible.
 *
 * They drifted once already: the tombstone check was a WITH RECURSIVE over the whole
 * subtree (including the series row), the eligibility clause was strictly
 * series -> season -> episode. A file on the series row itself then satisfied the
 * tombstone check (so the row was never tombstoned) but not eligibility (so it was
 * never enriched) — the series simply fell between them, permanently. An already
 * tombstoned row in that shape could never be revived.
 *
 * Nothing else catches this. Both predicates are SQL strings: typecheck cannot compare
 * them, and a unit test that mocks `sql` sees whichever answer the mock was told to
 * give. So compare the two SQL texts directly and require them to be the same shape.
 */
const SOURCE = readFileSync(
    fileURLToPath(new URL('../mal-anime-id-enrichment.ts', import.meta.url)),
    'utf-8',
);

/** Strip comments/whitespace and unify the subject so only the tested shape remains. */
function normalizeFilePredicate(sql: string): string {
    return sql
        .replace(/--[^\n]*/g, '')
        .replace(/\$\{seriesId\}/g, '<SUBJECT>')
        .replace(/\bmi\.id\b/g, '<SUBJECT>')
        .replace(/\s+/g, ' ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .trim();
}

/** All three EXISTS clauses of one predicate, in order. */
function extractExistsClauses(block: string): string[] {
    return [...block.matchAll(/EXISTS\s*\((?:[^()]|\([^()]*\))*\)/gs)].map((m) =>
        normalizeFilePredicate(m[0]),
    );
}

describe('MAL file-presence predicate pairing', () => {
    const tombstoneBlock = SOURCE.slice(
        SOURCE.indexOf('const [{ has_file:'),
        SOURCE.indexOf('AS has_file'),
    );
    // Anchor the end search AFTER the start: 'coversStages' is also named in a comment
    // further up the file, and slicing to that earlier hit yields an empty block — which
    // would make this whole test vacuously pass. Hence the length assertions below.
    const eligibilityStart = SOURCE.indexOf('eligibility: {');
    const eligibilityBlock = SOURCE.slice(
        eligibilityStart,
        SOURCE.indexOf('coversStages', eligibilityStart),
    );

    it('the tombstone check and eligibility.sql test file presence identically', () => {
        const tombstone = extractExistsClauses(tombstoneBlock);
        const eligibility = extractExistsClauses(eligibilityBlock).filter((c) =>
            c.includes('media_file_items'),
        );

        // Both must actually have been found — a rename that breaks the slicing above
        // must fail loudly rather than silently comparing two empty arrays.
        expect(tombstone.length).toBeGreaterThan(0);
        expect(eligibility.length).toBeGreaterThan(0);

        expect(eligibility).toEqual(tombstone);
    });

    it('covers the series row itself, not just season and episode', () => {
        // The original bug in one line: depth 0 was missing from eligibility. A file
        // attached directly to a series is rare but real (a single-file "series" folder),
        // and it is exactly the case that fell between the two predicates.
        const tombstone = extractExistsClauses(tombstoneBlock);
        expect(tombstone.some((c) => c.includes('mfi.media_item_id = <SUBJECT>'))).toBe(true);
    });

    it('neither predicate uses WITH RECURSIVE', () => {
        // Not style: the sweep runs eligibility per candidate row every 60s, so the
        // recursive form cannot be adopted there. Keeping both non-recursive is what
        // makes "identical shape" achievable at all.
        const stripComments = (b: string) => b.replace(/--[^\n]*/g, '');
        expect(stripComments(tombstoneBlock)).not.toContain('RECURSIVE');
        expect(stripComments(eligibilityBlock)).not.toContain('RECURSIVE');
    });
});
