// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback grants and /j play tokens carry the minting principal's admin capability.
 * Exercises grant delivery through resolveAuth and checkMediaAccess, plus the
 * unchanged /j play-token and narrowed-credential priority assertions.
 * Legacy mint/refresh endpoint assertions were removed with those endpoints.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { placeInLibraryGroup } from '../../../../tests/integration/fixtures/library-access.fixtures.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { def as startDef } from '$lib/server/api/defs/play-sessions/index.js';
import { buildGrantedHref, mintPlaybackGrant } from '$lib/server/services/playback-grant.js';
import {
    createAccessGroup,
    addMember,
    removeMember,
} from '$lib/server/services/access-control.service.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { upsertStreamPolicy } from '$lib/server/database/queries/play-sessions.queries.js';
import { createLibraryGroup } from '$lib/server/database/queries/library-groups.queries.js';
import { upsertLibraryGroupPermission } from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import { cacheSet, connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import {
    issuePlayToken,
    issueFileToken,
    validatePlayToken,
} from '$lib/server/jellyfin-compat/play-token.js';
import {
    buildPlayTokenUserContext,
    playTokenMintedByAdmin,
} from '$lib/server/jellyfin-compat/play-token-user.js';

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

vi.mock('$lib/server/services/info.service.js', () => ({
    pathScopedFromDeviceCaps: () => ({ subtitleRendering: { burnInRequired: [] } }),
    buildPlaybackStartInfo: async ({ internalId }: { internalId: string }) => ({
        ok: true,
        deliveryPaths: { direct: `/api/playback/${internalId}/file` },
        data: {
            playable: true,
            recommended: 'direct',
            transcode_reasons: [],
            tracks: { video: { container: 'mp4' }, audio: [], subtitles: [] },
            play_methods: { direct: { available: true } },
        },
    }),
}));

const patService = getPatService();
const noopMigration = async (): Promise<void> => undefined;

const suffix = randomUUID().slice(0, 8);
const ADMIN_USERNAME = `stadm_admin_${suffix}`;
const PLAIN_USERNAME = `stadm_plain_${suffix}`;
// Keeps the last-admin guard from refusing the demotion leg on a fresh DB.
const BACKSTOP_USERNAME = `stadm_backstop_${suffix}`;
const ALLOWED_GROUP = `stadm_allowed_${suffix}`;

let adminUserId: string;
let plainUserId: string;
let backstopUserId: string;
let restrictedItemId: string;
let openItemId: string;
let libraryGroupId: string;
let adminGroupId: string;
let adminPat: string;
let adminScopedPat: string;
let plainPat: string;

function baseEvent(url: URL, request: Request, routeId: string): RequestEvent {
    return {
        route: { id: routeId },
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => undefined,
            delete: () => undefined,
            serialize: () => '',
        },
        fetch: async () => new Response(null),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        request,
        url,
        params: {},
        locals: {},
    } as unknown as RequestEvent;
}

/** Resolve the account principal and mint a scoped grant for delivery-gate assertions. */
async function mintResponse(bearer: string, mediaId = restrictedItemId): Promise<Response> {
    const url = new URL('http://localhost/api/v1/play-sessions');
    const request = new Request(url, { headers: { authorization: `Bearer ${bearer}` } });
    const event = baseEvent(url, request, '/api/v1/play-sessions');
    expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
    return startDef.handlers.POST!(event, {
        surface: 'v1',
        input: {
            body: {
                mediaId,
                deviceId: randomUUID(),
                capabilities: {
                    containers: ['mp4'],
                    videoCodecs: ['h264'],
                    audioCodecs: ['aac'],
                    subtitleFormats: [],
                    hdr: [],
                },
            },
        },
    } as never);
}

interface DeliveryGrant {
    token: string;
    playbackSessionId: string | null;
}

interface MintResponseBody {
    playbackSessionId: string;
    grant: { id: string; token: string };
}

async function mintVia(bearer: string): Promise<DeliveryGrant> {
    const response = await mintResponse(bearer);
    expect(response.status).toBe(201);
    const body = (await response.json()) as MintResponseBody;
    expect(body.playbackSessionId).toBeTruthy();
    return { ...body.grant, playbackSessionId: body.playbackSessionId };
}

/** Use a stream token on an HLS URL; returns the library/age verdict for the item. */
async function streamVerdict(
    grant: DeliveryGrant,
    mediaId = restrictedItemId,
    mintedByAdmin = false,
): Promise<boolean> {
    const url = new URL(
        buildGrantedHref(grant, `/api/v1/playback/${mediaId}/hls/master.m3u8`),
        'http://localhost',
    );
    const event = baseEvent(url, new Request(url), '/api/v1/playback/[id]/hls/master.m3u8');
    const denied = await resolveAuth(event, noopMigration, true);
    expect(denied).toBeUndefined();
    expect(event.locals.authMethod).toBe('stream_token');
    // A stream token never passes admin route gates, whoever minted it.
    expect(event.locals.principal?.isAdmin).toBe(false);
    expect(event.locals.user?.mediaAccessIsAdmin).toBe(mintedByAdmin);
    return checkMediaAccess(getTestDb(), mediaId, event.locals.user);
}

async function playTokenVerdict(token: string): Promise<boolean> {
    const data = await validatePlayToken(token);
    expect(data).not.toBeNull();
    const user = await buildPlayTokenUserContext(data!.userId, {
        mintedByAdmin: data!.mintedByAdmin === true,
    });
    expect(user).not.toBeNull();
    return checkMediaAccess(getTestDb(), restrictedItemId, user!);
}

beforeAll(async () => {
    // /j play tokens live in Valkey.
    expect(await connectValkey()).toBe(true);
    const sql = getTestDb();
    [{ id: adminUserId }] = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${ADMIN_USERNAME}, false, false, '{}'::text[]) RETURNING id
    `;
    [{ id: plainUserId }] = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${PLAIN_USERNAME}, false, false, '{}'::text[]) RETURNING id
    `;
    [{ id: backstopUserId }] = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${BACKSTOP_USERNAME}, false, false, '{}'::text[]) RETURNING id
    `;
    const created = await createAccessGroup(sql, {
        name: `stadm_admins_${suffix}`,
        capabilities: [{ capability: 'admin' }],
    });
    if (!created.ok) throw new Error(`setup: createAccessGroup failed: ${created.message}`);
    adminGroupId = created.data.id;
    await addMember(sql, adminGroupId, adminUserId, null);
    await addMember(sql, adminGroupId, backstopUserId, null);

    await upsertStreamPolicy(sql, ADMIN_USERNAME, { max_concurrent_streams: -1 }, ADMIN_USERNAME);

    restrictedItemId = randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${restrictedItemId}::uuid, ${`Restricted ${suffix}`}, 'movie', 'active', true)
    `;
    openItemId = randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${openItemId}::uuid, ${`Open ${suffix}`}, 'movie', 'active', true)
    `;
    const group = await createLibraryGroup(sql, { name: `stadm_lib_${suffix}` });
    libraryGroupId = group.id;
    await placeInLibraryGroup(sql, {
        mediaItemId: restrictedItemId,
        mediaType: 'movie',
        libraryGroupId,
    });
    // Neither user is in ALLOWED_GROUP: only an admin bypass can reach the item.
    await upsertLibraryGroupPermission(sql, { libraryGroupId, allowedGroups: [ALLOWED_GROUP] });
    invalidateLibraryGroupPermissionsCache();

    adminPat = (
        await patService.create({
            userId: toUserId(adminUserId),
            name: 'stadm-admin',
            scopes: ['admin'],
            groups: [],
        })
    ).token;
    adminScopedPat = (
        await patService.create({
            userId: toUserId(adminUserId),
            name: 'stadm-scoped',
            scopes: ['read', 'write'],
            groups: [],
        })
    ).token;
    plainPat = (
        await patService.create({
            userId: toUserId(plainUserId),
            name: 'stadm-plain',
            scopes: ['read', 'write'],
            groups: [],
        })
    ).token;
});

afterAll(async () => {
    const sql = getTestDb();
    const users = [adminUserId, plainUserId, backstopUserId].filter(Boolean);
    await sql`DELETE FROM user_stream_policies WHERE user_id = ${ADMIN_USERNAME}`;
    await sql`DELETE FROM hls_playback_tokens WHERE user_id = ANY(${users}::uuid[])`;
    await sql`DELETE FROM personal_access_tokens WHERE user_id = ANY(${users}::uuid[])`;
    if (adminGroupId) {
        await sql`DELETE FROM user_access_groups WHERE group_id = ${adminGroupId}::uuid`;
        await sql`DELETE FROM access_groups WHERE id = ${adminGroupId}::uuid`;
    }
    await sql`DELETE FROM play_sessions WHERE user_id = ANY(${users}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${users}::uuid[])`;
    if (openItemId) await sql`DELETE FROM media_items WHERE id = ${openItemId}::uuid`;
    if (libraryGroupId) {
        await sql`DELETE FROM library_group_permissions WHERE library_group_id = ${libraryGroupId}::uuid`;
        await sql`
            DELETE FROM media_file_items WHERE file_id IN
                (SELECT id FROM media_files WHERE library_group_id = ${libraryGroupId}::uuid)
        `;
        await sql`DELETE FROM media_files WHERE library_group_id = ${libraryGroupId}::uuid`;
        await sql`DELETE FROM media_items WHERE id = ${restrictedItemId}::uuid`;
        await sql`DELETE FROM library_groups WHERE id = ${libraryGroupId}::uuid`;
    }
    invalidateLibraryGroupPermissionsCache();
    await disconnectValkey();
});

describe('stream token (HLS) on a restricted library item', () => {
    it('minted by an admin principal: streams', async () => {
        const token = await mintVia(adminPat);
        const sql = getTestDb();
        const [row] = await sql<{ minted_by_admin: boolean }[]>`
            SELECT minted_by_admin FROM hls_playback_tokens
            WHERE username = ${ADMIN_USERNAME} AND is_active = true
        `;
        expect(row.minted_by_admin).toBe(true);
        expect(await streamVerdict(token, restrictedItemId, true)).toBe(true);
    });

    it('minted by a scoped PAT of the same admin owner: 404 (no owner-flag leak)', async () => {
        // The scoped credential is refused at mint, like the page would refuse it.
        expect((await mintResponse(adminScopedPat)).status).toBe(404);
        // On an item it may open, the token it mints records no admin grant.
        const res = await mintResponse(adminScopedPat, openItemId);
        expect(res.status).toBe(201);
        const { grant, playbackSessionId } = (await res.json()) as MintResponseBody;
        expect(playbackSessionId).toBeTruthy();
        const sessionId = grant.id;
        expect(await streamVerdict({ ...grant, playbackSessionId }, openItemId, false)).toBe(true);
        const [row] = await getTestDb()<{ minted_by_admin: boolean }[]>`
            SELECT minted_by_admin FROM hls_playback_tokens WHERE id = ${sessionId}
        `;
        expect(row.minted_by_admin).toBe(false);
        // A row with that (false) flag for the restricted item is refused at use.
        const restrictedGrant = await mintPlaybackGrant({
            userId: adminUserId,
            mediaId: restrictedItemId,
            playbackSessionId: null,
            kind: 'video',
            clientIp: '*',
            mintedByAdmin: false,
        });
        expect(await streamVerdict(restrictedGrant)).toBe(false);
    });

    it('minted by a non-admin: 404', async () => {
        // The non-admin is refused at mint already; a token minted for them
        // directly must still be refused at use.
        expect((await mintResponse(plainPat)).status).toBe(404);
        const grant = await mintPlaybackGrant({
            userId: plainUserId,
            mediaId: restrictedItemId,
            playbackSessionId: null,
            kind: 'video',
            clientIp: '*',
            mintedByAdmin: false,
        });
        expect(await streamVerdict(grant)).toBe(false);
    });

    it('a token without the flag (minted before 16.301.0) behaves as non-admin', async () => {
        const grant = await mintPlaybackGrant({
            userId: adminUserId,
            mediaId: restrictedItemId,
            playbackSessionId: null,
            kind: 'video',
            clientIp: '*',
        });
        const sql = getTestDb();
        const [row] = await sql<{ minted_by_admin: boolean }[]>`
            SELECT minted_by_admin FROM hls_playback_tokens WHERE id = ${grant.id}
        `;
        expect(row.minted_by_admin).toBe(false);
        expect(await streamVerdict(grant)).toBe(false);
    });

    it('an admin-minted token loses the grant once the owner is demoted', async () => {
        const token = await mintVia(adminPat);
        expect(await streamVerdict(token, restrictedItemId, true)).toBe(true);
        const sql = getTestDb();
        const removed = await removeMember(sql, adminGroupId, adminUserId);
        expect(removed.ok).toBe(true);
        try {
            expect(await streamVerdict(token)).toBe(false);
        } finally {
            await addMember(sql, adminGroupId, adminUserId, null);
        }
        expect(await streamVerdict(token, restrictedItemId, true)).toBe(true);
    });
});

describe('/j play token on a restricted library item', () => {
    const playSession = () => `stadm-${randomUUID()}`;

    it('issued by an admin /j session: streams (play token and file token)', async () => {
        const jSessionUser = await buildPlayTokenUserContext(ADMIN_USERNAME);
        // The /j middleware sets a password session's capability to the
        // owner's admin flag (middleware.test.ts pins that); PlaybackInfo
        // mints with it.
        const mintedByAdmin = playTokenMintedByAdmin({
            ...jSessionUser!,
            mediaAccessIsAdmin: jSessionUser!.ownerIsAdmin,
        });
        expect(mintedByAdmin).toBe(true);
        const play = await issuePlayToken(restrictedItemId, ADMIN_USERNAME, playSession(), null, {
            mintedByAdmin,
        });
        const file = await issueFileToken(restrictedItemId, randomUUID(), ADMIN_USERNAME, null, {
            mintedByAdmin,
        });
        expect(await playTokenVerdict(play)).toBe(true);
        expect(await playTokenVerdict(file)).toBe(true);
    });

    it('issued through a compat PAT of the admin owner (isAdmin forced false): 404', async () => {
        const mintedByAdmin = playTokenMintedByAdmin({
            userId: toUserId(adminUserId),
            username: ADMIN_USERNAME,
            groups: '',
            userGroups: [],
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            ownerIsAdmin: false,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: false,
            liveTvPriority: 'low',
        });
        expect(mintedByAdmin).toBe(false);
        const play = await issuePlayToken(restrictedItemId, ADMIN_USERNAME, playSession(), null, {
            mintedByAdmin,
        });
        expect(await playTokenVerdict(play)).toBe(false);
    });

    it('issued to a non-admin: 404 even if the flag were set', async () => {
        const play = await issuePlayToken(restrictedItemId, PLAIN_USERNAME, playSession(), null, {
            mintedByAdmin: true,
        });
        expect(await playTokenVerdict(play)).toBe(false);
    });

    it('a token stored without the flag (issued before it existed) behaves as non-admin', async () => {
        const token = randomUUID();
        await cacheSet(
            `directplay:token:${token}`,
            JSON.stringify({ itemId: restrictedItemId, userId: ADMIN_USERNAME }),
            600,
        );
        expect(await playTokenVerdict(token)).toBe(false);
    });
});

describe('Live TV priority of a narrowed credential', () => {
    /** liveTvPriority that resolveAuth hands the Live TV routes for this credential. */
    async function priorityVia(opts: { bearer?: string; streamToken?: DeliveryGrant }): Promise<string> {
        const url = opts.streamToken
            ? new URL(
                  buildGrantedHref(
                      opts.streamToken,
                      `/api/v1/playback/${restrictedItemId}/hls/master.m3u8`,
                  ),
                  'http://localhost',
              )
            : new URL('http://localhost/api/v1/play-sessions');
        const request = new Request(url, {
            headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
        });
        const event = baseEvent(
            url,
            request,
            opts.streamToken ? '/api/v1/playback/[id]/hls/master.m3u8' : '/api/v1/play-sessions',
        );
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        return event.locals.user!.liveTvPriority;
    }

    it('an admin PAT keeps the admin owner high priority', async () => {
        expect(await priorityVia({ bearer: adminPat })).toBe('high');
    });

    it('a scoped PAT of the admin owner is low priority', async () => {
        expect(await priorityVia({ bearer: adminScopedPat })).toBe('low');
    });

    it('a force_non_admin PAT of the admin owner is low priority', async () => {
        const forced = (
            await patService.create({
                userId: toUserId(adminUserId),
                name: 'stadm-forced',
                scopes: ['admin'],
                groups: [],
            })
        ).token;
        // Narrowed before first use: validated PATs are cached.
        await getTestDb()`
            UPDATE personal_access_tokens SET force_non_admin = true
            WHERE user_id = ${adminUserId}::uuid AND name = 'stadm-forced'
        `;
        expect(await priorityVia({ bearer: forced })).toBe('low');
    });

    it('a stream token minted by an admin principal keeps high priority', async () => {
        const token = await mintVia(adminPat);
        expect(await priorityVia({ streamToken: token })).toBe('high');
    });

    it('a stream token without the admin grant is low priority for an admin owner', async () => {
        const grant = await mintPlaybackGrant({
            userId: adminUserId,
            mediaId: restrictedItemId,
            playbackSessionId: null,
            kind: 'video',
            clientIp: '*',
            mintedByAdmin: false,
        });
        expect(await priorityVia({ streamToken: grant })).toBe('low');
    });
});
