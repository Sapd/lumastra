// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    computeReconcileDeltas,
    dropStillPresentRemoves,
    nextReconcilePathIndex,
    isExtrasPath,
} from '../file-reconcile.js';
import { walkDirectoryWithResult } from '$lib/server/utils/walk-directory.js';

const ROOT = '/data/music';
// minRemoveGuard 2 keeps the small-number fraction cases meaningful; the floor
// itself is exercised in its own test with an explicit value.
const OPTS = { maxDeltas: 500, maxRemoveFraction: 0.5, minRemoveGuard: 2 };
const ok = { hadErrors: false };

describe('computeReconcileDeltas', () => {
    it('a library root under an extras-named folder is reconciled (only segments below the root count)', () => {
        const root = '/media/Shorts';
        const r = computeReconcileDeltas(
            root,
            [`${root}/A Short (2019)/A Short (2019).mkv`],
            [],
            ok,
            OPTS,
        );
        expect(r.upsert).toEqual(['A Short (2019)/A Short (2019).mkv']);
    });

    it('detects new files as upserts and missing files as removes (relative paths)', () => {
        const disk = [`${ROOT}/Metalune/x.flac`, `${ROOT}/ABBA/y.flac`];
        const db = [`${ROOT}/ABBA/y.flac`, `${ROOT}/Old/gone.flac`];

        const r = computeReconcileDeltas(ROOT, disk, db, ok, OPTS);

        expect(r.upsert).toEqual(['Metalune/x.flac']);
        expect(r.remove).toEqual(['Old/gone.flac']);
        expect(r.removesSuppressed).toBeUndefined();
        expect(r.capped).toBe(false);
    });

    it('treats NFC/NFD-equivalent paths as the same file (no churn)', () => {
        // Build from an explicit combining acute (U+0301) so the two forms are
        // unambiguously different byte sequences regardless of editor encoding.
        const base = `${ROOT}/Bjork-é/track.flac`;
        const nfd = base.normalize('NFD'); // e + combining acute
        const nfc = base.normalize('NFC'); // precomposed
        expect(nfd).not.toBe(nfc); // sanity: the byte forms genuinely differ
        // disk has NFD form, DB stored the NFC form — must not look like add+remove.
        const r = computeReconcileDeltas(ROOT, [nfd], [nfc], ok, OPTS);
        expect(r.upsert).toEqual([]);
        expect(r.remove).toEqual([]);
    });

    it('suppresses removes when the walk reported errors (incomplete listing)', () => {
        const disk = [`${ROOT}/A/new.flac`];
        const db = [`${ROOT}/B/old.flac`, `${ROOT}/C/older.flac`];
        const r = computeReconcileDeltas(ROOT, disk, db, { hadErrors: true }, OPTS);
        // upserts still flow, but removes are withheld
        expect(r.upsert).toEqual(['A/new.flac']);
        expect(r.remove).toEqual([]);
        expect(r.removesSuppressed).toBe('walk-errors');
    });

    it('suppresses removes when the walk is empty but the DB has files (unmounted root)', () => {
        const db = [`${ROOT}/A/a.flac`, `${ROOT}/B/b.flac`];
        const r = computeReconcileDeltas(ROOT, [], db, ok, OPTS);
        expect(r.remove).toEqual([]);
        expect(r.removesSuppressed).toBe('empty-listing');
    });

    it('suppresses removes that exceed the safety fraction', () => {
        // 4 in DB, disk has only 1 of them → would remove 3 ( > 50% ) → suppress
        const db = [`${ROOT}/a.flac`, `${ROOT}/b.flac`, `${ROOT}/c.flac`, `${ROOT}/d.flac`];
        const disk = [`${ROOT}/a.flac`];
        const r = computeReconcileDeltas(ROOT, disk, db, ok, OPTS);
        expect(r.remove).toEqual([]);
        expect(r.removesSuppressed).toBe('exceeds-fraction');
    });

    it('never trips the fraction guard for small libraries (absolute floor)', () => {
        // 10 in DB, disk has 4 → removes 6 ( > 50% ) but below the floor (25)
        // → allowed. Normal small deletions must always propagate.
        const db = Array.from({ length: 10 }, (_, i) => `${ROOT}/f${i}.flac`);
        const disk = db.slice(0, 4);
        const r = computeReconcileDeltas(ROOT, disk, db, ok, {
            maxDeltas: 500,
            maxRemoveFraction: 0.5,
            minRemoveGuard: 25,
        });
        expect(r.remove).toHaveLength(6);
        expect(r.removesSuppressed).toBeUndefined();
    });

    it('suppresses a true mass removal (above floor AND above fraction)', () => {
        // 60 in DB, disk has 10 → removes 50 ( > 50% AND >= floor 25 ) → suppressed
        const db = Array.from({ length: 60 }, (_, i) => `${ROOT}/f${i}.flac`);
        const disk = db.slice(0, 10);
        const r = computeReconcileDeltas(ROOT, disk, db, ok, {
            maxDeltas: 500,
            maxRemoveFraction: 0.5,
            minRemoveGuard: 25,
        });
        expect(r.remove).toEqual([]);
        expect(r.removesSuppressed).toBe('exceeds-fraction');
    });

    it('allows removes within the safety fraction', () => {
        // 4 in DB, disk has 3 → removes 1 ( <= 50% ) → allowed
        const db = [`${ROOT}/a.flac`, `${ROOT}/b.flac`, `${ROOT}/c.flac`, `${ROOT}/d.flac`];
        const disk = [`${ROOT}/a.flac`, `${ROOT}/b.flac`, `${ROOT}/c.flac`];
        const r = computeReconcileDeltas(ROOT, disk, db, ok, OPTS);
        expect(r.remove).toEqual(['d.flac']);
        expect(r.removesSuppressed).toBeUndefined();
    });

    it('caps the delta set and flags capped', () => {
        const disk = Array.from({ length: 7 }, (_, i) => `${ROOT}/n${i}.flac`);
        const r = computeReconcileDeltas(ROOT, disk, [], ok, { ...OPTS, maxDeltas: 3 });
        expect(r.upsert).toHaveLength(3);
        expect(r.capped).toBe(true);
    });

    it('returns nothing to do when disk and DB already match', () => {
        const files = [`${ROOT}/a.flac`, `${ROOT}/b.flac`];
        const r = computeReconcileDeltas(ROOT, files, files, ok, OPTS);
        expect(r.upsert).toEqual([]);
        expect(r.remove).toEqual([]);
        expect(r.capped).toBe(false);
    });

    // ---------------------------------------------------------------------------
    // Extras exclusion (must never claim a trailer/extra as a primary upsert)
    // ---------------------------------------------------------------------------

    const MOVIE_ROOT = '/data/movies';

    it('withholds a new file inside a named extras subfolder from upsert', () => {
        const disk = [
            `${MOVIE_ROOT}/Cinderella (1950) [imdbid-tt0042332]/Cinderella (1950).mkv`,
            `${MOVIE_ROOT}/Cinderella (1950) [imdbid-tt0042332]/trailers/Cinderella-trailer.mp4`,
        ];
        const db = [`${MOVIE_ROOT}/Cinderella (1950) [imdbid-tt0042332]/Cinderella (1950).mkv`];
        const r = computeReconcileDeltas(MOVIE_ROOT, disk, db, ok, OPTS);
        expect(r.upsert).toEqual([]);
        expect(r.excludedExtras).toBe(1);
        expect(r.capped).toBe(false);
    });

    it('withholds a new filename-suffix extra from upsert', () => {
        const disk = [`${MOVIE_ROOT}/Best Movie (2019)/Best Movie (2019)-behindthescenes.mkv`];
        const r = computeReconcileDeltas(MOVIE_ROOT, disk, [], ok, OPTS);
        expect(r.upsert).toEqual([]);
        expect(r.excludedExtras).toBe(1);
    });

    it('withholds a standalone trailer.mp4 from upsert', () => {
        const disk = [`${MOVIE_ROOT}/Some Series (2018)/trailer.mp4`];
        const r = computeReconcileDeltas(MOVIE_ROOT, disk, [], ok, OPTS);
        expect(r.upsert).toEqual([]);
        expect(r.excludedExtras).toBe(1);
    });

    it('still upserts a genuinely new primary file alongside a withheld extra', () => {
        const disk = [
            `${MOVIE_ROOT}/A/A.mkv`,
            `${MOVIE_ROOT}/A/trailers/A-trailer.mp4`,
            `${MOVIE_ROOT}/B/B.mkv`,
        ];
        const r = computeReconcileDeltas(MOVIE_ROOT, disk, [], ok, OPTS);
        expect(r.upsert.sort()).toEqual(['A/A.mkv', 'B/B.mkv']);
        expect(r.excludedExtras).toBe(1);
    });

    // ---------------------------------------------------------------------------
    // Symmetric exclusion (fix round 3): an extras path known to the DB but
    // absent from reconcile's own extras-excluded disk listing must NEVER be
    // treated as "removed from disk" — reconcile does not manage extras at
    // all, on either side of the diff. Regression: fix round 2 excluded
    // extras only from the upsert side, so a legitimately-ingested extra
    // (e.g. the Stargate Origins series trailer) looked "removed" on every
    // single reconcile cycle over its library path and was deleted.
    // ---------------------------------------------------------------------------

    it('never removes a known extras-path DB row, even though it is absent from the (extras-excluded) disk listing', () => {
        // `B/B.mkv` present on both sides keeps the disk listing non-empty so
        // the unrelated "unmounted root" guard doesn't also suppress removes.
        const db = [`${MOVIE_ROOT}/A/trailers/A-trailer.mp4`, `${MOVIE_ROOT}/B/B.mkv`];
        const disk = [`${MOVIE_ROOT}/B/B.mkv`];
        const r = computeReconcileDeltas(MOVIE_ROOT, disk, db, ok, OPTS);
        expect(r.remove).toEqual([]);
        expect(r.excludedExtrasDb).toBe(1);
        expect(r.excludedExtras).toBe(0);
    });

    it('still removes a genuinely deleted non-extras file alongside a withheld extras DB row', () => {
        const db = [
            `${MOVIE_ROOT}/A/trailers/A-trailer.mp4`, // extra — withheld from remove
            `${MOVIE_ROOT}/B/B.mkv`, // present on disk — untouched
            `${MOVIE_ROOT}/C/C.mkv`, // genuinely deleted — must still be removed
        ];
        const disk = [`${MOVIE_ROOT}/B/B.mkv`];
        const r = computeReconcileDeltas(MOVIE_ROOT, disk, db, ok, OPTS);
        expect(r.remove).toEqual(['C/C.mkv']);
        expect(r.excludedExtrasDb).toBe(1);
    });

    it('an extras-only DB with an empty disk listing does not trip the "unmounted root" guard as a real removal', () => {
        // Disk is empty and the only known DB path is an extra — since that
        // extra is withheld from `dbAbsManaged` before the empty-listing
        // guard runs, there is nothing left to suppress: no removes, no
        // removesSuppressed.
        const db = [`${MOVIE_ROOT}/A/trailers/A-trailer.mp4`];
        const r = computeReconcileDeltas(MOVIE_ROOT, [], db, ok, OPTS);
        expect(r.remove).toEqual([]);
        expect(r.removesSuppressed).toBeUndefined();
        expect(r.excludedExtrasDb).toBe(1);
    });
});

describe('isExtrasPath', () => {
    it('recognizes a named extras subfolder anywhere in the path', () => {
        expect(isExtrasPath('/data/movies/Film (2020)/trailers/Film-trailer.mkv')).toBe(true);
        expect(isExtrasPath('/data/movies/Film (2020)/behind the scenes/x.mkv')).toBe(true);
        expect(isExtrasPath('/data/movies/Film (2020)/Extras/x.mkv')).toBe(true); // case-insensitive
    });

    it('recognizes a Jellyfin filename-suffix extra', () => {
        expect(isExtrasPath('/data/movies/Film (2020)/Film (2020)-behindthescenes.mkv')).toBe(true);
        expect(isExtrasPath('/data/movies/Film (2020)/trailer.mp4')).toBe(true);
        expect(isExtrasPath('/data/movies/Film (2020)/Film-trailer.mkv')).toBe(true);
    });

    it('does not misclassify an ordinary primary file', () => {
        expect(isExtrasPath('/data/movies/Film (2020)/Film (2020).mkv')).toBe(false);
        expect(isExtrasPath('/data/movies/Crime Scene (2020)/Crime Scene (2020).mkv')).toBe(false);
    });
});

describe('nextReconcilePathIndex (round-robin cursor)', () => {
    const ids = ['a', 'b', 'c'];

    it('starts at 0 when there is no cursor', () => {
        expect(nextReconcilePathIndex(ids, null)).toBe(0);
    });

    it('advances to the path after the cursor', () => {
        expect(nextReconcilePathIndex(ids, 'a')).toBe(1);
        expect(nextReconcilePathIndex(ids, 'b')).toBe(2);
    });

    it('wraps around after the last path', () => {
        expect(nextReconcilePathIndex(ids, 'c')).toBe(0);
    });

    it('restarts at 0 when the cursor path is gone (removed/disabled)', () => {
        expect(nextReconcilePathIndex(ids, 'zzz')).toBe(0);
    });

    it('returns -1 for an empty path set', () => {
        expect(nextReconcilePathIndex([], 'a')).toBe(-1);
        expect(nextReconcilePathIndex([], null)).toBe(-1);
    });

    it('covers every path exactly once per full cycle', () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < ids.length; i++) {
            const idx = nextReconcilePathIndex(ids, cursor);
            seen.push(ids[idx]);
            cursor = ids[idx];
        }
        expect(seen.sort()).toEqual(['a', 'b', 'c']);
    });
});

describe('theme assets are never proposed as upserts', () => {
    const TV = '/data/tv';

    it('withholds theme.mp3 — the file that made reconcile loop forever', () => {
        // Prod: 76 theme.mp3 (one per series folder) were on disk and absent from
        // media_files, so reconcile handed them to file-delta-ingest every 5
        // minutes. Ingest reported them "upserted" while persisting no row, so the
        // next cycle found the same 76 again — 144 runs in 12h, indefinitely.
        const disk = [
            `${TV}/DuckTales (1987)/theme.mp3`,
            `${TV}/Darkwing Duck (1991)/theme.mp3`,
            `${TV}/DuckTales (1987)/Season 01/S01E01.mkv`,
        ];
        const r = computeReconcileDeltas(TV, disk, [], ok, OPTS);

        // The real episode still gets picked up; only the themes are withheld.
        expect(r.upsert).toEqual(['DuckTales (1987)/Season 01/S01E01.mkv']);
        expect(r.excludedThemes).toBe(2);
    });

    it('withholds a theme-music/ folder', () => {
        const disk = [`${TV}/Show/theme-music/opening.mp3`];
        const r = computeReconcileDeltas(TV, disk, [], ok, OPTS);
        expect(r.upsert).toEqual([]);
        expect(r.excludedThemes).toBe(1);
    });

    it('excludes theme paths from REMOVE consideration too (symmetry)', () => {
        // Same trap as excludedExtrasDb: if a theme row ever exists in the DB but
        // the disk listing filters themes out, an asymmetric exclusion would read
        // it as "deleted from disk" on every cycle and delete it.
        const r = computeReconcileDeltas(TV, [], [`${TV}/Show/theme.mp3`], ok, OPTS);
        expect(r.remove).toEqual([]);
        expect(r.excludedThemesDb).toBe(1);
    });

    it('does not withhold ordinary files that merely contain the word theme', () => {
        // Narrowness check: only `theme.<ext>` exactly, not any title with "theme".
        const disk = [`${TV}/Show/Season 01/Main Theme.mkv`, `${TV}/Show/crocketts_theme.mp3`];
        const r = computeReconcileDeltas(TV, disk, [], ok, OPTS);
        expect(r.upsert).toHaveLength(2);
        expect(r.excludedThemes).toBe(0);
    });
});

describe('computeReconcileDeltas: files ingest skipped on purpose', () => {
    const ROOT2 = '/data/kids';
    const ok2 = { hadErrors: false };

    it('withholds recently skipped paths from upsert and counts them', () => {
        const dup = `${ROOT2}/Harborfolk/Season 11/spongebob.s11e15e14.mp4`;
        const fresh = `${ROOT2}/Harborfolk/Season 11/spongebob.s11e16.mp4`;

        const r = computeReconcileDeltas(ROOT2, [dup, fresh], [], ok2, {
            ...OPTS,
            recentlySkipped: new Set(['Harborfolk/Season 11/spongebob.s11e15e14.mp4']),
        });

        expect(r.upsert).toEqual(['Harborfolk/Season 11/spongebob.s11e16.mp4']);
        expect(r.excludedSkipped).toBe(1);
    });

    it('without skips, behaves as before', () => {
        const dup = `${ROOT2}/Harborfolk/Season 11/spongebob.s11e15e14.mp4`;
        const r = computeReconcileDeltas(ROOT2, [dup], [], ok2, OPTS);
        expect(r.upsert).toEqual(['Harborfolk/Season 11/spongebob.s11e15e14.mp4']);
        expect(r.excludedSkipped).toBe(0);
    });
});

describe('a file that is still on disk is never removed (newly ignored files)', () => {
    // An ignore rule (`.lumastraignore`, Jellyfin `.ignore`) hides a file from
    // the walk, so reconcile saw a known file "missing" and file-delta-ingest
    // deleted its row: the item was dismissed and, after the 24 h reclaim
    // window, its watch history and ratings were stranded. The full scan's
    // stale cleanup checks presence and keeps such rows; reconcile must too.
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'reconcile-ignored-'));
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('keeps a known file that a new ignore rule hides from the walk, removes a deleted one', async () => {
        mkdirSync(join(root, 'Kept (2001)'));
        writeFileSync(join(root, 'Kept (2001)', 'Kept (2001).mkv'), 'x');
        mkdirSync(join(root, 'Ignored (2002)'));
        const ignored = join(root, 'Ignored (2002)', 'Ignored (2002).mkv');
        writeFileSync(ignored, 'x');
        // Jellyfin/Emby convention: an empty `.ignore` skips the folder.
        writeFileSync(join(root, 'Ignored (2002)', '.ignore'), '');
        const deleted = join(root, 'Deleted (2003)', 'Deleted (2003).mkv');

        const walk = await walkDirectoryWithResult(root);
        expect(walk.files).not.toContain(ignored);
        const known = [join(root, 'Kept (2001)', 'Kept (2001).mkv'), ignored, deleted];
        const delta = computeReconcileDeltas(root, walk.files, known, walk, {
            ...OPTS,
            minRemoveGuard: 25,
        });
        expect(delta.remove.sort()).toEqual(
            ['Deleted (2003)/Deleted (2003).mkv', 'Ignored (2002)/Ignored (2002).mkv'].sort(),
        );

        const { remove, stillPresent } = await dropStillPresentRemoves(root, delta.removeAll);
        expect(remove).toEqual(['Deleted (2003)/Deleted (2003).mkv']);
        expect(stillPresent).toBe(1);
    });

    it('ignored files ahead of a deleted one cannot fill the cap and starve it', async () => {
        const present = ['a.mkv', 'b.mkv', 'c.mkv'];
        for (const f of present) writeFileSync(join(root, f), 'x');
        const { remove, stillPresent } = await dropStillPresentRemoves(
            root,
            [...present, 'deleted.mkv'],
            { limit: 2, concurrency: 2 },
        );
        expect(remove).toEqual(['deleted.mkv']);
        expect(stillPresent).toBe(3);
    });

    it('keeps a remove whose presence cannot be decided (offline parent) out too', async () => {
        const offline = 'gone-dir/deeper/file.mkv';
        // The root exists, so a missing file below it is a real deletion…
        const { remove } = await dropStillPresentRemoves(root, [offline]);
        expect(remove).toEqual([offline]);
        // …but with the root itself gone the mount looks offline: keep it.
        const { remove: none } = await dropStillPresentRemoves(join(root, 'no-such-root'), [
            offline,
        ]);
        expect(none).toEqual([]);
    });
});
