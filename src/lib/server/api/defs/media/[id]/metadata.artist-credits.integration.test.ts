// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { getAdminArtistTracks } from '$lib/server/database/queries/admin-artist-tracks.queries.js';
import { confirmArtistCredits } from '$lib/server/services/music/artist-credit-review.js';
import {
    trackArtistsSql,
    trackRemixerArtistsSql,
} from '$lib/server/database/queries/fragments/music-artist.fragments.js';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../tests/integration/helpers/cleanup.js';
import * as connection from '$lib/server/database/connection.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    ArtistCreditReviewResponseSchema,
    type ArtistCreditChoice,
} from '$lib/schemas/music-credit-review.js';
import { GET, PATCH } from '../../../../../../routes/api/media/[id]/metadata/+server.js';
let sql: postgres.Sql;
const userId = toUserId(randomUUID());
const admin = buildPrincipal({
    kind: 'pat',
    userId,
    username: 'credit-admin',
    userGroups: [],
    tokenScopes: ['admin'],
    ownerIsAdmin: true,
});
const ids = {
    track: randomUUID(),
    album: randomUUID(),
    owner: randomUUID(),
    lead: randomUUID(),
    guest: randomUUID(),
    remixer: randomUUID(),
    file: randomUUID(),
    independent: randomUUID(),
};
async function request(
    method: 'GET' | 'PATCH',
    body?: unknown,
    principal: Principal | null = admin,
    pathId: string = ids.track,
): Promise<Response> {
    const url = new URL(
        `http://localhost/api/media/${pathId}/metadata${method === 'GET' ? '?includeArtistCredits=1' : ''}`,
    );
    const event = {
        url,
        params: { id: pathId },
        request: new Request(url, {
            method,
            ...(method === 'PATCH'
                ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
                : {}),
        }),
        locals: { principal, resolvedIds: { internalId: ids.track } },
        cookies: { get: () => undefined },
    } as unknown as RequestEvent;
    return method === 'GET' ? GET!(event) : PATCH!(event);
}
async function review() {
    const response = await request('GET');
    expect(response.status).toBe(200);
    return ArtistCreditReviewResponseSchema.parse(await response.json()).artistCreditReview;
}
function choices(): ArtistCreditChoice[] {
    return [
        {
            artist: { id: ids.lead, name: 'Lantern Lead' },
            creditedAs: 'Lantern',
            role: 'performer',
        },
        {
            artist: { id: ids.guest, name: 'Harbour Guest' },
            creditedAs: 'Harbour',
            role: 'performer',
        },
        {
            artist: { id: ids.lead, name: 'Lantern Lead' },
            creditedAs: 'Lantern Remix',
            role: 'remixer',
        },
    ];
}
async function snapshot() {
    const [row] =
        await sql`SELECT title,title_source,parent_id,overview,year,custom_poster_url FROM media_items WHERE id=${ids.track}`;
    const files = await sql`SELECT to_jsonb(f) AS value FROM media_files f WHERE id=${ids.file}`;
    const links =
        await sql`SELECT to_jsonb(l) AS value FROM media_file_items l WHERE media_item_id=${ids.track}`;
    const watch =
        await sql`SELECT to_jsonb(w) AS value FROM user_media_state w WHERE media_id=${ids.track}`;
    const external =
        await sql`SELECT to_jsonb(e) AS value FROM external_ids e WHERE media_id=ANY(${Object.values(ids)}::uuid[]) ORDER BY media_id,provider`;
    const [album] = await sql`SELECT to_jsonb(a) AS value FROM media_items a WHERE id=${ids.album}`;
    return {
        row,
        files: [...files],
        links: [...links],
        watch: [...watch],
        external: [...external],
        album,
    };
}
beforeAll(() => {
    sql = getTestDb();
    vi.spyOn(connection, 'getDb').mockReturnValue(sql);
    vi.spyOn(aiDbService, 'getSql').mockResolvedValue(sql);
});
afterAll(async () => {
    await sql`DELETE FROM users WHERE id=${userId}`;
    vi.restoreAllMocks();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
    await sql`DELETE FROM audit_log WHERE action='music.track.credits.confirm'`;
    await sql`INSERT INTO users(id,username) VALUES (${userId},${`credit-${userId}`}) ON CONFLICT(id) DO NOTHING`;
    for (const [id, title] of [
        [ids.owner, 'Compilation Owner'],
        [ids.lead, 'Lantern Lead'],
        [ids.guest, 'Harbour Guest'],
        [ids.remixer, 'Original Remixer'],
        [ids.independent, 'Independent Producer'],
    ])
        await sql`INSERT INTO media_items(id,title,media_type,status) VALUES (${id},${title},'artist','active')`;
    await sql`INSERT INTO media_items(id,title,media_type,status,parent_id) VALUES (${ids.album},'Keep Album','album','active',${ids.owner})`;
    const meta = {
        artist: 'Lantern Lead & Harbour Guest',
        raw_artist_tags: { artist: 'Lantern Lead & Harbour Guest' },
        track_artist_credits: [{ id: ids.lead, credited_name: 'Old lead' }],
        file_artist_ids: [ids.lead],
        album_artist_ids: [ids.owner],
        remixer_artist_ids: [ids.remixer],
        independent_remixer_artist_ids: [ids.remixer],
        additional_artist_ids: [ids.lead, ids.owner, ids.remixer, ids.independent],
        sentinel: { keep: true },
    };
    await sql`INSERT INTO media_items(id,title,title_source,media_type,status,parent_id,custom_metadata) VALUES (${ids.track},'Keep Song (Version Mix)','filename','track','active',${ids.album},${sql.json(meta)})`;
    await sql`INSERT INTO media_files(id,file_path,file_size_bytes) VALUES (${ids.file},'/fictional/credit.mp3',123)`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${ids.file},${ids.track},true)`;
    await sql`INSERT INTO user_media_state(user_id,media_id,is_watched,resume_position_ms) VALUES (${userId},${ids.track},false,1234)`;
    await sql`INSERT INTO external_ids(media_id,provider,external_id,media_type,is_primary) VALUES (${ids.track},'musicbrainz','keep-track','track',true)`;
});
it('atomically saves ordered performers and roles, audit/protection, and every unrelated relationship', async () => {
    const before = await snapshot();
    const prior = await review();
    const response = await request('PATCH', {
        confirmArtistCredits: { snapshot: prior.snapshot, credits: choices() },
    });
    expect(response.status).toBe(200);
    expect(await snapshot()).toEqual(before);
    const next = await review();
    expect(next.credits.map((credit) => [credit.id, credit.role, credit.creditedAs])).toEqual([
        [ids.lead, 'performer', 'Lantern'],
        [ids.guest, 'performer', 'Harbour'],
        [ids.lead, 'remixer', 'Lantern Remix'],
    ]);
    const [row] =
        await sql`SELECT custom_metadata,metadata_locked,metadata_locked_by FROM media_items WHERE id=${ids.track}`;
    expect(row.custom_metadata.additional_artist_ids).toEqual([
        ids.independent,
        ids.lead,
        ids.guest,
        ids.owner,
    ]);
    expect(row.custom_metadata.raw_artist_tags).toEqual({ artist: 'Lantern Lead & Harbour Guest' });
    expect(row.custom_metadata.sentinel).toEqual({ keep: true });
    expect(row.metadata_locked).toBe(true);
    expect(row.metadata_locked_by).toBe('credit-admin');
    const [musicRead] =
        await sql`SELECT ${trackArtistsSql(sql, 't')} AS artists,${trackRemixerArtistsSql(sql, 't')} AS remixers FROM media_items t WHERE t.id=${ids.track}`;
    expect(musicRead.artists.map((artist: { id: string }) => artist.id)).toEqual([
        ids.lead,
        ids.guest,
    ]);
    expect(musicRead.remixers.map((artist: { id: string }) => artist.id)).toEqual([ids.lead]);
    const audit =
        await sql`SELECT actor,detail FROM audit_log WHERE action='music.track.credits.confirm' AND target=${ids.track}`;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe('credit-admin');
    expect(audit[0].detail.ownershipChanged).toBe(false);
});
it.each(['title', 'lock', 'credits', 'parent', 'owner', 'selected'] as const)(
    'rejects stale %s without a partial write',
    async (kind) => {
        const prior = await review();
        if (kind === 'title')
            await sql`UPDATE media_items SET title='Changed' WHERE id=${ids.track}`;
        if (kind === 'lock')
            await sql`UPDATE media_items SET metadata_locked=true,metadata_locked_by='other' WHERE id=${ids.track}`;
        if (kind === 'credits')
            await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"track_artist_credits":[]}'::jsonb WHERE id=${ids.track}`;
        if (kind === 'parent')
            await sql`UPDATE media_items SET parent_id=null WHERE id=${ids.track}`;
        if (kind === 'owner')
            await sql`UPDATE media_items SET parent_id=${ids.guest} WHERE id=${ids.album}`;
        if (kind === 'selected')
            await sql`UPDATE media_items SET title='Renamed Guest' WHERE id=${ids.guest}`;
        const before = await snapshot();
        const response = await request('PATCH', {
            confirmArtistCredits: { snapshot: prior.snapshot, credits: choices() },
        });
        expect(response.status).toBe(409);
        expect(await snapshot()).toEqual(before);
        expect(
            (await sql`SELECT id FROM audit_log WHERE action='music.track.credits.confirm'`).length,
        ).toBe(0);
    },
);
it('rejects denied, missing actor, exclusive-body and invalid-role requests', async () => {
    const prior = await review();
    const body = { confirmArtistCredits: { snapshot: prior.snapshot, credits: choices() } };
    const nonadmin = buildPrincipal({
        kind: 'pat',
        userId,
        username: 'viewer',
        userGroups: [],
        tokenScopes: ['read'],
        ownerIsAdmin: false,
    });
    expect((await request('PATCH', body, nonadmin)).status).toBe(403);
    expect((await request('PATCH', body, null)).status).toBe(403);
    expect((await request('PATCH', body, { ...admin, username: '' })).status).toBe(401);
    expect((await request('PATCH', { ...body, title: 'Overwritten' })).status).toBe(422);
    expect(
        (
            await request('PATCH', {
                confirmArtistCredits: {
                    snapshot: prior.snapshot,
                    credits: [{ ...choices()[0], role: 'producer' }],
                },
            })
        ).status,
    ).toBe(422);
    expect(
        (
            await request('PATCH', {
                confirmArtistCredits: {
                    snapshot: prior.snapshot,
                    credits: [choices()[0], choices()[0]],
                },
            })
        ).status,
    ).toBe(422);
    expect((await request('PATCH', body, admin, 'tmdb:1:track')).status).toBe(409);
});
it('creates an explicitly named artist inside the reviewed transaction and rejects normalized collisions', async () => {
    const prior = await review();
    const credits: ArtistCreditChoice[] = [
        { artist: { newName: 'New Harbour Voice' }, creditedAs: 'New Harbour', role: 'performer' },
    ];
    expect(
        (await request('PATCH', { confirmArtistCredits: { snapshot: prior.snapshot, credits } }))
            .status,
    ).toBe(200);
    const next = await review();
    expect(next.credits[0].name).toBe('New Harbour Voice');
    expect(next.credits[0].id).not.toBeNull();
    const duplicate = [
        { artist: { newName: '  new harbour voice  ' }, creditedAs: 'Other', role: 'performer' },
    ];
    expect(
        (
            await request('PATCH', {
                confirmArtistCredits: { snapshot: next.snapshot, credits: duplicate },
            })
        ).status,
    ).toBe(409);
    expect((await review()).snapshot).toBe(next.snapshot);
});
it('rolls back a newly created artist if later selected-identity validation fails', async () => {
    const prior = await review();
    const credits = [
        { artist: { newName: 'Rollback Voice' }, creditedAs: 'New', role: 'performer' },
        {
            artist: { id: ids.guest, name: 'Wrong identity' },
            creditedAs: 'Wrong',
            role: 'performer',
        },
    ];
    expect(
        (await request('PATCH', { confirmArtistCredits: { snapshot: prior.snapshot, credits } }))
            .status,
    ).toBe(409);
    expect((await sql`SELECT id FROM media_items WHERE title='Rollback Voice'`).length).toBe(0);
    expect((await review()).snapshot).toBe(prior.snapshot);
});
it('serializes overlapping confirmations on independent backends', async () => {
    const prior = await review();
    const workers = [
        postgres(getTestDatabaseUrl(), { max: 1, onnotice: () => {} }),
        postgres(getTestDatabaseUrl(), { max: 1, onnotice: () => {} }),
    ];
    const gate = postgres(getTestDatabaseUrl(), { max: 1, onnotice: () => {} });
    const [a] = await workers[0]`SELECT pg_backend_pid() AS pid`;
    const [b] = await workers[1]`SELECT pg_backend_pid() AS pid`;
    expect(a.pid).not.toBe(b.pid);
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
        locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
        unlock = resolve;
    });
    const blocker = gate.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(84391025)`;
        locked();
        await release;
    });
    await ready;
    await sql`CREATE FUNCTION credit_overlap_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='music.track.credits.confirm' THEN PERFORM pg_advisory_xact_lock(84391025); END IF; RETURN NEW; END $$`;
    await sql`CREATE TRIGGER credit_overlap_gate BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION credit_overlap_gate()`;
    const first = confirmArtistCredits(workers[0], ids.track, 'credit-admin', {
        snapshot: prior.snapshot,
        credits: choices(),
    });
    try {
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            const locks =
                await sql`SELECT 1 FROM pg_locks WHERE pid=${a.pid} AND locktype='advisory' AND NOT granted`;
            if (locks.length) {
                waiting = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await expect(
            confirmArtistCredits(workers[1], ids.track, 'credit-admin', {
                snapshot: prior.snapshot,
                credits: choices(),
            }),
        ).rejects.toMatchObject({ kind: 'conflict' });
        unlock();
        await blocker;
        await first;
        expect(
            (await sql`SELECT id FROM audit_log WHERE action='music.track.credits.confirm'`).length,
        ).toBe(1);
    } finally {
        unlock();
        await blocker;
        await first.catch(() => {});
        await sql`DROP TRIGGER credit_overlap_gate ON audit_log`;
        await sql`DROP FUNCTION credit_overlap_gate()`;
        await Promise.all([...workers, gate].map((worker) => worker.end()));
    }
});
it('rolls back artists and credits when transactional audit insertion fails', async () => {
    const prior = await review();
    await sql`CREATE FUNCTION credit_audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='music.track.credits.confirm' THEN RAISE EXCEPTION 'audit refused'; END IF; RETURN NEW; END $$`;
    await sql`CREATE TRIGGER credit_audit_refuse BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION credit_audit_refuse()`;
    try {
        const response = await request('PATCH', {
            confirmArtistCredits: {
                snapshot: prior.snapshot,
                credits: [
                    {
                        artist: { newName: 'Audit Rollback Voice' },
                        creditedAs: 'New',
                        role: 'performer',
                    },
                ],
            },
        });
        expect(response.status).toBe(500);
        expect(
            (await sql`SELECT id FROM media_items WHERE title='Audit Rollback Voice'`).length,
        ).toBe(0);
        expect((await review()).snapshot).toBe(prior.snapshot);
    } finally {
        await sql`DROP TRIGGER credit_audit_refuse ON audit_log`;
        await sql`DROP FUNCTION credit_audit_refuse()`;
    }
});

it('artist workspace finds canonical guest/remixer credits across albums and counts the entire paged inventory', async () => {
    await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json({ track_artist_credits: [{ id: ids.guest, credited_name: 'Guest' }], additional_artist_ids: [] })} WHERE id=${ids.track}`;
    for (let n = 0; n < 55; n++)
        await sql`INSERT INTO media_items(title,media_type,status,parent_id,runtime_seconds,custom_metadata) VALUES (${`Paged ${String(n).padStart(2, '0')}`},'track','active',${ids.album},60,${sql.json({ remixer_artist_ids: [ids.guest] })})`;
    const all = await getAdminArtistTracks(sql, ids.guest, {
        q: '',
        issue: 'all',
        sort: 'title',
        page: 1,
    });
    expect(all.catalogTotal).toBe(56);
    expect(all.total).toBe(56);
    expect(all.tracks).toHaveLength(50);
    expect(all.durationSeconds).toBe(3300);
    const last = await getAdminArtistTracks(sql, ids.guest, {
        q: '',
        issue: 'all',
        sort: 'title',
        page: 2,
    });
    expect(last.tracks).toHaveLength(6);
    const filtered = await getAdminArtistTracks(sql, ids.guest, {
        q: 'Paged 54',
        issue: 'missing-file',
        sort: 'title',
        page: 1,
    });
    expect(filtered.total).toBe(1);
    expect(filtered.catalogTotal).toBe(56);
    expect(filtered.tracks[0].album_id).toBe(ids.album);
    await sql`UPDATE media_files SET is_missing=true WHERE id=${ids.file}`;
    const otherFile = randomUUID();
    await sql`INSERT INTO media_files(id,file_path,file_size_bytes) VALUES (${otherFile},'/fictional/alternate.mp3',321)`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${otherFile},${ids.track},false)`;
    const available = await getAdminArtistTracks(sql, ids.guest, {
        q: 'Keep Song',
        issue: 'missing-file',
        sort: 'album',
        page: 1,
    });
    expect(available.total).toBe(0);
});

it('removes old canonical memberships even when legacy projection fields are absent', async () => {
    await sql`UPDATE media_items SET custom_metadata=${sql.json({ artist: 'Legacy whole name', track_artist_credits: [{ id: ids.lead, credited_name: 'Old' }], track_remixer_credits: [{ id: ids.remixer, credited_name: 'Old remix' }], additional_artist_ids: [ids.lead, ids.remixer, ids.independent] })} WHERE id=${ids.track}`;
    const prior = await review();
    expect(prior.credits.map((credit) => [credit.id, credit.role, credit.creditedAs])).toEqual([
        [ids.lead, 'performer', 'Old'],
        [ids.remixer, 'remixer', 'Old remix'],
    ]);
    expect(
        (
            await request('PATCH', {
                confirmArtistCredits: {
                    snapshot: prior.snapshot,
                    credits: [
                        {
                            artist: { id: ids.guest, name: 'Harbour Guest' },
                            creditedAs: 'Guest',
                            role: 'performer',
                        },
                    ],
                },
            })
        ).status,
    ).toBe(200);
    const [row] = await sql`SELECT custom_metadata FROM media_items WHERE id=${ids.track}`;
    expect(row.custom_metadata.additional_artist_ids).toEqual([ids.independent, ids.guest]);
});

it('reads authoritative remixer order before projections and retains it through unrelated performer correction', async () => {
    await sql`UPDATE media_items SET custom_metadata=${sql.json({
        artist: 'Legacy',
        track_artist_credits: [{ id: ids.lead, credited_name: 'Old lead' }],
        track_remixer_credits: [
            { id: ids.remixer, credited_name: 'First mix' },
            { id: ids.lead, credited_name: 'Second mix' },
        ],
        remixer_artist_ids: [ids.lead, ids.independent],
        additional_artist_ids: [ids.lead, ids.remixer, ids.independent],
    })} WHERE id=${ids.track}`;
    const prior = await review();
    const remixers = prior.credits.filter((credit) => credit.role === 'remixer');
    expect(remixers.map((credit) => [credit.id, credit.creditedAs])).toEqual([
        [ids.remixer, 'First mix'],
        [ids.lead, 'Second mix'],
        [ids.independent, 'Independent Producer'],
    ]);
    const credits: ArtistCreditChoice[] = [
        {
            artist: { id: ids.guest, name: 'Harbour Guest' },
            creditedAs: 'Corrected guest',
            role: 'performer',
        },
        ...remixers.map((credit) => ({
            artist: { id: credit.id!, name: credit.name! },
            creditedAs: credit.creditedAs,
            role: credit.role,
        })),
    ];
    expect(
        (await request('PATCH', { confirmArtistCredits: { snapshot: prior.snapshot, credits } }))
            .status,
    ).toBe(200);
    const next = await review();
    expect(next.credits.filter((credit) => credit.role === 'remixer')).toEqual(remixers);
});
it('retains null unresolved canonical remixer identities for deliberate review', async () => {
    await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json({ track_remixer_credits: [{ id: null, credited_name: 'Unresolved whole name' }], remixer_artist_ids: [] })} WHERE id=${ids.track}`;
    const prior = await review();
    expect(prior.credits.at(-1)).toMatchObject({
        id: null,
        name: null,
        creditedAs: 'Unresolved whole name',
        role: 'remixer',
        active: false,
    });
});
