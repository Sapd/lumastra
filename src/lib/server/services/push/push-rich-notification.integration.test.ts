// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * End-to-end coverage for the rich-notification pair: the send path mints the
 * two signed URLs, and THIS SUITE FETCHES THEM.
 *
 * That last part is the entire point. `posterRef()` in `user-notifier.service.ts`
 * emitted `image/poster` (singular) — a route that has never existed — for
 * months, so every notification poster 404'd, and nothing caught it because "the
 * tests and the preprod e2e both asserted on the payload JSON and never rendered
 * the image". A test that checks a plausible-looking string is present in
 * `data.image_url` is precisely the test that already failed this codebase once.
 *
 * So: the payload comes out of a real `PushOutbox.deliveryPass()` against a real
 * database, and every URL it carries is routed through `dispatch()` below, which
 * matches the path against the SvelteKit route patterns the generator emitted and
 * returns a 404 when nothing matches. A misspelled path fails here the way it
 * would fail on a device.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import type { UserId } from '$lib/shared/user-id';

// Hoisted above every import below, so the delivery pass, the signed-URL helper
// and mount()'s feature gate all bind to the same mocked config.
const TEST_JWT_SECRET = 'push-rich-notification-integration-secret';
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            ...actual.config,
            get FEATURE_PUSH_NOTIFICATIONS() {
                return true;
            },
            get JWT_SECRET() {
                return TEST_JWT_SECRET;
            },
        },
    };
});

import { config } from '$lib/server/config.js';
import { PushOutbox } from '$lib/server/tasks/push-outbox.js';
import { FakePushTransport } from './fake-push-transport.js';
import type { PushRequest } from './push-transport.js';
import { resolvePushImageTarget, PUSH_CONTENT_URL_PURPOSE } from './push-rich-content.js';
import { buildPushImageUrl } from './push-rich-urls.js';
import { signUrl } from '$lib/server/utils/signed-url.js';
import { upsertPushToken } from '$lib/server/database/queries/user-push-tokens.queries.js';
import { enqueuePushOutbox } from '$lib/server/database/queries/user-push-outbox.queries.js';
import { mount } from '$lib/server/api/mount.js';
import { def as pushImageDef } from '$lib/server/api/defs/notifications/[id]/push-image.js';
import { def as pushContentDef } from '$lib/server/api/defs/notifications/[id]/push-content/[locale].js';

const USERNAME = 'pushrich_a';
const KIND_NEW_EPISODE = 'library.new_episode';
const KIND_REQUEST_AVAILABLE = 'request.available';
const ORIGIN = 'http://localhost';

let sql: postgres.Sql;
let user: UserId;
let transport: FakePushTransport;
let outbox: PushOutbox;

// ---------------------------------------------------------------------------
// A router, so a wrong path is a test failure rather than a manual param map
// ---------------------------------------------------------------------------

interface MountedRoute {
    routeId: string;
    pattern: RegExp;
    params: (match: RegExpExecArray) => Record<string, string>;
    def: typeof pushImageDef | typeof pushContentDef;
}

/**
 * The two mounts, spelled from the route ids the generator produced. `dispatch`
 * 404s on anything else — which is what turns "the URL the send path built"
 * into a real claim about reachability.
 */
const ROUTES: MountedRoute[] = [
    {
        routeId: '/api/v1/notifications/[id]/push-image',
        pattern: /^\/api\/v1\/notifications\/([^/]+)\/push-image$/,
        params: (m) => ({ id: m[1] }),
        def: pushImageDef,
    },
    {
        routeId: '/api/v1/notifications/[id]/push-content/[locale]',
        pattern: /^\/api\/v1\/notifications\/([^/]+)\/push-content\/([^/]+)$/,
        params: (m) => ({ id: m[1], locale: m[2] }),
        def: pushContentDef,
    },
];

function makeEvent(url: URL, params: Record<string, string>, routeId: string): RequestEvent {
    return {
        url,
        request: new Request(url.toString(), { method: 'GET' }),
        params,
        route: { id: routeId },
        // Unauthenticated by design — an NSE holds no session.
        locals: {},
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

/** Fetch a URL exactly as a device would: by PATH, through the real mounts. */
async function dispatch(rawUrl: string): Promise<Response> {
    const url = new URL(rawUrl, ORIGIN);
    for (const route of ROUTES) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        const { GET } = mount(route.def, { surface: 'v1' });
        return GET!(makeEvent(url, route.params(match), route.routeId));
    }
    // No mounted route claims this path — the `image/poster` failure mode.
    return new Response(null, { status: 404 });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A 1×1 PNG. Small on purpose: the assertion is "real bytes came back through
 * the real provider chain", not "sharp resizes correctly".
 */
const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

/**
 * `ImageProxyService.tryLocalArtwork` only serves files inside a library root or
 * inside the app's own managed extraction directory (`BASE_PATH/image-sync`).
 * The managed directory is the cheaper of the two to set up and is a real
 * production path — it is where ffmpeg-extracted episode frames land.
 */
const ARTWORK_DIR = path.join(config.BASE_PATH || '/tmp', 'image-sync', 'pushrich-itest');

async function writeArtwork(name: string): Promise<string> {
    const filePath = path.join(ARTWORK_DIR, name);
    await mkdir(ARTWORK_DIR, { recursive: true });
    await writeFile(filePath, PNG_1X1);
    return filePath;
}

async function makeUser(): Promise<UserId> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username) VALUES (${USERNAME}) RETURNING id
    `;
    return row.id as UserId;
}

async function addToken(token: string, locale: string): Promise<void> {
    const [device] = await sql<{ id: string }[]>`
        INSERT INTO user_devices (user_id, device_id, reported_name)
        VALUES (${user}, ${`dev-${token}`}, 'Test Device')
        RETURNING id
    `;
    await upsertPushToken(sql, {
        userId: user,
        deviceId: device.id,
        token,
        bundleId: 'de.hinterthaner.stellar-tvos.ios',
        environment: 'production',
        locale,
        payloadVersion: 1,
    });
}

async function insertMediaItem(opts: {
    id: string;
    title: string;
    mediaType: string;
    parentId?: string;
}): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, parent_id, has_files)
        VALUES (${opts.id}::uuid, ${opts.title}, ${opts.mediaType}, 'active',
                ${opts.parentId ?? null}, true)
    `;
}

async function insertLocalArtwork(
    mediaItemId: string,
    artworkType: 'poster' | 'thumb',
    filePath: string,
): Promise<void> {
    await sql`
        INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
        VALUES (${mediaItemId}::uuid, ${artworkType}, 'local', ${filePath})
    `;
}

async function makeNotification(
    kind: string,
    payload: postgres.JSONValue,
): Promise<{ id: string; createdAt: Date }> {
    const [row] = await sql<{ id: string; created_at: Date }[]>`
        INSERT INTO user_notifications (user_id, kind, payload, expires_at)
        VALUES (${user}, ${kind}, ${sql.json(payload)}, NOW() + INTERVAL '30 days')
        RETURNING id, created_at
    `;
    return { id: row.id, createdAt: row.created_at };
}

/**
 * Enqueue + deliver, and hand back the payloads the transport actually saw FOR
 * THIS notification.
 *
 * Filtered on `collapseId` (which is the notification id) rather than taking
 * `calls[0]`: a delivery pass claims every ready row in the database, including
 * ones a sibling push suite left behind, so an unfiltered read silently asserts
 * against someone else's payload.
 */
async function deliver(notificationId: string, kind: string): Promise<PushRequest[]> {
    await enqueuePushOutbox(sql, { userId: user, notificationId, kind });
    await outbox.deliveryPass();
    return transport.calls.filter((c) => c.collapseId === notificationId);
}

/** `data` of the single payload sent for this notification. */
function soleData(calls: PushRequest[]): Record<string, unknown> {
    expect(calls).toHaveLength(1);
    return calls[0].payload.data as unknown as Record<string, unknown>;
}

// A series with a poster and an episode with its own still.
const SERIES_ID = 'c0ffee00-0000-4000-8000-000000000001';
const EPISODE_ID = 'c0ffee00-0000-4000-8000-000000000002';
const MOVIE_ID = 'c0ffee00-0000-4000-8000-000000000003';

const EPISODE_PAYLOAD = {
    mediaId: EPISODE_ID,
    seriesId: SERIES_ID,
    seriesTitle: 'Starhaven',
    episodeTitle: 'Harbor Lantern',
    seasonNumber: 2,
    episodeNumber: 7,
};

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await rm(ARTWORK_DIR, { recursive: true, force: true });
    await closeTestDb();
});

beforeEach(async () => {
    transport = new FakePushTransport();
    outbox = new PushOutbox(sql, transport);

    const stale = await sql<{ id: string }[]>`
        SELECT id FROM users WHERE username = ${USERNAME}
    `;
    if (stale.length > 0) {
        const ids = stale.map((r) => r.id);
        await sql`DELETE FROM user_push_outbox WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM user_push_tokens WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM user_notifications WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM user_devices WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
    }
    await sql`
        DELETE FROM media_artwork
        WHERE media_item_id = ANY(${[SERIES_ID, EPISODE_ID, MOVIE_ID]}::uuid[])
    `;
    await sql`DELETE FROM media_items WHERE id = ANY(${[EPISODE_ID]}::uuid[])`;
    await sql`DELETE FROM media_items WHERE id = ANY(${[SERIES_ID, MOVIE_ID]}::uuid[])`;

    user = await makeUser();
});

// ---------------------------------------------------------------------------
// image_url
// ---------------------------------------------------------------------------

describe('image_url', () => {
    it('is fetchable and returns real image bytes', async () => {
        await insertMediaItem({ id: SERIES_ID, title: 'Starhaven', mediaType: 'tv' });
        await insertMediaItem({
            id: EPISODE_ID,
            title: 'Harbor Lantern',
            mediaType: 'episode',
            parentId: SERIES_ID,
        });
        await insertLocalArtwork(EPISODE_ID, 'thumb', await writeArtwork('episode-thumb.png'));
        await addToken('tok-en', 'en-US');

        const notification = await makeNotification(KIND_NEW_EPISODE, EPISODE_PAYLOAD);
        const data = soleData(await deliver(notification.id, KIND_NEW_EPISODE));

        const imageUrl = data.image_url as string | undefined;
        expect(imageUrl).toBeDefined();

        // The assertion the payload-only tests never made.
        const res = await dispatch(imageUrl!);
        expect(res.status).toBe(200);
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.byteLength).toBeGreaterThan(0);

        // JPEG SPECIFICALLY, not merely `image/*`.
        //
        // `UNNotificationAttachment` accepts only JPEG, PNG and GIF. This
        // assertion used to be `toMatch(/^image\//)`, which `image/webp`
        // satisfies — and the image proxy defaults to WebP. So prod served
        // WebP, the extension fetched it successfully (nginx: `200 2920`), the
        // attachment failed validation inside the extension, and every banner
        // fell back to the app icon. Green test, dead feature.
        expect(res.headers.get('content-type')).toBe('image/jpeg');
    });

    it('serves JPEG even when the stored artwork is a PNG', async () => {
        // The format must come from an explicit conversion, not from whatever
        // the source file happened to be — the fixture above is a PNG, so a
        // passthrough implementation would satisfy the assertion by accident.
        await insertMediaItem({ id: SERIES_ID, title: 'Starhaven', mediaType: 'tv' });
        await insertMediaItem({
            id: EPISODE_ID,
            title: 'Harbor Lantern',
            mediaType: 'episode',
            parentId: SERIES_ID,
        });
        await insertLocalArtwork(EPISODE_ID, 'thumb', await writeArtwork('episode-thumb.png'));
        await addToken('tok-en', 'en-US');

        const notification = await makeNotification(KIND_NEW_EPISODE, EPISODE_PAYLOAD);
        const data = soleData(await deliver(notification.id, KIND_NEW_EPISODE));

        const res = await dispatch(data.image_url as string);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/jpeg');

        // JPEG SOI marker — proves the bytes are really JPEG, not just labelled.
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]).toBe(0xd8);
    });

    it('is ABSENT when the install has no artwork for the notification', async () => {
        // The regression guard: deriving the URL from a path-builder would make
        // this key always present, and every artwork-less notification would
        // 404 on the device — exactly the case the client asked us to make
        // distinguishable.
        await insertMediaItem({ id: SERIES_ID, title: 'Starhaven', mediaType: 'tv' });
        await insertMediaItem({
            id: EPISODE_ID,
            title: 'Harbor Lantern',
            mediaType: 'episode',
            parentId: SERIES_ID,
        });
        await addToken('tok-en', 'en-US');

        const notification = await makeNotification(KIND_NEW_EPISODE, EPISODE_PAYLOAD);
        const data = soleData(await deliver(notification.id, KIND_NEW_EPISODE));

        expect(data.image_url).toBeUndefined();
        // …and the content URL is still there: text does not depend on artwork.
        expect(data.content_url).toBeDefined();
    });

    it('prefers the episode still and falls back to the series poster', async () => {
        await insertMediaItem({ id: SERIES_ID, title: 'Starhaven', mediaType: 'tv' });
        await insertMediaItem({
            id: EPISODE_ID,
            title: 'Harbor Lantern',
            mediaType: 'episode',
            parentId: SERIES_ID,
        });
        await insertLocalArtwork(SERIES_ID, 'poster', await writeArtwork('series-poster.png'));

        // Only the series has art → the poster is the target.
        expect(await resolvePushImageTarget(sql, KIND_NEW_EPISODE, EPISODE_PAYLOAD)).toEqual({
            mediaId: SERIES_ID,
            role: 'poster',
        });

        await insertLocalArtwork(EPISODE_ID, 'thumb', await writeArtwork('episode-thumb.png'));
        expect(await resolvePushImageTarget(sql, KIND_NEW_EPISODE, EPISODE_PAYLOAD)).toEqual({
            mediaId: EPISODE_ID,
            role: 'thumb',
        });
    });

    it('serves the poster for a request.available notification', async () => {
        await insertMediaItem({ id: MOVIE_ID, title: 'Dawn', mediaType: 'movie' });
        await insertLocalArtwork(MOVIE_ID, 'poster', await writeArtwork('movie-poster.png'));
        await addToken('tok-en', 'en-US');

        const notification = await makeNotification(KIND_REQUEST_AVAILABLE, {
            mediaId: MOVIE_ID,
            title: 'Dawn',
            year: 2021,
        });
        const data = soleData(await deliver(notification.id, KIND_REQUEST_AVAILABLE));

        const res = await dispatch(data.image_url as string);
        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// content_url
// ---------------------------------------------------------------------------

describe('content_url', () => {
    it('returns the real, media-naming title and body as JSON', async () => {
        await addToken('tok-en', 'en-US');
        const notification = await makeNotification(KIND_NEW_EPISODE, EPISODE_PAYLOAD);
        const calls = await deliver(notification.id, KIND_NEW_EPISODE);
        const data = soleData(calls);

        const res = await dispatch(data.content_url as string);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { title: string; body: string };
        expect(body.title).toBe('Starhaven');
        expect(body.body).toBe('S02E07 · Harbor Lantern is available');

        // The payload the relay saw named none of that.
        const alert = calls[0].payload.aps.alert;
        expect(alert.title).not.toBe('Starhaven');
        expect(JSON.stringify(alert)).not.toContain('Starhaven');
    });

    it('renders German for a de device, English for an en device', async () => {
        await addToken('tok-de', 'de-DE');
        await addToken('tok-en', 'en-US');
        const notification = await makeNotification(KIND_NEW_EPISODE, EPISODE_PAYLOAD);
        const calls = await deliver(notification.id, KIND_NEW_EPISODE);
        expect(calls).toHaveLength(2);

        const bodies: string[] = [];
        for (const call of calls) {
            const res = await dispatch(call.payload.data.content_url as string);
            expect(res.status).toBe(200);
            bodies.push(((await res.json()) as { body: string }).body);
        }

        expect(bodies.sort()).toEqual([
            'S02E07 · Harbor Lantern is available',
            'S02E07 · Harbor Lantern ist verfügbar',
        ]);
    });
});

// ---------------------------------------------------------------------------
// The signature is the whole credential
// ---------------------------------------------------------------------------

describe('signature enforcement', () => {
    async function mintedUrls(): Promise<{ image: string; content: string }> {
        await insertMediaItem({ id: SERIES_ID, title: 'Starhaven', mediaType: 'tv' });
        await insertMediaItem({
            id: EPISODE_ID,
            title: 'Harbor Lantern',
            mediaType: 'episode',
            parentId: SERIES_ID,
        });
        await insertLocalArtwork(EPISODE_ID, 'thumb', await writeArtwork('episode-thumb.png'));
        await addToken('tok-en', 'en-US');
        const notification = await makeNotification(KIND_NEW_EPISODE, EPISODE_PAYLOAD);
        const data = soleData(await deliver(notification.id, KIND_NEW_EPISODE));
        return { image: data.image_url as string, content: data.content_url as string };
    }

    it('rejects an unsigned request without revealing whether the notification exists', async () => {
        const { image, content } = await mintedUrls();
        for (const url of [image, content]) {
            const bare = new URL(url, ORIGIN).pathname;
            const res = await dispatch(bare);
            expect(res.status).toBe(403);
        }
    });

    it('rejects a tampered signature', async () => {
        const { image } = await mintedUrls();
        const url = new URL(image, ORIGIN);
        const sig = url.searchParams.get('sig')!;
        url.searchParams.set('sig', (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1));

        expect((await dispatch(url.toString())).status).toBe(403);
    });

    it('rejects an expired signature', async () => {
        const { image } = await mintedUrls();
        const pathname = new URL(image, ORIGIN).pathname;
        // Genuinely valid HMAC, genuinely past its expiry — the state a device
        // that stayed offline past the six-hour window would present.
        const expired = signUrl(pathname, { expiresIn: -60, purpose: 'push-image' });

        expect((await dispatch(expired)).status).toBe(403);
    });

    it('rejects a signature minted for the other endpoint (wrong purpose)', async () => {
        const { image } = await mintedUrls();
        const pathname = new URL(image, ORIGIN).pathname;
        const crossSigned = signUrl(pathname, {
            expiresIn: 3600,
            purpose: PUSH_CONTENT_URL_PURPOSE,
        });

        expect((await dispatch(crossSigned)).status).toBe(403);
    });

    it('404s a correctly signed URL for a notification that no longer exists', async () => {
        const pruned = '00000000-0000-4000-8000-0000000000ff';
        const imageUrl = buildPushImageUrl(pruned, new Date())!;
        const contentUrl = signUrl(`/api/v1/notifications/${pruned}/push-content/en`, {
            expiresIn: 3600,
            purpose: PUSH_CONTENT_URL_PURPOSE,
        });

        expect((await dispatch(imageUrl)).status).toBe(404);
        expect((await dispatch(contentUrl)).status).toBe(404);
    });
});
