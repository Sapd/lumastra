// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { buildMusicHygieneFragment } from './music-hygiene.queries.js';
import {
    CONJUNCTION_SYMBOL_REGEX_ERE,
    CONJUNCTION_SYMBOL_REGEX_POSIX,
    CONJUNCTION_WORD_REGEX_ERE,
    CONJUNCTION_WORD_REGEX_POSIX,
} from '$lib/shared/artist-conjunction.js';
import {
    MUSIC_HYGIENE_ALBUM_NO_ARTIST,
    MUSIC_HYGIENE_ARTIST_UNSPLIT,
    MUSIC_HYGIENE_FINDINGS,
    MUSIC_HYGIENE_TITLE_FROM_FILENAME,
    MUSIC_HYGIENE_TRACK_NO_ARTIST,
    type MusicHygieneFinding,
} from '$lib/shared/music-hygiene.js';

/**
 * BLOCKING-TIER coverage of the predicates. The discriminating cases — the
 * conjunction markers, the recorded title source — are otherwise asserted ONLY in
 * `music-hygiene.queries.integration.test.ts`, and that file gates nothing:
 *
 *   package.json  → `test`: `vitest run --exclude='**\/*.integration.test.ts'`
 *   test.yml      → the `integration-tests` job is `continue-on-error: true`
 *
 * So loosening the `&`/`+` whitespace rule — which flags a band literally named
 * `+44`, the exact false-positive class this whole feature is shaped to avoid —
 * would otherwise ship on a green PR.
 *
 * This file does not replace the integration test, which proves the predicates
 * match the right ROWS against a real Postgres. It pins that the clauses which
 * make them defensible are still IN the emitted SQL, which is cheap, runs in the
 * blocking tier, and is what actually stops a silent deletion.
 */

/**
 * Render a fragment to its SQL text through a tagged-template stub.
 *
 * The reviewed-state fragment nests SQL and identifier fragments. Render those
 * recursively so the marker predicates remain visible in the assertion.
 */
function sqlTextOf(finding: MusicHygieneFinding): string {
    const stub = ((strings: TemplateStringsArray | string, ...vals: unknown[]) => {
        if (typeof strings === 'string') return strings;
        return Array.from(strings)
            .map((part, index) => part + (index < vals.length ? String(vals[index]) : ''))
            .join('');
    }) as unknown as postgres.Sql;

    const text = buildMusicHygieneFragment(stub, finding) as unknown as string;
    return text;
}

describe('buildMusicHygieneFragment — emitted SQL', () => {
    it('pins every finding to its own media_type', () => {
        expect(sqlTextOf(MUSIC_HYGIENE_TRACK_NO_ARTIST)).toContain("mi.media_type = 'track'");
        expect(sqlTextOf(MUSIC_HYGIENE_ALBUM_NO_ARTIST)).toContain("mi.media_type = 'album'");
        expect(sqlTextOf(MUSIC_HYGIENE_TITLE_FROM_FILENAME)).toContain("mi.media_type = 'track'");
        expect(sqlTextOf(MUSIC_HYGIENE_ARTIST_UNSPLIT)).toContain("mi.media_type = 'artist'");
    });

    /**
     * The finding reads the source the scanner RECORDED, through the partial
     * index `idx_media_items_track_title_from_filename`. A regression back to
     * reconstructing filename shapes (an unindexable ~800 ms regexp pass that
     * could not tell which derivation branch ran) fails here.
     *
     * Revert-check: restore the old `EXISTS (… media_files … regexp_replace …)`
     * body and both halves fail.
     */
    it('reads the recorded title source, not a filename reconstruction', () => {
        const sql = sqlTextOf(MUSIC_HYGIENE_TITLE_FROM_FILENAME);
        expect(sql).toContain("mi.title_source = 'filename'");
        expect(sql).not.toMatch(/regexp_replace|file_path|media_files/);
    });

    /**
     * F2. `[[:space:]]*[&+][[:space:]]*` — zero-or-more on both sides — reduces
     * to "contains `&` or `+` ANYWHERE", so a band literally named `+44` was
     * flagged with no conjunction present. That is the same indefensible finding
     * the module header rejects a junk-title heuristic to avoid, in the one
     * catalogue where `+`, `-` and `=` are real album titles.
     *
     * Revert-check (INVERT): put the `*` quantifiers back and BOTH halves fail.
     */
    it('requires real whitespace on both sides of the &/+ conjunction', () => {
        const sql = sqlTextOf(MUSIC_HYGIENE_ARTIST_UNSPLIT);

        expect(sql).toContain(`mi.title ~ '${CONJUNCTION_SYMBOL_REGEX_POSIX}'`);
        expect(sql).not.toContain('[[:space:]]*[&+]');
        expect(sql).not.toContain("[&+][[:space:]]*'");
    });

    it('keeps the word-marker branch whitespace-flanked and the no_split escape hatch', () => {
        const sql = sqlTextOf(MUSIC_HYGIENE_ARTIST_UNSPLIT);

        expect(sql).toContain(`mi.title ~* '${CONJUNCTION_WORD_REGEX_POSIX}'`);
        expect(sql).toContain("COALESCE(mi.custom_metadata->>'no_split', '') <> 'true'");
    });

    /**
     * The mirror `music-hygiene.queries.ts` documents. `findCollaborationArtists`
     * is the pass that ACTS on these rows; if the two drift, the browser lists
     * rows the merge will never touch, or hides rows it is about to rewrite.
     * The `+44` bug lived in both, and splitting a band called `+44` is the more
     * expensive half.
     *
     * Both files now render ONE table — `$lib/shared/artist-conjunction.ts` —
     * and the assertions above already pin this fragment to its POSIX rendering.
     * This one closes the loop from the other side, on the merge query's SOURCE
     * text: a text compare between the two FILES could only ever assert they are
     * spelled differently (that query writes JS `\\s`, a real backslash reaching
     * Postgres, where this fragment uses POSIX classes), so the shared rendering
     * is re-escaped the way a template literal has to be written instead.
     *
     * `artist-merge.queries.test.ts` asserts the same thing against the EMITTED
     * SQL. Both are kept: this one fails on the source spelling (the `\\.`-vs-`.`
     * trap), that one fails on what Postgres actually receives.
     */
    it('keeps the artist-merge pass on the same markers', () => {
        const mergeSource = readFileSync(
            new URL('./artist-merge.queries.ts', import.meta.url),
            'utf8',
        );
        // A single backslash in the pattern has to be written as two in the
        // template literal, or JS strips the escape before Postgres sees it.
        const asWritten = (pattern: string) => pattern.split('\\').join('\\\\');

        // Both branches, whitespace-flanked on both sides, `+` not `*`.
        expect(mergeSource).toContain(`title ~* '${asWritten(CONJUNCTION_WORD_REGEX_ERE)}'`);
        expect(mergeSource).toContain(`title ~ '${asWritten(CONJUNCTION_SYMBOL_REGEX_ERE)}'`);
        expect(mergeSource).not.toContain('\\\\s*[&+]');
    });

    /**
     * The trap that has been hit twice in this series: inside a JS template
     * literal `\.` is an unrecognised escape that JS strips BEFORE Postgres sees
     * it, silently turning an escaped dot into `.` — "any character". Every
     * regex in this module therefore uses `[.]`, and no single backslash may
     * appear in the file at all.
     */
    it('never writes a single-backslash escape into a template-literal regex', () => {
        const source = readFileSync(new URL('./music-hygiene.queries.ts', import.meta.url), 'utf8');
        // Doc comments legitimately DISCUSS `\s`; only code may not contain it.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        const backslashes = code.match(/\\/g) ?? [];
        expect(backslashes, `found ${backslashes.length} backslash(es) in code`).toHaveLength(0);
    });

    it('emits a self-scoping fragment for every finding', () => {
        for (const finding of MUSIC_HYGIENE_FINDINGS) {
            const sql = sqlTextOf(finding);
            expect(sql.startsWith('AND mi.media_type = '), finding).toBe(true);
        }
    });
});
