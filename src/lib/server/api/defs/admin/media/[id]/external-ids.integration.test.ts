// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../tests/integration/helpers/cleanup.js';
import * as connection from '$lib/server/database/connection.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import { ExternalIdsGetResponseSchema } from '$lib/schemas/api-media-responses.js';
import { GET } from '../../../../../../../routes/api/admin/media/[id]/external-ids/+server.js';
let sql: postgres.Sql;
const mediaId = randomUUID();
const admin = buildPrincipal({
    kind: 'pat',
    userId: toUserId(randomUUID()),
    username: 'external-id-admin',
    userGroups: [],
    tokenScopes: ['admin'],
    ownerIsAdmin: true,
});
async function request(principal: Principal | null = admin): Promise<Response> {
    const url = new URL(`http://localhost/api/admin/media/${mediaId}/external-ids`);
    const event = {
        url,
        params: { id: mediaId },
        request: new Request(url),
        locals: { principal },
        cookies: { get: () => undefined },
    } as unknown as RequestEvent;
    return GET!(event);
}
beforeAll(() => {
    sql = getTestDb();
    vi.spyOn(connection, 'getDb').mockReturnValue(sql);
});
beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
    await sql`INSERT INTO media_items(id,title,media_type,status) VALUES (${mediaId},'Fictional movie','movie','active')`;
});
afterAll(async () => {
    vi.restoreAllMocks();
    await closeTestDb();
});
it('serializes the real integer external-ID row key as the strict response string DTO', async () => {
    const [stored] =
        await sql`INSERT INTO external_ids(media_id,provider,external_id,media_type,is_primary) VALUES (${mediaId},'tmdb','550','movie',true) RETURNING id`;
    expect(typeof stored.id).toBe('number');
    const response = await request();
    expect(response.status).toBe(200);
    expect(ExternalIdsGetResponseSchema.parse(await response.json())).toEqual({
        externalIds: [
            { id: String(stored.id), external_id: '550', provider: 'tmdb', is_primary: true },
        ],
    });
});
it('preserves admin authorization for provider identity reads', async () => {
    const viewer = buildPrincipal({
        kind: 'pat',
        userId: toUserId(randomUUID()),
        username: 'viewer',
        userGroups: [],
        tokenScopes: ['read'],
        ownerIsAdmin: false,
    });
    expect((await request(viewer)).status).toBe(403);
    expect((await request(null)).status).toBe(403);
});

it('retains a real nullable primary value in the canonical mounted GET response', async () => {
    const [stored] =
        await sql`INSERT INTO external_ids(media_id,provider,external_id,media_type,is_primary) VALUES (${mediaId},'tmdb','550','movie',null) RETURNING id`;
    const response = await request();
    expect(response.status).toBe(200);
    expect(ExternalIdsGetResponseSchema.parse(await response.json()).externalIds).toEqual([
        { id: String(stored.id), provider: 'tmdb', external_id: '550', is_primary: null },
    ]);
});
