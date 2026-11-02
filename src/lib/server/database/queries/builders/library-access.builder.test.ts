// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pinned-SQL tests for `buildLibraryAccessFilter`'s container-aware predicate.
 *
 * Container rows (`tv`, `season`, `artist`, `album`) own no `media_file_items`
 * of their own — only their leaf descendants (`episode`, `track`) do. The old
 * predicate's `NOT EXISTS (media_file_items ...)` branch therefore always
 * passed for a container row, regardless of which library group its
 * descendants' files actually lived in (C3, task 4). These tests pin the
 * per-media_type SQL shape so that fail-open branch can never silently come
 * back for `tv`/`season`/`artist`/`album`.
 *
 * Fix round 1 (2026-09-13): each container branch must ALSO stay visible when
 * it has zero descendant files at all (an empty container — request/watchlist
 * stub, or a season synced ahead of its episodes) — an `EXISTS`-only
 * predicate made such a stub invisible to any user under ANY active
 * library-group restriction, even one unrelated to that item. The tests below
 * pin the `NOT EXISTS (any descendant file) OR EXISTS (non-denied descendant
 * file)` two-clause shape per container branch, mirroring the leaf rule.
 */

import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import { buildLibraryAccessFilter } from './library-access.builder.js';

// Never connected — we only inspect the template fragments it produces.
const sql = postgres('postgres://localhost');

/**
 * A table alias reaches the template as `sql(alias)`, which postgres.js turns
 * into an `Identifier` — spliced into the SQL TEXT as a quoted identifier
 * (`"mi"`), never bound as a parameter. `render` must therefore resolve those
 * back into the text, or every aliased reference would read as a `?` and the
 * pinned-SQL assertions below would be asserting nothing.
 */
function isIdentifier(arg: unknown): arg is { value: string } {
    return (
        typeof arg === 'object' &&
        arg !== null &&
        arg.constructor?.name === 'Identifier' &&
        typeof (arg as { value?: unknown }).value === 'string'
    );
}

/**
 * Flatten a postgres.js template fragment to its literal SQL text: identifiers
 * inlined as postgres.js emits them, `?` for each genuinely bound parameter.
 */
function render(fragment: unknown): string {
    const { strings, args } = fragment as {
        strings?: readonly string[];
        args?: readonly unknown[];
    };
    if (!strings) return '';
    let out = strings[0] ?? '';
    for (let i = 1; i < strings.length; i++) {
        const arg = args?.[i - 1];
        out += (isIdentifier(arg) ? arg.value : '?') + strings[i];
    }
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * A fragment's genuinely BOUND parameters. Identifiers are excluded on
 * purpose: they are inlined text, and counting them here would let a denied-id
 * array that got interpolated rather than bound hide among them.
 */
function argsOf(fragment: unknown): readonly unknown[] {
    const args = (fragment as { args?: readonly unknown[] }).args;
    return (args ?? []).filter((a) => !isIdentifier(a));
}

/** Every `Identifier` a fragment inlined, in order. */
function identifiersOf(fragment: unknown): string[] {
    const args = (fragment as { args?: readonly unknown[] }).args;
    return (args ?? []).filter(isIdentifier).map((a) => a.value);
}

describe('buildLibraryAccessFilter — container-aware predicate', () => {
    const deniedScope = { kind: 'denyGroups' as const, ids: ['grp-1', 'grp-2'] };

    it('dispatches on mi.media_type via a CASE expression', () => {
        const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
        expect(rendered).toContain('CASE "mi".media_type');
        expect(rendered).toContain("WHEN 'tv' THEN");
        expect(rendered).toContain("WHEN 'season' THEN");
        expect(rendered).toContain("WHEN 'artist' THEN");
        expect(rendered).toContain("WHEN 'album' THEN");
        expect(rendered).toContain('ELSE');
        expect(rendered).toContain('END');
    });

    it('tv: walks series -> season -> episode -> media_file_items -> media_files', () => {
        const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
        const tvBranch = rendered.slice(
            rendered.indexOf("WHEN 'tv' THEN"),
            rendered.indexOf("WHEN 'season' THEN"),
        );
        expect(tvBranch).toContain('FROM media_items _season');
        expect(tvBranch).toContain('JOIN media_items _episode ON _episode.parent_id = _season.id');
        expect(tvBranch).toContain(
            'JOIN media_file_items _mfi ON _mfi.media_item_id = _episode.id',
        );
        expect(tvBranch).toContain('JOIN media_files _mf ON _mf.id = _mfi.file_id');
        expect(tvBranch).toContain('WHERE _season.parent_id = "mi".id');
        expect(tvBranch).toContain('_mf.library_group_id != ALL(');
        // Does not stop at the series' own (nonexistent) files.
        expect(tvBranch).not.toContain('media_item_id = "mi".id\n');
    });

    it('season: walks season -> episode -> media_file_items -> media_files', () => {
        const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
        const seasonBranch = rendered.slice(
            rendered.indexOf("WHEN 'season' THEN"),
            rendered.indexOf("WHEN 'artist' THEN"),
        );
        expect(seasonBranch).toContain('FROM media_items _episode');
        expect(seasonBranch).toContain(
            'JOIN media_file_items _mfi ON _mfi.media_item_id = _episode.id',
        );
        expect(seasonBranch).toContain('JOIN media_files _mf ON _mf.id = _mfi.file_id');
        expect(seasonBranch).toContain('WHERE _episode.parent_id = "mi".id');
    });

    it('artist: walks artist -> album -> track -> media_file_items -> media_files', () => {
        const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
        const artistBranch = rendered.slice(
            rendered.indexOf("WHEN 'artist' THEN"),
            rendered.indexOf("WHEN 'album' THEN"),
        );
        expect(artistBranch).toContain('FROM media_items _album');
        expect(artistBranch).toContain('JOIN media_items _track ON _track.parent_id = _album.id');
        expect(artistBranch).toContain(
            'JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id',
        );
        expect(artistBranch).toContain('WHERE _album.parent_id = "mi".id');
    });

    it('album: walks album -> track -> media_file_items -> media_files', () => {
        const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
        const albumBranch = rendered.slice(
            rendered.indexOf("WHEN 'album' THEN"),
            rendered.indexOf('ELSE'),
        );
        expect(albumBranch).toContain('FROM media_items _track');
        expect(albumBranch).toContain(
            'JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id',
        );
        expect(albumBranch).toContain('WHERE _track.parent_id = "mi".id');
    });

    describe('empty containers (fix round 1) — stay visible with zero descendant files', () => {
        it('tv: has a NOT EXISTS (any descendant episode file) clause ORed with the EXISTS one', () => {
            const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
            const tvBranch = rendered.slice(
                rendered.indexOf("WHEN 'tv' THEN"),
                rendered.indexOf("WHEN 'season' THEN"),
            );
            // The empty-container clause has NO library_group reference at all —
            // it only asks "does any descendant file exist".
            expect(tvBranch).toContain('NOT EXISTS (');
            const notExistsClause = tvBranch.slice(
                tvBranch.indexOf('NOT EXISTS ('),
                tvBranch.indexOf('OR EXISTS ('),
            );
            expect(notExistsClause).toContain('FROM media_items _season');
            expect(notExistsClause).toContain(
                'JOIN media_items _episode ON _episode.parent_id = _season.id',
            );
            expect(notExistsClause).toContain(
                'JOIN media_file_items _mfi ON _mfi.media_item_id = _episode.id',
            );
            expect(notExistsClause).toContain('WHERE _season.parent_id = "mi".id');
            expect(notExistsClause).not.toContain('library_group_id');
            expect(notExistsClause).not.toContain('media_files');
            // The two clauses are ORed together, not ANDed.
            expect(tvBranch.indexOf('NOT EXISTS (')).toBeLessThan(
                tvBranch.indexOf(') OR EXISTS ('),
            );
        });

        it('season: has the same NOT EXISTS / OR EXISTS two-clause shape', () => {
            const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
            const seasonBranch = rendered.slice(
                rendered.indexOf("WHEN 'season' THEN"),
                rendered.indexOf("WHEN 'artist' THEN"),
            );
            const notExistsClause = seasonBranch.slice(
                seasonBranch.indexOf('NOT EXISTS ('),
                seasonBranch.indexOf('OR EXISTS ('),
            );
            expect(notExistsClause).toContain('FROM media_items _episode');
            expect(notExistsClause).toContain(
                'JOIN media_file_items _mfi ON _mfi.media_item_id = _episode.id',
            );
            expect(notExistsClause).toContain('WHERE _episode.parent_id = "mi".id');
            expect(notExistsClause).not.toContain('library_group_id');
        });

        it('artist: has the same NOT EXISTS / OR EXISTS two-clause shape', () => {
            const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
            const artistBranch = rendered.slice(
                rendered.indexOf("WHEN 'artist' THEN"),
                rendered.indexOf("WHEN 'album' THEN"),
            );
            const notExistsClause = artistBranch.slice(
                artistBranch.indexOf('NOT EXISTS ('),
                artistBranch.indexOf('OR EXISTS ('),
            );
            expect(notExistsClause).toContain('FROM media_items _album');
            expect(notExistsClause).toContain(
                'JOIN media_items _track ON _track.parent_id = _album.id',
            );
            expect(notExistsClause).toContain(
                'JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id',
            );
            expect(notExistsClause).toContain('WHERE _album.parent_id = "mi".id');
            expect(notExistsClause).not.toContain('library_group_id');
        });

        it('album: has the same NOT EXISTS / OR EXISTS two-clause shape', () => {
            const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
            const albumBranch = rendered.slice(
                rendered.indexOf("WHEN 'album' THEN"),
                rendered.indexOf('ELSE'),
            );
            const notExistsClause = albumBranch.slice(
                albumBranch.indexOf('NOT EXISTS ('),
                albumBranch.indexOf('OR EXISTS ('),
            );
            expect(notExistsClause).toContain('FROM media_items _track');
            expect(notExistsClause).toContain(
                'JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id',
            );
            expect(notExistsClause).toContain('WHERE _track.parent_id = "mi".id');
            expect(notExistsClause).not.toContain('library_group_id');
        });
    });

    it('ELSE: keeps the legacy own-files predicate for non-container media types', () => {
        const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
        const elseBranch = rendered.slice(rendered.indexOf('ELSE'), rendered.lastIndexOf('END'));
        expect(elseBranch).toContain('NOT EXISTS');
        expect(elseBranch).toContain(
            'SELECT 1 FROM media_file_items WHERE media_item_id = "mi".id',
        );
        expect(elseBranch).toContain('FROM media_file_items mfi');
        expect(elseBranch).toContain('JOIN media_files mf ON mf.id = mfi.file_id');
        expect(elseBranch).toContain('WHERE mfi.media_item_id = "mi".id');
    });

    it('the denied-group array is parameterized, never interpolated, in every branch', () => {
        const rendered = render(buildLibraryAccessFilter(sql, deniedScope));
        expect(rendered).not.toContain('grp-1');
        expect(rendered).not.toContain('grp-2');
        // ELEVEN bound arrays, not ten: the fragment has TWO top-level
        // AND-clauses. The first is the media_type CASE — one array per branch
        // (tv, season, artist, album, else) = 5. The second is the own-column
        // check added by fix round 3 — one array for its `library_group_id !=
        // ALL(...)` arm plus one per branch of its guard CASE
        // (tv, season, artist, album, else) = 6.
        //
        // This expectation said five until 2026-09-15 and had been RED since
        // fix round 3 landed; it was never updated when the second clause was
        // added. It said ten until 2026-09-18 (security fix-plan-4, Shape B):
        // the guard CASE's `ELSE FALSE` arm — previously a bare boolean with
        // no bound array — became a positive EXISTS over the row's own files,
        // which binds one more `!= ALL(...)` array. Verified against pristine
        // HEAD before changing it each time.
        const args = argsOf(buildLibraryAccessFilter(sql, deniedScope));
        expect(args).toEqual(Array.from({ length: 11 }, () => ['grp-1', 'grp-2']));
    });

    it('denyAll still short-circuits to AND false before any CASE is built', () => {
        expect(render(buildLibraryAccessFilter(sql, { kind: 'denyAll' }))).toBe('AND false');
    });

    it('an unrestricted scope still emits nothing', () => {
        expect(render(buildLibraryAccessFilter(sql, { kind: 'all' }))).toBe('');
        expect(render(buildLibraryAccessFilter(sql, null))).toBe('');
        expect(render(buildLibraryAccessFilter(sql, undefined))).toBe('');
        expect(render(buildLibraryAccessFilter(sql, []))).toBe('');
    });

    // -------------------------------------------------------------------------
    // alias parameter (2026-09-15)
    //
    // The builder used to hardcode `mi`, which forced every query with a
    // differently-named media_items alias to hand-inline the predicate — and
    // five of those copies were the OLD, pre-container predicate correlated to
    // a CONTAINER row, whose `NOT EXISTS (own files)` arm is unconditionally
    // TRUE in production (no tv/season/artist/album row owns media_file_items).
    // These pin the alias plumbing so the copies cannot come back.
    // -------------------------------------------------------------------------

    it('emits a caller-supplied alias in every correlated reference', () => {
        const rendered = render(buildLibraryAccessFilter(sql, deniedScope, 'ep'));
        expect(rendered).toContain('CASE "ep".media_type');
        expect(rendered).toContain('WHERE _season.parent_id = "ep".id');
        expect(rendered).toContain('WHERE mfi.media_item_id = "ep".id');
        expect(rendered).toContain('"ep".library_group_id IS NULL');
        // No trace of the old hardcoded alias anywhere in the fragment.
        expect(rendered).not.toContain('"mi"');
    });

    it('passes the alias as an Identifier, so it is quoted rather than interpolated', () => {
        const fragment = buildLibraryAccessFilter(sql, deniedScope, 'series_mi');
        // Every alias reference is an Identifier; none is a bound value, and
        // none is raw string concatenation (which would be an injection seam).
        expect(new Set(identifiersOf(fragment))).toEqual(new Set(['"series_mi"']));
        expect(argsOf(fragment)).toEqual(Array.from({ length: 11 }, () => ['grp-1', 'grp-2']));
    });

    it('rejects an unsafe alias', () => {
        expect(() =>
            buildLibraryAccessFilter(sql, deniedScope, 'mi; DROP TABLE media_items'),
        ).toThrow(/invalid alias/);
        expect(() => buildLibraryAccessFilter(sql, deniedScope, '1bad')).toThrow(/invalid alias/);
    });

    it('validates the alias only when a predicate is actually emitted', () => {
        // An unrestricted scope returns before the alias is used, so a bad
        // alias cannot turn a zero-overhead no-op into a throw.
        expect(render(buildLibraryAccessFilter(sql, { kind: 'all' }, '1bad'))).toBe('');
        expect(render(buildLibraryAccessFilter(sql, { kind: 'denyAll' }, '1bad'))).toBe(
            'AND false',
        );
    });

    it('legacy array form still routes through the container-aware CASE', () => {
        const rendered = render(buildLibraryAccessFilter(sql, ['g']));
        expect(rendered).toContain('CASE "mi".media_type');
        expect(rendered).toContain("WHEN 'tv' THEN");
    });
});
