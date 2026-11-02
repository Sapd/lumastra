// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { TEST_TABLES, truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { findCollaborationArtists } from '$lib/server/database/queries/artist-merge.queries.js';
import {
    getCollaborationFingerprint,
    listCollaborationTracks,
} from '$lib/server/database/queries/collaboration-review.queries.js';
import { countMusicHygieneFinding } from '$lib/server/database/queries/music-hygiene.queries.js';
import { listAdminMediaItems } from '$lib/server/database/queries/admin-media.queries.js';
import * as connection from '$lib/server/database/connection.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import { randomUUID } from 'node:crypto';
import { CollaborationResponseSchema } from '$lib/schemas/collaboration-review.js';
import { MUSIC_HYGIENE_ARTIST_UNSPLIT } from '$lib/shared/music-hygiene.js';
import { confirmArtistCredits, getArtistCreditReview } from './artist-credit-review.js';
import { POST } from '../../../../routes/api/admin/media/[id]/collaboration-review/+server.js';
import {
    applyCollaboration,
    previewCollaboration,
    returnCollaborationToQueue,
} from './collaboration-review.js';

async function artist(sql: postgres.Sql, title: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title,media_type) VALUES (${title},'artist') RETURNING id`;
    return row.id;
}
async function album(sql: postgres.Sql, parent: string, title: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title,media_type,parent_id) VALUES (${title},'album',${parent}) RETURNING id`;
    return row.id;
}
async function track(
    sql: postgres.Sql,
    parent: string,
    title: string,
    tag: string,
): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title,media_type,parent_id,custom_metadata)
        VALUES (${title},'track',${parent},${sql.json({ artist: tag })}) RETURNING id`;
    const [file] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path) VALUES (${'/music/collaboration-test/' + row.id + '.flac'}) RETURNING id`;
    await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default)
        VALUES (${file.id},${row.id},true)`;
    return row.id;
}

describe('collaboration bulk review (real PostgreSQL)', () => {
    let sql: postgres.Sql;
    const admin = buildPrincipal({
        kind: 'pat',
        userId: toUserId(randomUUID()),
        username: 'collaboration-admin',
        userGroups: [],
        tokenScopes: ['admin'],
        ownerIsAdmin: true,
    });
    beforeAll(() => {
        sql = getTestDb();
        vi.spyOn(connection, 'getDb').mockReturnValue(sql);
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });
    afterAll(async () => {
        vi.restoreAllMocks();
        await closeTestDb();
    });
    async function mountedRequest(
        id: string,
        body: unknown,
        principal: Principal | null = admin,
    ): Promise<Response> {
        const url = new URL(`http://localhost/api/admin/media/${id}/collaboration-review`);
        const event = {
            url,
            params: { id },
            request: new Request(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }),
            locals: { principal },
            cookies: { get: () => undefined },
        } as unknown as RequestEvent;
        return POST!(event);
    }

    it('enforces admin access and a strict mounted preview response', async () => {
        const id = await artist(sql, 'Liora feat. Nora');
        const viewer = buildPrincipal({
            kind: 'pat',
            userId: toUserId(randomUUID()),
            username: 'viewer',
            userGroups: [],
            tokenScopes: ['read'],
            ownerIsAdmin: false,
        });
        expect((await mountedRequest(id, { action: 'preview', members: [] }, viewer)).status).toBe(
            403,
        );
        expect(
            (await mountedRequest(id, { action: 'preview', members: [], extra: true })).status,
        ).toBe(422);
        const response = await mountedRequest(id, { action: 'preview', members: [] });
        expect(response.status).toBe(200);
        expect(CollaborationResponseSchema.parse(await response.json()).action).toBe('preview');
    });

    it('keeps dismissed tracks visible without blocking the remaining credit preview', async () => {
        const first = await artist(sql, 'Bracken');
        const second = await artist(sql, 'Seabright');
        const combined = await artist(sql, 'Bracken & Seabright');
        const release = await album(sql, combined, 'Coastal Duet');
        const hidden = await track(sql, release, 'Hidden take', 'Bracken & Seabright');
        const active = await track(sql, release, 'Current take', 'Bracken & Seabright');
        await sql`UPDATE media_items SET is_dismissed=true WHERE id=${hidden}`;
        const members = [
            { id: first, name: 'Bracken' },
            { id: second, name: 'Seabright' },
        ];
        const response = await mountedRequest(combined, { action: 'preview', members });
        expect(response.status).toBe(200);
        const body = CollaborationResponseSchema.parse(await response.json());
        if (body.action !== 'preview') throw new Error('Expected a preview');
        expect(body.preview.tracks.find((row) => row.id === hidden)).toMatchObject({
            status: 'abstain',
            reason: 'dismissed',
            reviewSnapshot: null,
            before: [],
            after: [],
        });
        expect(body.preview.tracks.find((row) => row.id === active)?.status).toBe('eligible');
        const request = {
            snapshot: body.preview.snapshot,
            members,
            trackIds: [active],
            markReviewed: false,
            albumOwnerAcknowledged: true,
        };
        await expect(
            applyCollaboration(sql, combined, 'operator', { ...request, trackIds: [hidden] }),
        ).rejects.toThrow('Only eligible preview tracks');
        await expect(applyCollaboration(sql, combined, 'operator', request)).resolves.toMatchObject(
            {
                changedTracks: 1,
                reviewed: true,
            },
        );
        const [untouched] = await sql`
            SELECT is_dismissed,custom_metadata,metadata_locked FROM media_items WHERE id=${hidden}`;
        expect(untouched).toMatchObject({
            is_dismissed: true,
            custom_metadata: { artist: 'Bracken & Seabright' },
            metadata_locked: false,
        });
        const ready = await previewCollaboration(sql, combined, members);
        const disposition = await mountedRequest(combined, {
            action: 'apply',
            ...request,
            snapshot: ready.snapshot,
            trackIds: [],
            markReviewed: true,
            keepDismissed: true,
        });
        expect(disposition.status).toBe(200);
        expect(await disposition.json()).toMatchObject({
            result: { changedTracks: 0, reviewed: true },
        });
        const [retained] = await sql`
            SELECT is_dismissed,custom_metadata,metadata_locked FROM media_items WHERE id=${hidden}`;
        expect(retained).toEqual(untouched);
        expect((await findCollaborationArtists(sql)).some((row) => row.id === combined)).toBe(
            false,
        );
        const refreshed = await previewCollaboration(sql, combined, members);
        await sql`UPDATE media_items SET is_dismissed=false WHERE id=${hidden}`;
        await expect(
            applyCollaboration(sql, combined, 'operator', {
                ...request,
                snapshot: refreshed.snapshot,
                trackIds: [],
            }),
        ).rejects.toThrow('Credits, tags or ownership changed');
    });

    it('does not open credit review for a dismissed combined artist', async () => {
        const combined = await artist(sql, 'Northfield & Lantern');
        await sql`UPDATE media_items SET is_dismissed=true WHERE id=${combined}`;
        const response = await mountedRequest(combined, { action: 'preview', members: [] });
        expect(response.status).toBe(404);
    });

    it('invalidates a preview when the combined artist is dismissed and restored', async () => {
        const first = await artist(sql, 'Bracken');
        const second = await artist(sql, 'Seabright');
        const combined = await artist(sql, 'Bracken & Seabright');
        const owner = await artist(sql, 'Other Stage');
        const release = await album(sql, owner, 'Guest Performance');
        const candidate = await track(sql, release, 'Duet', 'Bracken & Seabright');
        // This artist is referenced through a legacy credit array, rather than
        // being the album owner or a structured performer in the track snapshot.
        await sql`UPDATE media_items SET custom_metadata=custom_metadata ||
            ${sql.json({ additional_artist_ids: [combined] })}::jsonb WHERE id=${candidate}`;
        const members = [
            { id: first, name: 'Bracken' },
            { id: second, name: 'Seabright' },
        ];
        const preview = await previewCollaboration(sql, combined, members);
        expect(preview.tracks[0]?.status).toBe('eligible');
        await sql`UPDATE media_items SET is_dismissed=true WHERE id=${combined}`;
        await sql`UPDATE media_items SET is_dismissed=false WHERE id=${combined}`;
        await expect(
            applyCollaboration(sql, combined, 'operator', {
                snapshot: preview.snapshot,
                members,
                trackIds: [candidate],
                markReviewed: false,
                albumOwnerAcknowledged: true,
            }),
        ).rejects.toThrow('Credits, tags or ownership changed');
        const [unchanged] =
            await sql`SELECT metadata_locked FROM media_items WHERE id=${candidate}`;
        expect(unchanged.metadata_locked).toBe(false);
    });

    it.each(['unrelated', 'relevant'] as const)(
        'scopes freshness to displayed evidence when %s source tags change',
        async (scope) => {
            const first = await artist(sql, 'Bracken');
            const second = await artist(sql, 'Seabright');
            const combined = await artist(sql, 'Bracken & Seabright');
            const release = await album(sql, combined, 'Coastal Duet');
            const current = await track(sql, release, 'Current take', 'Bracken & Seabright');
            const members = [
                { id: first, name: 'Bracken' },
                { id: second, name: 'Seabright' },
            ];
            const review = await getArtistCreditReview(sql, current);
            await confirmArtistCredits(sql, current, 'operator', {
                snapshot: review.snapshot,
                credits: members.map((member) => ({
                    artist: member,
                    creditedAs: member.name,
                    role: 'performer' as const,
                })),
            });
            const initial = await previewCollaboration(sql, combined, members);
            expect(initial.tracks[0].status).toBe('already-resolved');
            const other = await artist(sql, 'Other Owner');
            const elsewhere = await album(sql, other, 'Other Album');
            await track(
                sql,
                elsewhere,
                'Unrelated arrival',
                scope === 'relevant' ? 'Bracken' : 'Elsewhere',
            );
            const response = await mountedRequest(combined, {
                action: 'apply',
                snapshot: initial.snapshot,
                members,
                trackIds: [],
                markReviewed: true,
                albumOwnerAcknowledged: true,
            });
            expect(response.status).toBe(scope === 'relevant' ? 409 : 200);
        },
    );

    it.each(['locked', 'missing-source-tag', 'uncertain-files'] as const)(
        'does not complete a still-joined locked track, preserving %s reason precedence',
        async (reason) => {
            const first = await artist(sql, 'Wren');
            const second = await artist(sql, 'Alder');
            const combined = await artist(sql, 'Wren & Alder');
            const release = await album(sql, combined, 'Paper Horizon');
            const protectedTrack = await track(sql, release, 'Protected Horizon', 'Wren & Alder');
            await sql`UPDATE media_items SET metadata_locked=true,
                custom_metadata=custom_metadata || jsonb_build_object('track_artist_credits',jsonb_build_array(jsonb_build_object('id',${combined}::text,'credited_name','Wren & Alder')))
                WHERE id=${protectedTrack}`;
            if (reason === 'missing-source-tag')
                await sql`UPDATE media_items SET custom_metadata=custom_metadata-'artist' WHERE id=${protectedTrack}`;
            if (reason === 'uncertain-files')
                await sql`DELETE FROM media_file_items WHERE media_item_id=${protectedTrack}`;
            const members = [
                { id: first, name: 'Wren' },
                { id: second, name: 'Alder' },
            ];
            const preview = await previewCollaboration(sql, combined, members);
            expect(preview.tracks[0]).toMatchObject({ status: 'abstain', reason });
            const response = await mountedRequest(combined, {
                action: 'apply',
                snapshot: preview.snapshot,
                members,
                trackIds: [],
            });
            expect(response.status).toBe(422);
            expect((await previewCollaboration(sql, combined, members)).reviewed).toBe(false);
        },
    );

    it('does not let dismissal retention bypass an unresolved active track', async () => {
        const first = await artist(sql, 'Bracken');
        const second = await artist(sql, 'Seabright');
        const combined = await artist(sql, 'Bracken & Seabright');
        const release = await album(sql, combined, 'Coastal Duet');
        const hidden = await track(sql, release, 'Hidden take', 'Bracken & Seabright');
        await sql`UPDATE media_items SET is_dismissed=true WHERE id=${hidden}`;
        await track(sql, release, 'Uncertain take', 'Other source');
        const members = [
            { id: first, name: 'Bracken' },
            { id: second, name: 'Seabright' },
        ];
        const preview = await previewCollaboration(sql, combined, members);
        expect(preview.tracks.some((row) => row.reason === 'missing-source-tag')).toBe(true);
        const response = await mountedRequest(combined, {
            action: 'apply',
            snapshot: preview.snapshot,
            members,
            trackIds: [],
            markReviewed: true,
            albumOwnerAcknowledged: true,
            keepDismissed: true,
        });
        expect(response.status).toBe(422);
        expect((await findCollaborationArtists(sql)).some((row) => row.id === combined)).toBe(true);
        expect((await previewCollaboration(sql, combined, members)).reviewed).toBe(false);
    });

    it.each(['album', 'owner'] as const)(
        'rejects changed external %s names when retaining dismissed credits',
        async (changed) => {
            const first = await artist(sql, 'Bracken');
            const second = await artist(sql, 'Seabright');
            const combined = await artist(sql, 'Bracken & Seabright');
            const other = await artist(sql, 'Other Owner');
            const release = await album(sql, other, 'External Album');
            const hidden = await track(sql, release, 'Hidden take', 'Bracken & Seabright');
            await sql`UPDATE media_items SET is_dismissed=true,custom_metadata=custom_metadata || ${sql.json({ additional_artist_ids: [combined] })} WHERE id=${hidden}`;
            const members = [
                { id: first, name: 'Bracken' },
                { id: second, name: 'Seabright' },
            ];
            const initial = await previewCollaboration(sql, combined, members);
            expect(initial.tracks).toHaveLength(1);
            await sql`UPDATE media_items SET title='Changed acknowledgement' WHERE id=${changed === 'album' ? release : other}`;
            const response = await mountedRequest(combined, {
                action: 'apply',
                snapshot: initial.snapshot,
                members,
                trackIds: [],
                markReviewed: true,
                albumOwnerAcknowledged: true,
                keepDismissed: true,
            });
            expect(response.status).toBe(409);
            expect((await previewCollaboration(sql, combined, members)).reviewed).toBe(false);
            const refreshed = await previewCollaboration(sql, combined, members);
            const confirmed = await mountedRequest(combined, {
                action: 'apply',
                snapshot: refreshed.snapshot,
                members,
                trackIds: [],
                markReviewed: true,
                albumOwnerAcknowledged: true,
                keepDismissed: true,
            });
            expect(confirmed.status).toBe(200);
        },
    );

    it('returns a blocked preview instead of invalid proposed identities for unresolved guests', async () => {
        const first = await artist(sql, 'Bracken');
        const second = await artist(sql, 'Seabright');
        const combined = await artist(sql, 'Bracken & Seabright');
        const release = await album(sql, combined, 'Unresolved Guest');
        const candidate = await track(sql, release, 'Guest take', 'Bracken & Seabright');
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json({
            track_artist_credits: [
                { id: combined, credited_name: 'Bracken & Seabright' },
                { id: null, credited_name: 'Unknown Guest' },
            ],
        })}::jsonb WHERE id=${candidate}`;
        const response = await mountedRequest(combined, {
            action: 'preview',
            members: [
                { id: first, name: 'Bracken' },
                { id: second, name: 'Seabright' },
            ],
        });
        expect(response.status).toBe(200);
        const body = CollaborationResponseSchema.parse(await response.json());
        if (body.action !== 'preview') throw new Error('Expected a preview');
        expect(body.preview.tracks[0]).toMatchObject({
            status: 'abstain',
            reason: 'unsupported-performer',
            after: [],
        });
        expect(body.preview.tracks[0].before).toContainEqual(
            expect.objectContaining({
                id: null,
                creditedAs: 'Unknown Guest',
                active: false,
            }),
        );
    });

    it('acknowledges manually confirmed canonical credits without an exact combined source tag', async () => {
        const first = await artist(sql, 'Bracken');
        const second = await artist(sql, 'Seabright');
        const guest = await artist(sql, 'Lumen');
        const combined = await artist(sql, 'Bracken & Seabright');
        const release = await album(sql, combined, 'Guest Performance');
        const candidate = await track(
            sql,
            release,
            'Duet with guest',
            'Bracken & Seabright feat. Lumen',
        );
        const members = [
            { id: first, name: 'Bracken' },
            { id: second, name: 'Seabright' },
        ];
        const unresolved = await previewCollaboration(sql, combined, members);
        expect(unresolved.tracks[0]).toMatchObject({
            status: 'abstain',
            reason: 'missing-source-tag',
        });
        const review = await getArtistCreditReview(sql, candidate);
        await confirmArtistCredits(sql, candidate, 'operator', {
            snapshot: review.snapshot,
            credits: [...members, { id: guest, name: 'Lumen' }].map((member) => ({
                artist: member,
                creditedAs: member.name,
                role: 'performer' as const,
            })),
        });
        const [before] =
            await sql`SELECT custom_metadata,metadata_locked,xmin::text AS version FROM media_items WHERE id=${candidate}`;
        const resolved = await previewCollaboration(sql, combined, members);
        expect(resolved.tracks[0]).toMatchObject({
            status: 'already-resolved',
            reason: null,
            sourceTag: null,
        });
        expect(resolved.tracks[0].before).toEqual(
            resolved.tracks[0].after.map((credit) => ({
                id: 'id' in credit.artist ? credit.artist.id : null,
                name: 'name' in credit.artist ? credit.artist.name : null,
                creditedAs: credit.creditedAs,
                role: credit.role,
                active: true,
            })),
        );
        await expect(
            applyCollaboration(sql, combined, 'operator', {
                snapshot: resolved.snapshot,
                members,
                trackIds: [],
                markReviewed: true,
                albumOwnerAcknowledged: true,
            }),
        ).resolves.toMatchObject({ changedTracks: 0, reviewed: true });
        const [after] =
            await sql`SELECT custom_metadata,metadata_locked,xmin::text AS version FROM media_items WHERE id=${candidate}`;
        expect(after).toEqual(before);
        const [albumOwner] = await sql`SELECT parent_id FROM media_items WHERE id=${release}`;
        expect(albumOwner.parent_id).toBe(combined);
    });

    it('previews without mutation, applies selected credits atomically and returns only classification', async () => {
        const a = await artist(sql, 'Wilhart');
        const b = await artist(sql, 'Solara');
        const soloA = await album(sql, a, 'Wilhart Solo');
        const soloB = await album(sql, b, 'Solara Solo');
        await track(sql, soloA, 'A1', 'Wilhart');
        await track(sql, soloA, 'A2', 'Wilhart feat. Guest');
        await track(sql, soloB, 'B1', 'Solara');
        await track(sql, soloB, 'B2', 'Solara feat. Guest');
        const combined = await artist(sql, 'Wilhart & Solara');
        // This row participates in the real admin media-browser population,
        // whose normal scope excludes media without files.
        await sql`UPDATE media_items SET has_files=true WHERE id=${combined}`;
        const sharedAlbum = await album(sql, combined, 'Together');
        const selected = await track(sql, sharedAlbum, 'Together', 'Wilhart & Solara');
        const listener = randomUUID();
        await sql`INSERT INTO users (id,username) VALUES (${listener},${listener})`;
        const [playlist] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id,name) VALUES (${listener},'Duets') RETURNING id`;
        await sql`INSERT INTO playlist_items (playlist_id,media_id,title,position)
            VALUES (${playlist.id},${selected},'Saved duet',0)`;
        await sql`INSERT INTO music_listen_events (user_id,track_id,event_id)
            VALUES (${listener},${selected},${randomUUID()})`;
        const members = [
            { id: a, name: 'Wilhart' },
            { id: b, name: 'Solara' },
        ];
        const fingerprintBefore = await getCollaborationFingerprint(sql, combined);
        const preview = await previewCollaboration(sql, combined, members);
        expect(preview.tracks.find((row) => row.id === selected)?.status).toBe('eligible');
        expect(preview.witnesses[0]?.tags).toContain('Wilhart');
        expect(preview.albums).toEqual([
            {
                id: sharedAlbum,
                title: 'Together',
                ownerId: combined,
                ownerTitle: 'Wilhart & Solara',
            },
        ]);
        expect(await getCollaborationFingerprint(sql, combined)).toBe(fingerprintBefore);

        const result = await applyCollaboration(sql, combined, 'admin', {
            snapshot: preview.snapshot,
            members,
            trackIds: [selected],
            markReviewed: true,
            albumOwnerAcknowledged: true,
        });
        expect(result).toEqual({ changedTracks: 1, unchangedAlbums: 1, reviewed: true });
        const [saved] = await sql<
            { parent_id: string; custom_metadata: Record<string, unknown> }[]
        >`
            SELECT parent_id,custom_metadata FROM media_items WHERE id=${selected}`;
        expect(saved.parent_id).toBe(sharedAlbum);
        expect(saved.custom_metadata.track_artist_credits).toEqual([
            { id: a, credited_name: 'Wilhart' },
            { id: b, credited_name: 'Solara' },
        ]);
        const [owner] = await sql<{ parent_id: string }[]>`
            SELECT parent_id FROM media_items WHERE id=${sharedAlbum}`;
        expect(owner.parent_id).toBe(combined);
        expect(
            await sql`SELECT media_id,title,position FROM playlist_items WHERE playlist_id=${playlist.id}`,
        ).toMatchObject([{ media_id: selected, title: 'Saved duet', position: 0 }]);
        expect(
            await sql`SELECT track_id FROM music_listen_events WHERE user_id=${listener}`,
        ).toMatchObject([{ track_id: selected }]);
        expect((await findCollaborationArtists(sql)).some((row) => row.id === combined)).toBe(
            false,
        );
        const listReviewed = await listAdminMediaItems(sql, {
            types: ['artist'],
            musicHygiene: MUSIC_HYGIENE_ARTIST_UNSPLIT,
            limit: 200,
            offset: 0,
        });
        expect(listReviewed.some((row) => row.id === combined)).toBe(false);
        expect(await countMusicHygieneFinding(sql, MUSIC_HYGIENE_ARTIST_UNSPLIT)).toBe(0);
        expect(await returnCollaborationToQueue(sql, combined, 'admin')).toBe(true);
        expect((await findCollaborationArtists(sql)).some((row) => row.id === combined)).toBe(true);
        const listReturned = await listAdminMediaItems(sql, {
            types: ['artist'],
            musicHygiene: MUSIC_HYGIENE_ARTIST_UNSPLIT,
            limit: 200,
            offset: 0,
        });
        expect(listReturned.some((row) => row.id === combined)).toBe(true);
        expect(await countMusicHygieneFinding(sql, MUSIC_HYGIENE_ARTIST_UNSPLIT)).toBe(1);
        const [stillSaved] = await sql<{ custom_metadata: Record<string, unknown> }[]>`
            SELECT custom_metadata FROM media_items WHERE id=${selected}`;
        expect(stillSaved.custom_metadata.track_artist_credits).toEqual(
            saved.custom_metadata.track_artist_credits,
        );
        const reviewedAgain = await previewCollaboration(sql, combined, members);
        expect(reviewedAgain.tracks.find((row) => row.id === selected)?.status).toBe(
            'already-resolved',
        );
    });

    it('rejects stale source tags and leaves metadata unchanged', async () => {
        const a = await artist(sql, 'Liora');
        const b = await artist(sql, 'Nora');
        const combined = await artist(sql, 'Liora feat. Nora');
        const home = await album(sql, combined, 'Joint');
        const id = await track(sql, home, 'Duet', 'Liora feat. Nora');
        const members = [
            { id: a, name: 'Liora' },
            { id: b, name: 'Nora' },
        ];
        const preview = await previewCollaboration(sql, combined, members);
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json({ artist: 'Different' })} WHERE id=${id}`;
        await expect(
            applyCollaboration(sql, combined, 'admin', {
                snapshot: preview.snapshot,
                members,
                trackIds: [id],
                markReviewed: false,
                albumOwnerAcknowledged: false,
            }),
        ).rejects.toMatchObject({ kind: 'conflict' });
        const [row] = await sql<
            { custom_metadata: Record<string, unknown>; metadata_locked: boolean }[]
        >`
            SELECT custom_metadata,metadata_locked FROM media_items WHERE id=${id}`;
        expect(row.custom_metadata.track_artist_credits).toBeUndefined();
        expect(row.metadata_locked).toBe(false);
    });

    it('creates one explicit new identity across two selected tracks and rolls back on a locked conflict', async () => {
        const lead = await artist(sql, 'Mira');
        const combined = await artist(sql, 'Mira feat. Newcomer');
        const home = await album(sql, combined, 'Joint');
        const first = await track(sql, home, 'One', 'Mira feat. Newcomer');
        const second = await track(sql, home, 'Two', 'Mira feat. Newcomer');
        const members = [{ id: lead, name: 'Mira' }, { newName: 'Newcomer' }];
        const initial = await previewCollaboration(sql, combined, members);
        expect(initial.tracks.map((row) => row.status)).toEqual(['eligible', 'eligible']);

        await sql`UPDATE media_items SET metadata_locked=true WHERE id=${second}`;
        await expect(
            applyCollaboration(sql, combined, 'admin', {
                snapshot: initial.snapshot,
                members,
                trackIds: [first, second],
                markReviewed: true,
                albumOwnerAcknowledged: true,
            }),
        ).rejects.toMatchObject({ kind: 'conflict' });
        expect(
            await sql`SELECT 1 FROM media_items WHERE media_type='artist' AND title='Newcomer'`,
        ).toHaveLength(0);
        expect(
            await sql`SELECT 1 FROM audit_log WHERE action='music.collaboration.review' AND target=${combined}`,
        ).toHaveLength(0);

        await sql`UPDATE media_items SET metadata_locked=false WHERE id=${second}`;
        const fresh = await previewCollaboration(sql, combined, members);
        const result = await applyCollaboration(sql, combined, 'admin', {
            snapshot: fresh.snapshot,
            members,
            trackIds: [first, second],
            markReviewed: true,
            albumOwnerAcknowledged: true,
        });
        expect(result.changedTracks).toBe(2);
        const artists = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE media_type='artist' AND title='Newcomer'`;
        expect(artists).toHaveLength(1);
        const rows = await sql<
            { custom_metadata: { track_artist_credits: Array<{ id: string }> } }[]
        >`
            SELECT custom_metadata FROM media_items WHERE id=ANY(${[first, second]}::uuid[]) ORDER BY id`;
        expect(rows).toHaveLength(2);
        for (const row of rows)
            expect(row.custom_metadata.track_artist_credits.map((credit) => credit.id)).toEqual([
                lead,
                artists[0].id,
            ]);
        const reviewedAgain = await previewCollaboration(sql, combined, members);
        expect(reviewedAgain.tracks.map((row) => row.status)).toEqual([
            'already-resolved',
            'already-resolved',
        ]);
    });

    it('abstains for multiple files and a MusicBrainz-identified combined act', async () => {
        const lead = await artist(sql, 'Mira');
        const guest = await artist(sql, 'Nora');
        const combined = await artist(sql, 'Mira feat. Nora');
        await sql`UPDATE media_items SET has_files=true WHERE id=${combined}`;
        const home = await album(sql, combined, 'Joint');
        const id = await track(sql, home, 'Duet', 'Mira feat. Nora');
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/music/collaboration-test/extra.flac') RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file.id},${id},false)`;
        const members = [
            { id: lead, name: 'Mira' },
            { id: guest, name: 'Nora' },
        ];
        const preview = await previewCollaboration(sql, combined, members);
        expect(preview.tracks[0]).toMatchObject({ status: 'abstain', reason: 'uncertain-files' });
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type,is_primary)
            VALUES (${combined},'musicbrainz','known-act','artist',true)`;
        expect((await findCollaborationArtists(sql)).some((row) => row.id === combined)).toBe(
            false,
        );
        const protectedList = await listAdminMediaItems(sql, {
            types: ['artist'],
            musicHygiene: MUSIC_HYGIENE_ARTIST_UNSPLIT,
            limit: 200,
            offset: 0,
        });
        expect(protectedList.some((row) => row.id === combined)).toBe(false);
        expect(await countMusicHygieneFinding(sql, MUSIC_HYGIENE_ARTIST_UNSPLIT)).toBe(0);
        await expect(previewCollaboration(sql, combined, members)).rejects.toMatchObject({
            kind: 'invalid',
        });

        const metadataProtected = await artist(sql, 'Mira and Nora');
        await sql`UPDATE media_items SET has_files=true,
            custom_metadata=custom_metadata || ${sql.json({ musicbrainz_artist_id: 'metadata-known-act' })}
            WHERE id=${metadataProtected}`;
        expect(
            (await findCollaborationArtists(sql)).some((row) => row.id === metadataProtected),
        ).toBe(false);
        expect(
            (
                await listAdminMediaItems(sql, {
                    types: ['artist'],
                    musicHygiene: MUSIC_HYGIENE_ARTIST_UNSPLIT,
                    limit: 200,
                    offset: 0,
                })
            ).some((row) => row.id === metadataProtected),
        ).toBe(false);
        expect(await countMusicHygieneFinding(sql, MUSIC_HYGIENE_ARTIST_UNSPLIT)).toBe(0);
        await expect(previewCollaboration(sql, metadataProtected, members)).rejects.toMatchObject({
            kind: 'invalid',
        });
    });

    it('acknowledges album-artist evidence only for locked, already-resolved tracks', async () => {
        const a = await artist(sql, 'Ari');
        const b = await artist(sql, 'Bryn');
        const combined = await artist(sql, 'Ari & Bryn');
        const home = await album(sql, combined, 'Joint');
        const resolved = await track(sql, home, 'Resolved', 'Ari & Bryn');
        const unresolved = await track(sql, home, 'Unresolved', 'Ari & Bryn');
        const members = [
            { id: a, name: 'Ari' },
            { id: b, name: 'Bryn' },
        ];
        await sql`UPDATE media_items SET metadata_locked=true,
            custom_metadata=(custom_metadata - 'artist' - 'artists') || ${sql.json({
                album_artist: 'Ari & Bryn',
                album_artists: ['Ari & Bryn'],
                track_artist_credits: [
                    { id: a, credited_name: 'Ari' },
                    { id: b, credited_name: 'Bryn' },
                ],
            })} WHERE id=${resolved}`;
        await sql`UPDATE media_items SET custom_metadata=(custom_metadata - 'artist' - 'artists')
            || ${sql.json({ album_artist: 'Ari & Bryn', album_artists: ['Ari & Bryn'] })}
            WHERE id=${unresolved}`;

        const preview = await previewCollaboration(sql, combined, members);
        expect(preview.tracks.find((row) => row.id === resolved)).toMatchObject({
            sourceTag: 'Ari & Bryn',
            status: 'already-resolved',
        });
        expect(preview.tracks.find((row) => row.id === unresolved)).toMatchObject({
            sourceTag: null,
            status: 'abstain',
            reason: 'missing-source-tag',
        });
        // The unresolved track correctly blocks review; acknowledge and apply
        // only the already-resolved item in an otherwise complete snapshot.
        await sql`UPDATE media_items SET status='deleted' WHERE id=${unresolved}`;
        const complete = await previewCollaboration(sql, combined, members);
        const result = await applyCollaboration(sql, combined, 'admin', {
            snapshot: complete.snapshot,
            members,
            trackIds: [],
            markReviewed: true,
            albumOwnerAcknowledged: true,
        });
        expect(result).toEqual({ changedTracks: 0, unchangedAlbums: 1, reviewed: true });
        const [albumRow] = await sql<
            { parent_id: string }[]
        >`SELECT parent_id FROM media_items WHERE id=${home}`;
        expect(albumRow.parent_id).toBe(combined);
        const [trackRow] = await sql<
            { custom_metadata: Record<string, unknown>; metadata_locked: boolean }[]
        >`
            SELECT custom_metadata,metadata_locked FROM media_items WHERE id=${resolved}`;
        expect(trackRow.metadata_locked).toBe(true);
        expect(trackRow.custom_metadata.track_artist_credits).toEqual([
            { id: a, credited_name: 'Ari' },
            { id: b, credited_name: 'Bryn' },
        ]);
    });

    it('lists every array-only artist reference and includes new references in the review fingerprint', async () => {
        const a = await artist(sql, 'Elan');
        const b = await artist(sql, 'Faro');
        const combined = await artist(sql, 'Elan & Faro');
        const combinedAlbum = await album(sql, combined, 'Together');
        const eligible = await track(sql, combinedAlbum, 'Eligible', 'Elan & Faro');
        const unrelatedArtist = await artist(sql, 'North Lantern');
        const unrelatedAlbum = await album(sql, unrelatedArtist, 'Compilation');
        const arrayKeys = [
            'additional_artist_ids',
            'file_artist_ids',
            'album_artist_ids',
            'remixer_artist_ids',
            'title_remixer_artist_ids',
            'independent_remixer_artist_ids',
        ] as const;
        const arrayOnlyTracks: string[] = [];
        for (const [index, key] of arrayKeys.entries()) {
            const id = await track(sql, unrelatedAlbum, `Array ${index}`, 'Unrelated');
            await sql`UPDATE media_items SET custom_metadata=(custom_metadata - 'artist')
                || ${sql.json({ [key]: [combined] })} WHERE id=${id}`;
            arrayOnlyTracks.push(id);
        }
        for (const key of ['track_artist_credits', 'track_remixer_credits'] as const) {
            const id = await track(sql, unrelatedAlbum, key, 'Unrelated');
            await sql`UPDATE media_items SET custom_metadata=(custom_metadata - 'artist')
                || ${sql.json({ [key]: [{ id: combined, credited_name: 'Elan & Faro' }] })}
                WHERE id=${id}`;
            arrayOnlyTracks.push(id);
        }

        const listed = await listCollaborationTracks(sql, combined);
        expect(listed.tracks.map((row) => row.id)).toEqual(
            expect.arrayContaining([eligible, ...arrayOnlyTracks]),
        );
        const members = [
            { id: a, name: 'Elan' },
            { id: b, name: 'Faro' },
        ];
        const preview = await previewCollaboration(sql, combined, members);
        expect(preview.tracks.find((row) => row.id === eligible)?.status).toBe('eligible');
        expect(
            arrayOnlyTracks.every((id) =>
                preview.tracks.some((row) => row.id === id && row.status === 'abstain'),
            ),
        ).toBe(true);
        const partial = await applyCollaboration(sql, combined, 'admin', {
            snapshot: preview.snapshot,
            members,
            trackIds: [eligible],
        });
        expect(partial.reviewed).toBe(false);

        const reviewedArtist = await artist(sql, 'Sola & Tavi');
        const reviewedAlbum = await album(sql, reviewedArtist, 'Reviewed');
        const reviewedTrack = await track(sql, reviewedAlbum, 'Reviewed track', 'Sola & Tavi');
        const s = await artist(sql, 'Sola');
        const t = await artist(sql, 'Tavi');
        const solo = await artist(sql, 'Vesper');
        const compilation = await album(sql, solo, 'Other compilation');
        const externalTrack = await track(sql, compilation, 'External reference', 'Vesper');
        const reviewedMembers = [
            { id: s, name: 'Sola' },
            { id: t, name: 'Tavi' },
        ];
        const ready = await previewCollaboration(sql, reviewedArtist, reviewedMembers);
        await applyCollaboration(sql, reviewedArtist, 'admin', {
            snapshot: ready.snapshot,
            members: reviewedMembers,
            trackIds: [reviewedTrack],
            markReviewed: true,
            albumOwnerAcknowledged: true,
        });
        const beforeReference = await getCollaborationFingerprint(sql, reviewedArtist);
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json({
            independent_remixer_artist_ids: [reviewedArtist],
        })} WHERE id=${externalTrack}`;
        const afterReference = await getCollaborationFingerprint(sql, reviewedArtist);
        expect(afterReference).not.toBe(beforeReference);
        expect((await findCollaborationArtists(sql)).some((row) => row.id === reviewedArtist)).toBe(
            true,
        );
    });

    it('reopens a reviewed artist after a source edit and keeps partial repair in the queue', async () => {
        const lead = await artist(sql, 'Alara');
        const guest = await artist(sql, 'Beno');
        const combined = await artist(sql, 'Alara & Beno');
        const home = await album(sql, combined, 'Joint');
        const first = await track(sql, home, 'One', 'Alara & Beno');
        const second = await track(sql, home, 'Two', 'Alara & Beno');
        const members = [
            { id: lead, name: 'Alara' },
            { id: guest, name: 'Beno' },
        ];
        const initial = await previewCollaboration(sql, combined, members);
        const partial = await applyCollaboration(sql, combined, 'admin', {
            snapshot: initial.snapshot,
            members,
            trackIds: [first],
        });
        expect(partial.reviewed).toBe(false);
        expect((await findCollaborationArtists(sql)).some((row) => row.id === combined)).toBe(true);
        const remaining = await previewCollaboration(sql, combined, members);
        const complete = await applyCollaboration(sql, combined, 'admin', {
            snapshot: remaining.snapshot,
            members,
            trackIds: [second],
        });
        expect(complete.reviewed).toBe(true);
        expect((await findCollaborationArtists(sql)).some((row) => row.id === combined)).toBe(
            false,
        );
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json({ artist: 'Other source' })} WHERE id=${second}`;
        expect((await findCollaborationArtists(sql)).some((row) => row.id === combined)).toBe(true);
        expect((await previewCollaboration(sql, combined, members)).reviewed).toBe(false);
    });

    it('does not complete a capped collaboration with more than 200 tracks', async () => {
        const first = await artist(sql, 'Cedar');
        const second = await artist(sql, 'Lumen');
        const combined = await artist(sql, 'Cedar & Lumen');
        const release = await album(sql, combined, 'Many Windows');
        for (let i = 0; i < 201; i++)
            await track(sql, release, 'Window ' + String(i).padStart(3, '0'), 'Cedar & Lumen');
        const members = [
            { id: first, name: 'Cedar' },
            { id: second, name: 'Lumen' },
        ];
        const preview = await previewCollaboration(sql, combined, members);
        expect(preview.overflow).toBe(true);
        expect(preview.tracks).toHaveLength(200);
        const result = await applyCollaboration(sql, combined, 'curator', {
            snapshot: preview.snapshot,
            members,
            trackIds: [preview.tracks[0].id],
        });
        expect(result).toMatchObject({ changedTracks: 1, reviewed: false });
        expect((await previewCollaboration(sql, combined, members)).reviewed).toBe(false);
        expect(
            (await sql`SELECT count(*)::int n FROM media_items WHERE parent_id=${release}`)[0].n,
        ).toBe(201);
    });

    it('rejects a new no-split protection and never reviews an artist without candidate tracks', async () => {
        const a = await artist(sql, 'Ari');
        const b = await artist(sql, 'Bryn');
        const combined = await artist(sql, 'Ari & Bryn');
        const members = [
            { id: a, name: 'Ari' },
            { id: b, name: 'Bryn' },
        ];
        const empty = await previewCollaboration(sql, combined, members);
        expect(empty.tracks).toHaveLength(0);
        await expect(
            applyCollaboration(sql, combined, 'admin', {
                snapshot: empty.snapshot,
                members,
                trackIds: [],
                markReviewed: true,
                albumOwnerAcknowledged: true,
            }),
        ).rejects.toMatchObject({ kind: 'invalid' });
        const home = await album(sql, combined, 'Joint');
        const id = await track(sql, home, 'One', 'Ari & Bryn');
        const initial = await previewCollaboration(sql, combined, members);
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"no_split":true}'::jsonb WHERE id=${combined}`;
        await expect(
            applyCollaboration(sql, combined, 'admin', {
                snapshot: initial.snapshot,
                members,
                trackIds: [id],
                markReviewed: true,
                albumOwnerAcknowledged: true,
            }),
        ).rejects.toMatchObject({ kind: 'invalid' });
        const [row] = await sql<{ custom_metadata: Record<string, unknown> }[]>`
            SELECT custom_metadata FROM media_items WHERE id=${id}`;
        expect(row.custom_metadata.track_artist_credits).toBeUndefined();
    });

    it('abstains when a proposed new identity collides with an existing artist', async () => {
        const a = await artist(sql, 'Elan');
        await artist(sql, 'Faro');
        const combined = await artist(sql, 'Elan & Faro');
        const home = await album(sql, combined, 'Joint');
        await track(sql, home, 'One', 'Elan & Faro');
        const preview = await previewCollaboration(sql, combined, [
            { id: a, name: 'Elan' },
            { newName: 'Faro' },
        ]);
        expect(preview.tracks[0]).toMatchObject({
            status: 'abstain',
            reason: 'identity-collision',
        });
    });
});
