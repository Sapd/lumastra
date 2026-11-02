// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * Contract suite: per-item user data, intros and the universal audio stream,
 * through the real /j route handlers over real PG + Valkey.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { callAndCheck, jfEvent, mintJfSession } from './harness';
import { seedMovieEmbeddedSubs, seedMusicAlbum } from './seed';
import {
    GET as userDataGet,
    POST as userDataPost,
} from '../../src/routes/(proprietary)/j/UserItems/[itemId]/UserData/+server';
import { GET as introsGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/Intros/+server';
import { GET as collectionsGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/Collections/+server';
import { GET as universalGet } from '../../src/routes/(proprietary)/j/Audio/[itemId]/universal/+server';

import {
    POST as legacyPlayed,
    DELETE as legacyUnplayed,
} from '../../src/routes/(proprietary)/j/Users/[userId]/PlayedItems/[itemId]/+server';
import {
    GET as legacyUserData,
    POST as legacyUserDataPost,
} from '../../src/routes/(proprietary)/j/Users/[userId]/Items/[itemId]/UserData/+server';
import { GET as syncPlayList } from '../../src/routes/(proprietary)/j/SyncPlay/List/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c0de';
let sql: postgres.Sql;
let token: string;
let scratch: string;

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
    scratch = mkdtempSync(join(tmpdir(), 'jf-contract-universal-'));
});
afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    await ensureTestUser(sql, USER_ID);
    const [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
});

describe('/j user data and intros contract', () => {
    it('UserItems/{id}/UserData GET and POST', async () => {
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        const before = (await callAndCheck(
            'useritems-userdata',
            'UserItemDataDto',
            userDataGet,
            jfEvent({
                method: 'GET',
                path: `/j/UserItems/${itemId}/UserData`,
                token,
                params: { itemId },
            }),
        )) as { IsFavorite: boolean; Played: boolean; ItemId: string };
        expect(before).toMatchObject({ IsFavorite: false, Played: false, ItemId: itemId });

        const after = (await callAndCheck(
            'useritems-userdata-post',
            'UserItemDataDto',
            userDataPost,
            jfEvent({
                method: 'POST',
                path: `/j/UserItems/${itemId}/UserData`,
                token,
                params: { itemId },
                body: { IsFavorite: true, PlaybackPositionTicks: 300_000_000, Rating: null },
            }),
        )) as { IsFavorite: boolean; PlaybackPositionTicks: number };
        expect(after).toMatchObject({ IsFavorite: true, PlaybackPositionTicks: 300_000_000 });
    });

    it('legacy watched/unwatched aliases persist and read back through legacy UserData', async () => {
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        const userId = USER_ID.replaceAll('-', '');
        const ev = () =>
            jfEvent({
                method: 'POST',
                path: `/j/Users/${userId}/PlayedItems/${itemId}?DatePlayed=2026-10-29T21%3A11%3A11.834Z`,
                token,
                params: { itemId, userId },
            });
        expect(
            await callAndCheck('legacy-played', 'UserItemDataDto', legacyPlayed, ev(), {
                legacySchema: 'UserItemDataDto',
            }),
        ).toMatchObject({ Played: true, PlayCount: 1 });
        const read = () =>
            jfEvent({
                method: 'GET',
                path: `/j/Users/${userId}/Items/${itemId}/UserData`,
                token,
                params: { itemId, userId },
            });
        expect(
            await callAndCheck(
                'legacy-userdata-played',
                'UserItemDataDto',
                legacyUserData,
                read(),
                { legacySchema: 'UserItemDataDto' },
            ),
        ).toMatchObject({ Played: true });
        const stop = ev();
        stop.request = new Request(stop.url, { method: 'DELETE', headers: stop.request.headers });
        expect(
            await callAndCheck('legacy-unplayed', 'UserItemDataDto', legacyUnplayed, stop, {
                legacySchema: 'UserItemDataDto',
            }),
        ).toMatchObject({ Played: false, PlayCount: 0 });
        const update = jfEvent({
            method: 'POST',
            path: `/j/Users/${userId}/Items/${itemId}/UserData`,
            token,
            params: { itemId, userId },
            body: { PlaybackPositionTicks: 720_000_000 },
        });
        expect(
            await callAndCheck(
                'legacy-userdata-update',
                'UserItemDataDto',
                legacyUserDataPost,
                update,
                { legacySchema: 'UserItemDataDto' },
            ),
        ).toMatchObject({ Played: false, PlaybackPositionTicks: 720_000_000 });
        expect(
            await callAndCheck(
                'legacy-userdata-resume',
                'UserItemDataDto',
                legacyUserData,
                read(),
                { legacySchema: 'UserItemDataDto' },
            ),
        ).toMatchObject({ PlaybackPositionTicks: 720_000_000 });
    });

    it('SyncPlay groups are an empty authenticated array', async () => {
        const response = await syncPlayList(
            jfEvent({ method: 'GET', path: '/j/SyncPlay/List', token, params: {} }) as never,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
        const anonymous = await syncPlayList(
            jfEvent({ method: 'GET', path: '/j/SyncPlay/List', params: {} }) as never,
        );
        expect(anonymous.status).toBe(401);
    });

    it('Items/{id}/Intros', async () => {
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        const body = (await callAndCheck(
            'items-intros',
            'BaseItemDtoQueryResult',
            introsGet,
            jfEvent({
                method: 'GET',
                path: `/j/Items/${itemId}/Intros`,
                token,
                params: { itemId },
            }),
        )) as { Items: unknown[]; TotalRecordCount: number };
        expect(body).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    });

    it('Items/{id}/Collections (Jellyfin 12.x)', async () => {
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        const body = (await callAndCheck(
            'items-collections',
            'BaseItemDtoQueryResult',
            collectionsGet,
            jfEvent({
                method: 'GET',
                path: `/j/Items/${itemId}/Collections`,
                token,
                params: { itemId },
            }),
        )) as { Items: unknown[]; TotalRecordCount: number };
        expect(body).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    });
});

describe('/j universal audio', () => {
    // The direct-play answer is the file itself (no JSON body to check against
    // the SDK): assert status, type and bytes.
    it('Audio/{id}/universal direct-plays a listed container, with byte ranges', async () => {
        const { trackId, fileId } = await seedMusicAlbum(sql);
        const bytes = Buffer.from('ID3' + 'x'.repeat(997));
        const path = join(scratch, `${trackId}.mp3`);
        writeFileSync(path, bytes);
        await sql`UPDATE media_files SET file_path = ${path}, file_size_bytes = ${bytes.length}
                  WHERE id = ${fileId}`;

        const query = `container=opus,mp3|mp3,aac,m4a|aac,flac&transcodingContainer=ts&transcodingProtocol=hls&audioCodec=aac&maxStreamingBitrate=140000000&PlaySessionId=contract-universal`;
        const call = (range?: string): Promise<Response> => {
            const ev = jfEvent({
                method: 'GET',
                path: `/j/Audio/${trackId}/universal?${query}`,
                token,
                params: { itemId: trackId },
            });
            if (range) ev.request.headers.set('range', range);
            return (universalGet as unknown as (e: typeof ev) => Promise<Response>)(ev);
        };

        const full = await call();
        expect(full.status).toBe(200);
        expect(full.headers.get('content-type')).toMatch(/^audio\/mpeg/);
        expect(full.headers.get('accept-ranges')).toBe('bytes');
        expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);

        const part = await call('bytes=0-9');
        expect(part.status).toBe(206);
        expect(part.headers.get('content-type')).toMatch(/^audio\/mpeg/);
        expect(part.headers.get('content-range')).toBe(`bytes 0-9/${bytes.length}`);
        expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes.subarray(0, 10));
    });
});
