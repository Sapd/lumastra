// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Differential access-boundary coverage for `listArtists` (GET /j/Artists).
 *
 * The point of these tests is to fail if the boundary argument arrives but is
 * never applied — the failure mode the old permissive shape made invisible.
 * Every assertion compares a restricted run against an unrestricted run over the
 * SAME fixture, so "returns some rows" is never enough to pass.
 *
 * Both `TotalRecordCount` and `rows.length` are asserted everywhere: the count
 * and rows queries are separate statements, and a boundary applied to only one
 * of them is exactly the leak reproduced for the sibling Episodes route.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { listArtists } from './artists-query.js';

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

interface Fixture {
    /** Unique token shared by every fixture artist title, used to scope queries. */
    tag: string;
    openGroupId: string;
    deniedGroupId: string;
    openArtistId: string;
    deniedArtistId: string;
    adultArtistId: string;
}

describe.runIf(RUN)('listArtists — access boundary', () => {
    let sql: postgres.Sql;
    const mediaIds: string[] = [];
    const groupIds: string[] = [];
    const fileIds: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1 FROM media_items LIMIT 0`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        if (mediaIds.length > 0) {
            await sql`DELETE FROM media_items WHERE id = ANY(${mediaIds}::uuid[])`;
            mediaIds.length = 0;
        }
        if (fileIds.length > 0) {
            await sql`DELETE FROM media_files WHERE id = ANY(${fileIds}::uuid[])`;
            fileIds.length = 0;
        }
        if (groupIds.length > 0) {
            await sql`DELETE FROM library_groups WHERE id = ANY(${groupIds}::uuid[])`;
            groupIds.length = 0;
        }
    });

    async function insertGroup(name: string): Promise<string> {
        const id = randomUUID();
        groupIds.push(id);
        await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
        return id;
    }

    /**
     * Insert artist -> album -> track -> media_file_items -> media_files, with the
     * file pinned to `libraryGroupId`. This is the three-level descendant walk the
     * library predicate traverses; anything shallower would not exercise it.
     */
    async function insertArtistWithTrack(
        title: string,
        libraryGroupId: string | null,
        ageRating: number | null,
    ): Promise<string> {
        const artistId = randomUUID();
        const albumId = randomUUID();
        const trackId = randomUUID();
        const fileId = randomUUID();
        mediaIds.push(artistId, albumId, trackId);
        fileIds.push(fileId);

        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, age_rating)
            VALUES (${artistId}::uuid, ${title}, 'artist', NULL, ${ageRating})
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id)
            VALUES (${albumId}::uuid, ${`${title} Album`}, 'album', ${artistId}::uuid)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id)
            VALUES (${trackId}::uuid, ${`${title} Track`}, 'track', ${albumId}::uuid)
        `;
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id)
            VALUES (${fileId}::uuid, ${`/test/${trackId}.mp3`}, ${libraryGroupId}::uuid)
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
            VALUES (${fileId}::uuid, ${trackId}::uuid, true, 0)
        `;
        return artistId;
    }

    async function seed(): Promise<Fixture> {
        const tag = `AccBoundary${randomUUID().slice(0, 8)}`;
        const openGroupId = await insertGroup(`${tag} Open`);
        const deniedGroupId = await insertGroup(`${tag} Denied`);

        return {
            tag,
            openGroupId,
            deniedGroupId,
            openArtistId: await insertArtistWithTrack(`${tag} Open Artist`, openGroupId, null),
            deniedArtistId: await insertArtistWithTrack(
                `${tag} Denied Artist`,
                deniedGroupId,
                null,
            ),
            adultArtistId: await insertArtistWithTrack(`${tag} Adult Artist`, openGroupId, 18),
        };
    }

    /**
     * Insert an artist row with NO albums at all — a request stub, a
     * watchlist/playlist placeholder, or an empty row created ahead of its
     * children. Exercises the container empty-row fix: a container with zero
     * descendant files must stay visible, exactly like a file-less leaf item.
     */
    async function insertBareArtist(title: string, ageRating: number | null): Promise<string> {
        const artistId = randomUUID();
        mediaIds.push(artistId);
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, age_rating)
            VALUES (${artistId}::uuid, ${title}, 'artist', NULL, ${ageRating})
        `;
        return artistId;
    }

    /**
     * Insert an artist row with NO albums AND an explicit own-row
     * `library_group_id` (as `findOrCreateMusicArtist` sets at creation) —
     * exercises the fix-round-2 own-column check, distinct from the
     * descendant-file walk `insertBareArtist`/`insertArtistWithTrack` exercise.
     */
    async function insertBareArtistInGroup(title: string, libraryGroupId: string): Promise<string> {
        const artistId = randomUUID();
        mediaIds.push(artistId);
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, library_group_id)
            VALUES (${artistId}::uuid, ${title}, 'artist', NULL, ${libraryGroupId}::uuid)
        `;
        return artistId;
    }

    /** Run the query scoped to one fixture's artists via SearchTerm. */
    async function list(
        tag: string,
        access: Parameters<typeof listArtists>[2],
    ): Promise<{ ids: string[]; totalCount: number }> {
        const result = await listArtists(
            sql,
            { limit: 500, startIndex: 0, searchTerm: tag },
            access,
        );
        return { ids: result.rows.map((r) => r.id as string), totalCount: result.totalCount };
    }

    it('unrestricted sees every fixture artist; count agrees with rows', async () => {
        const f = await seed();
        const all = await list(f.tag, unrestrictedAccess());

        expect(all.ids).toHaveLength(3);
        expect(all.ids).toEqual(
            expect.arrayContaining([f.openArtistId, f.deniedArtistId, f.adultArtistId]),
        );
        expect(all.totalCount).toBe(all.ids.length);
    });

    it('library restriction yields a STRICT subset, dropping only the denied artist', async () => {
        const f = await seed();
        const all = await list(f.tag, unrestrictedAccess());
        const restricted = await list(
            f.tag,
            restrictedAccess({
                deniedGroupIds: [f.deniedGroupId],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );

        // Strict subset: every restricted id is in the unrestricted set, and the
        // restricted set is genuinely smaller. A boundary that arrived but was
        // never applied fails the second assertion.
        for (const id of restricted.ids) expect(all.ids).toContain(id);
        expect(restricted.ids.length).toBeLessThan(all.ids.length);

        expect(restricted.ids).not.toContain(f.deniedArtistId);
        expect(restricted.ids).toEqual(expect.arrayContaining([f.openArtistId, f.adultArtistId]));
        // Count must be filtered too, or TotalRecordCount leaks the hidden artist.
        expect(restricted.totalCount).toBe(restricted.ids.length);
    });

    it('age restriction yields a STRICT subset, dropping only the adult artist', async () => {
        const f = await seed();
        const all = await list(f.tag, unrestrictedAccess());
        const restricted = await list(
            f.tag,
            restrictedAccess({
                deniedGroupIds: [],
                maxAgeRating: 12,
                allowUnrated: true,
            }),
        );

        for (const id of restricted.ids) expect(all.ids).toContain(id);
        expect(restricted.ids.length).toBeLessThan(all.ids.length);
        expect(restricted.ids).not.toContain(f.adultArtistId);
        expect(restricted.totalCount).toBe(restricted.ids.length);
    });

    it('both axes restricted compose — subset of each single-axis result', async () => {
        const f = await seed();
        const both = await list(
            f.tag,
            restrictedAccess({
                deniedGroupIds: [f.deniedGroupId],
                maxAgeRating: 12,
                allowUnrated: true,
            }),
        );

        expect(both.ids).toEqual([f.openArtistId]);
        expect(both.totalCount).toBe(1);
    });

    it('denyAll returns EMPTY on both rows and count', async () => {
        const f = await seed();
        const denied = await list(f.tag, denyAllAccess());

        expect(denied.ids).toEqual([]);
        expect(denied.totalCount).toBe(0);
    });

    it('denyAll on the library axis alone still returns EMPTY', async () => {
        const f = await seed();
        const denied = await list(f.tag, {
            library: { kind: 'denyAll' },
            age: { kind: 'any' },
        });

        expect(denied.ids).toEqual([]);
        expect(denied.totalCount).toBe(0);
    });

    it('an empty denied-group list is equivalent to unrestricted (no silent tightening)', async () => {
        const f = await seed();
        const all = await list(f.tag, unrestrictedAccess());
        const emptyDeny = await list(
            f.tag,
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: null, allowUnrated: true }),
        );

        expect([...emptyDeny.ids].sort()).toEqual([...all.ids].sort());
        expect(emptyDeny.totalCount).toBe(all.totalCount);
    });

    it('allowUnrated=false hides every unrated artist — existing behaviour, pinned', async () => {
        // Artist rows are containers and normally carry age_rating IS NULL, so on
        // this route the age axis collapses to the allowUnrated flag: an
        // age-restricted user on an instance with UNRATED_CONTENT_VISIBLE=false
        // sees ZERO artists. Surprising, but pre-existing — pinned so the reshape
        // cannot quietly change it.
        const f = await seed();
        const strict = await list(
            f.tag,
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false }),
        );

        expect(strict.ids).toEqual([]);
        expect(strict.totalCount).toBe(0);
    });

    it('an artist with ZERO albums is unavailable even when library access would admit it', async () => {
        const f = await seed();
        const bareArtistId = await insertBareArtist(`${f.tag} Bare Artist`, null);

        const restricted = await list(
            f.tag,
            restrictedAccess({
                deniedGroupIds: [f.deniedGroupId],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );

        expect(restricted.ids).not.toContain(bareArtistId);
        expect(restricted.ids).toContain(f.openArtistId);
        // Count must agree with rows, or TotalRecordCount hides the stub while
        // the rows array shows it (or vice versa).
        expect(restricted.totalCount).toBe(restricted.ids.length);
    });

    it('an artist with ZERO albums but its OWN library_group_id naming the denied group is hidden (fix round 2 — own-column check)', async () => {
        const f = await seed();
        // Distinct from the ZERO-albums test above: that artist has no
        // descendant files AND no own-row library_group_id (NULL). This one
        // has no descendant files EITHER, but its own row explicitly declares
        // membership in the denied group — the descendant walk alone would
        // wrongly call it visible (NOT EXISTS branch), which is exactly the
        // gap the own-column check closes.
        const namedDeniedArtistId = await insertBareArtistInGroup(
            `${f.tag} Named Denied Artist`,
            f.deniedGroupId,
        );

        const restricted = await list(
            f.tag,
            restrictedAccess({
                deniedGroupIds: [f.deniedGroupId],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );

        expect(restricted.ids).not.toContain(namedDeniedArtistId);
        expect(restricted.totalCount).toBe(restricted.ids.length);

        // Availability applies even without a library restriction. A playable
        // artist remains visible as the positive control.
        const unrestricted = await list(f.tag, unrestrictedAccess());
        expect(unrestricted.ids).not.toContain(namedDeniedArtistId);
        expect(unrestricted.ids).toContain(f.openArtistId);
    });

    // Fix round 3 (review response, 2026-09-15): the own-column check's first
    // cut hid an artist naming a denied group "regardless of file state",
    // which also hid one whose descendant TRACK is fully accessible —
    // reachable because media_items.library_group_id is STICKY (set once at
    // first scan; findOrCreateMusicArtist never rewrites an existing row's
    // group), so an artist first scanned into one group keeps that own-row
    // group even after later tracks land in a different, allowed group.
    it('an artist naming a denied group with a non-denied descendant track stays visible (fix round 3 — sticky-column desync)', async () => {
        const f = await seed();
        const allowedGroupId = await insertGroup(`${f.tag} Sticky Allowed`);
        const artistId = randomUUID();
        const albumId = randomUUID();
        const trackId = randomUUID();
        const fileId = randomUUID();
        mediaIds.push(artistId, albumId, trackId);
        fileIds.push(fileId);

        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, library_group_id)
            VALUES (${artistId}::uuid, ${`${f.tag} Sticky Artist`}, 'artist', NULL, ${f.deniedGroupId}::uuid)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id)
            VALUES (${albumId}::uuid, ${`${f.tag} Sticky Album`}, 'album', ${artistId}::uuid)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id)
            VALUES (${trackId}::uuid, ${`${f.tag} Sticky Track`}, 'track', ${albumId}::uuid)
        `;
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id)
            VALUES (${fileId}::uuid, ${`/test/${trackId}.mp3`}, ${allowedGroupId}::uuid)
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
            VALUES (${fileId}::uuid, ${trackId}::uuid, true, 0)
        `;

        const restricted = await list(
            f.tag,
            restrictedAccess({
                deniedGroupIds: [f.deniedGroupId],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );

        expect(restricted.ids).toContain(artistId);
        expect(restricted.totalCount).toBe(restricted.ids.length);
    });

    it('an artist with an album that has ZERO tracks is unavailable', async () => {
        const f = await seed();
        const artistId = randomUUID();
        const albumId = randomUUID();
        mediaIds.push(artistId, albumId);
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, age_rating)
            VALUES (${artistId}::uuid, ${`${f.tag} Empty Album Artist`}, 'artist', NULL, NULL)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id)
            VALUES (${albumId}::uuid, ${`${f.tag} Empty Album`}, 'album', ${artistId}::uuid)
        `;

        const restricted = await list(
            f.tag,
            restrictedAccess({
                deniedGroupIds: [f.deniedGroupId],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );

        expect(restricted.ids).not.toContain(artistId);
        expect(restricted.ids).toContain(f.openArtistId);
        expect(restricted.totalCount).toBe(restricted.ids.length);
    });

    it('ParentId narrowing composes with the boundary rather than bypassing it', async () => {
        const f = await seed();
        const result = await listArtists(
            sql,
            { limit: 500, startIndex: 0, searchTerm: f.tag, parentId: f.openGroupId },
            restrictedAccess({
                deniedGroupIds: [f.deniedGroupId],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );
        const ids = result.rows.map((r) => r.id as string);

        expect(ids).toEqual(expect.arrayContaining([f.openArtistId, f.adultArtistId]));
        expect(ids).not.toContain(f.deniedArtistId);
        expect(result.totalCount).toBe(ids.length);
    });
});
