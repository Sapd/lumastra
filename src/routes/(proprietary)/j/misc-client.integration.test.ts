// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Route tests for the small client endpoints (cloud-parity brief 06): the real
 * handlers, the real withJellyfinAuth over a real Valkey session, real PG.
 * Each endpoint: the happy path, an item or user the caller may not see or
 * act on, and bad parameters.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/user.fixtures.js';
import { mintJfSession } from '../../../../tests/jellyfin-contract/harness';
import { seedMovieEmbeddedSubs, seedMusicTrack } from '../../../../tests/jellyfin-contract/seed';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { toUserId } from '$lib/shared/user-id';

import { GET as utcTimeGet } from './GetUtcTime/+server';
import { GET as culturesGet } from './Localization/Cultures/+server';
import { GET as countriesGet } from './Localization/Countries/+server';
import { GET as ratingsGet } from './Localization/ParentalRatings/+server';
import { GET as optionsGet } from './Localization/Options/+server';
import { GET as cssGet } from './Branding/Css/+server';
import { GET as cssDotCssGet } from './Branding/Css.css/+server';
import { GET as fontsGet } from './FallbackFont/Fonts/+server';
import { GET as fontGet } from './FallbackFont/Fonts/[name]/+server';
import { GET as authProvidersGet } from './Auth/Providers/+server';
import { GET as resetProvidersGet } from './Auth/PasswordResetProviders/+server';
import { GET as itemImagesGet } from './Items/[itemId]/Images/+server';
import { GET as yearsGet } from './Years/+server';
import { GET as yearGet } from './Years/[year]/+server';
import { POST as ratingPost, DELETE as ratingDelete } from './UserItems/[itemId]/Rating/+server';
import { POST as legacyRatingPost } from './Users/[userId]/Items/[itemId]/Rating/+server';
import { POST as qcAuthorizePost } from './QuickConnect/Authorize/+server';
import { POST as qcInitiatePost } from './QuickConnect/Initiate/+server';
import { GET as qcConnectGet } from './QuickConnect/Connect/+server';
import { POST as passwordPost } from './Users/Password/+server';
import { POST as legacyPasswordPost } from './Users/[userId]/Password/+server';
import { POST as userImagePost, DELETE as userImageDelete } from './UserImage/+server';
import { POST as configPost } from './Users/Configuration/+server';
import { POST as legacyConfigPost } from './Users/[userId]/Configuration/+server';
import { GET as meGet } from './Users/Me/+server';

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

type Handler = (e: never) => Promise<Response> | Response;

interface CallOpts {
    method?: string;
    token?: string;
    params?: Record<string, string>;
    body?: BodyInit;
    contentType?: string;
    /** Peer address the request comes from (default 127.0.0.1). */
    ip?: string;
}

async function call(handler: Handler, path: string, opts: CallOpts = {}): Promise<Response> {
    const url = new URL(`http://localhost${path}`);
    const auth = [
        'MediaBrowser Client="Jellyfin Android"',
        'Device="Test Phone"',
        'DeviceId="misc-client-device"',
        'Version="2.6.0"',
        ...(opts.token ? [`Token="${opts.token}"`] : []),
    ].join(', ');
    const request = new Request(url, {
        method: opts.method ?? 'GET',
        headers: {
            'x-emby-authorization': auth,
            ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
        },
        body: opts.body,
    });
    const event = {
        request,
        url,
        params: opts.params ?? {},
        locals: {},
        cookies: { get: () => undefined },
        getClientAddress: () => opts.ip ?? '127.0.0.1',
        setHeaders: () => {},
        route: { id: null },
    } as unknown as RequestEvent;
    return (handler as (e: RequestEvent) => Promise<Response> | Response)(event);
}

let sql: postgres.Sql;

interface TestUser {
    id: string;
    username: string;
    token: string;
}

async function makeUser(
    opts: { maxAgeRating?: number; isAdmin?: boolean } = {},
): Promise<TestUser> {
    const id = randomUUID();
    await ensureTestUser(sql, id);
    if (opts.maxAgeRating !== undefined) {
        await sql`UPDATE users SET max_age_rating = ${opts.maxAgeRating}, age_rating_pinned = true
                  WHERE id = ${id}`;
    }
    if (opts.isAdmin) {
        await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${id}`;
    }
    const [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${id}`;
    const token = await mintJfSession(sql, { userId: id, username });
    return { id, username, token };
}

/** A full-scope /j API key (PAT) for the user. */
async function mintJfPat(userId: string): Promise<string> {
    const { token } = await getPatService().create({
        userId: toUserId(userId),
        name: 'misc-client-pat',
        scopes: ['jellyfin_compat'],
        groups: [],
    });
    return token;
}

/** A movie only an adult may see (age_rating 18), plus artwork metadata. */
async function seedAdultMovie(): Promise<string> {
    const { itemId } = await seedMovieEmbeddedSubs(sql);
    await sql`UPDATE media_items SET age_rating = 18, year = 1999 WHERE id = ${itemId}`;
    return itemId;
}

async function seedMovieWithArtwork(): Promise<string> {
    const { itemId } = await seedMovieEmbeddedSubs(sql);
    await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
              VALUES (${itemId}, 'tmdb', ${sql.json({ poster_path: '/p.jpg', backdrop_path: '/b.jpg' })})`;
    return itemId;
}

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
});
afterAll(async () => {
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [
        ...TEST_TABLES.media,
        ...TEST_TABLES.userData,
        ...TEST_TABLES.preferences,
    ]);
});

describe.runIf(RUN)('/j GetUtcTime', () => {
    it('answers both timestamps without auth', async () => {
        const res = await call(utcTimeGet, '/j/GetUtcTime');
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, string>;
        expect(Date.parse(body.RequestReceptionTime)).not.toBeNaN();
        expect(Date.parse(body.ResponseTransmissionTime)).toBeGreaterThanOrEqual(
            Date.parse(body.RequestReceptionTime),
        );
    });
});

describe.runIf(RUN)('/j Localization', () => {
    it('lists cultures, countries, ratings and UI languages', async () => {
        const { token } = await makeUser();
        const cultures = (await (
            await call(culturesGet, '/j/Localization/Cultures', { token })
        ).json()) as { DisplayName: string; ThreeLetterISOLanguageNames: string[] }[];
        expect(cultures.find((c) => c.DisplayName === 'German')).toMatchObject({
            ThreeLetterISOLanguageNames: ['deu', 'ger'],
        });

        const countries = (await (
            await call(countriesGet, '/j/Localization/Countries', { token })
        ).json()) as { Name: string }[];
        expect(countries.some((c) => c.Name === 'DE')).toBe(true);

        const ratings = (await (
            await call(ratingsGet, '/j/Localization/ParentalRatings', { token })
        ).json()) as { Name: string }[];
        expect(ratings.map((r) => r.Name)).toEqual(expect.arrayContaining(['PG-13', 'Unrated']));

        const options = (await (
            await call(optionsGet, '/j/Localization/Options', { token })
        ).json()) as { Value: string }[];
        expect(options.map((o) => o.Value)).toContain('en');
    });

    it('requires a session', async () => {
        expect((await call(culturesGet, '/j/Localization/Cultures')).status).toBe(401);
    });
});

describe.runIf(RUN)('/j Branding/Css and FallbackFont', () => {
    it('serves an empty stylesheet on both paths', async () => {
        for (const [handler, path] of [
            [cssGet, '/j/Branding/Css'],
            [cssDotCssGet, '/j/Branding/Css.css'],
        ] as const) {
            const res = await call(handler, path);
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toMatch(/^text\/css/);
            expect(await res.text()).toBe('');
        }
    });

    it('has no fallback fonts', async () => {
        const { token } = await makeUser();
        const list = await call(fontsGet, '/j/FallbackFont/Fonts', { token });
        expect(await list.json()).toEqual([]);
        const one = await call(fontGet, '/j/FallbackFont/Fonts/Arial.ttf', {
            token,
            params: { name: 'Arial.ttf' },
        });
        expect(one.status).toBe(404);
    });
});

describe.runIf(RUN)('/j Auth providers', () => {
    it('lists the default providers to admins only', async () => {
        const admin = await makeUser({ isAdmin: true });
        const user = await makeUser();
        const providers = await call(authProvidersGet, '/j/Auth/Providers', { token: admin.token });
        expect(await providers.json()).toEqual([
            {
                Name: 'Default',
                Id: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
            },
        ]);
        const reset = await call(resetProvidersGet, '/j/Auth/PasswordResetProviders', {
            token: admin.token,
        });
        expect(((await reset.json()) as unknown[]).length).toBe(1);

        expect(
            (await call(authProvidersGet, '/j/Auth/Providers', { token: user.token })).status,
        ).toBe(403);
        expect(
            (await call(resetProvidersGet, '/j/Auth/PasswordResetProviders', { token: user.token }))
                .status,
        ).toBe(403);
    });
});

describe.runIf(RUN)('/j Items/{id}/Images', () => {
    it('lists the item images from its image tags', async () => {
        const { token } = await makeUser();
        const itemId = await seedMovieWithArtwork();
        const res = await call(itemImagesGet, `/j/Items/${itemId}/Images`, {
            token,
            params: { itemId },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ImageType: string; ImageIndex: number | null }[];
        expect(body).toContainEqual(
            expect.objectContaining({ ImageType: 'Primary', ImageIndex: null, Size: 0 }),
        );
        expect(body).toContainEqual(
            expect.objectContaining({ ImageType: 'Backdrop', ImageIndex: 0 }),
        );
        expect(body.every((i) => !('Path' in i))).toBe(true);
    });

    it('is a 404 for an item above the age limit, an unknown id and a non-id', async () => {
        const kid = await makeUser({ maxAgeRating: 12 });
        const itemId = await seedAdultMovie();
        for (const id of [itemId, randomUUID(), 'not-an-id']) {
            const res = await call(itemImagesGet, `/j/Items/${id}/Images`, {
                token: kid.token,
                params: { itemId: id },
            });
            expect(res.status).toBe(404);
        }
    });
});

describe.runIf(RUN)('/j Years', () => {
    it('lists visible years with counts, sorted and paged', async () => {
        const { token } = await makeUser();
        await seedMovieEmbeddedSubs(sql); // 2020
        await seedMovieEmbeddedSubs(sql); // 2020
        await seedAdultMovie(); // 1999

        const all = await call(yearsGet, '/j/Years?IncludeItemTypes=Movie&SortBy=SortName', {
            token,
        });
        const body = (await all.json()) as {
            Items: { Name: string; Type: string; ChildCount: number }[];
            TotalRecordCount: number;
        };
        expect(body.TotalRecordCount).toBe(2);
        expect(body.Items.map((y) => [y.Name, y.ChildCount])).toEqual([
            ['1999', 1],
            ['2020', 2],
        ]);
        expect(body.Items[0].Type).toBe('Year');

        const desc = await call(yearsGet, '/j/Years?SortOrder=Descending&StartIndex=0&Limit=1', {
            token,
        });
        const descBody = (await desc.json()) as {
            Items: { Name: string }[];
            TotalRecordCount: number;
        };
        expect(descBody.Items.map((y) => y.Name)).toEqual(['2020']);
        expect(descBody.TotalRecordCount).toBe(2);

        const series = await call(yearsGet, '/j/Years?IncludeItemTypes=Series', { token });
        expect(((await series.json()) as { Items: unknown[] }).Items).toEqual([]);
    });

    it('hides years that only hold items above the age limit', async () => {
        const kid = await makeUser({ maxAgeRating: 12 });
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        // Rated for all ages: unrated items stay hidden from age-limited users
        // unless UNRATED_CONTENT_VISIBLE is on.
        await sql`UPDATE media_items SET age_rating = 0 WHERE id = ${itemId}`;
        await seedAdultMovie();
        const res = await call(yearsGet, '/j/Years', { token: kid.token });
        const body = (await res.json()) as { Items: { Name: string }[] };
        expect(body.Items.map((y) => y.Name)).toEqual(['2020']);

        expect(
            (await call(yearGet, '/j/Years/1999', { token: kid.token, params: { year: '1999' } }))
                .status,
        ).toBe(404);
    });

    it('Years/{year} answers one year, 404 for an empty one, 400 for a non-number', async () => {
        const { token } = await makeUser();
        await seedMovieEmbeddedSubs(sql);
        const ok = await call(yearGet, '/j/Years/2020', { token, params: { year: '2020' } });
        expect(await ok.json()).toMatchObject({ Name: '2020', Type: 'Year', ChildCount: 1 });
        expect(
            (await call(yearGet, '/j/Years/1850', { token, params: { year: '1850' } })).status,
        ).toBe(404);
        expect(
            (await call(yearGet, '/j/Years/abc', { token, params: { year: 'abc' } })).status,
        ).toBe(400);
    });
});

describe.runIf(RUN)('/j UserItems/{id}/Rating', () => {
    it('maps thumbs up/down onto quick ratings and DELETE clears it', async () => {
        const user = await makeUser();
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        const rate = (likes: string): Promise<Response> =>
            call(ratingPost, `/j/UserItems/${itemId}/Rating?likes=${likes}`, {
                method: 'POST',
                token: user.token,
                params: { itemId },
            });

        const up = await rate('true');
        expect(up.status).toBe(200);
        expect(await up.json()).toMatchObject({ Likes: true, Rating: 8, ItemId: itemId });
        const [row] = await sql<{ rating: number; rating_style: string }[]>`
            SELECT rating, rating_style FROM user_ratings WHERE user_id = ${user.id} AND media_id = ${itemId}`;
        expect(row).toEqual({ rating: 8, rating_style: 'quick' });

        expect(await (await rate('False')).json()).toMatchObject({ Likes: false, Rating: 2 });

        const cleared = await call(ratingDelete, `/j/UserItems/${itemId}/Rating`, {
            method: 'DELETE',
            token: user.token,
            params: { itemId },
        });
        expect(await cleared.json()).toMatchObject({ Likes: null, Rating: null });
        expect(
            await sql`SELECT 1 FROM user_ratings WHERE user_id = ${user.id} AND media_id = ${itemId}`,
        ).toHaveLength(0);
    });

    it('works on the legacy /Users/{userId}/Items/{id}/Rating path', async () => {
        const user = await makeUser();
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        const res = await call(
            legacyRatingPost,
            `/j/Users/${user.id}/Items/${itemId}/Rating?Likes=true`,
            {
                method: 'POST',
                token: user.token,
                params: { userId: user.id, itemId },
            },
        );
        expect(await res.json()).toMatchObject({ Likes: true });
    });

    it('rejects a missing likes, and 404s an item the user may not see', async () => {
        const kid = await makeUser({ maxAgeRating: 12 });
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        const adult = await seedAdultMovie();
        expect(
            (
                await call(ratingPost, `/j/UserItems/${itemId}/Rating`, {
                    method: 'POST',
                    token: kid.token,
                    params: { itemId },
                })
            ).status,
        ).toBe(400);
        for (const id of [adult, randomUUID()]) {
            const res = await call(ratingPost, `/j/UserItems/${id}/Rating?likes=true`, {
                method: 'POST',
                token: kid.token,
                params: { itemId: id },
            });
            expect(res.status).toBe(404);
        }
        expect(await sql`SELECT 1 FROM user_ratings WHERE user_id = ${kid.id}`).toHaveLength(0);
    });

    it('leaves a type that cannot be rated unrated', async () => {
        const user = await makeUser();
        const { itemId } = await seedMusicTrack(sql);
        const res = await call(ratingPost, `/j/UserItems/${itemId}/Rating?likes=true`, {
            method: 'POST',
            token: user.token,
            params: { itemId },
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ Likes: null, Rating: null });
    });
});

describe.runIf(RUN)('/j QuickConnect/Authorize', () => {
    async function initiate(): Promise<{ Code: string; Secret: string }> {
        const res = await call(qcInitiatePost, '/j/QuickConnect/Initiate', { method: 'POST' });
        return (await res.json()) as { Code: string; Secret: string };
    }

    it('approves a pending code for the signed-in user', async () => {
        const user = await makeUser();
        const { Code, Secret } = await initiate();
        const res = await call(qcAuthorizePost, `/j/QuickConnect/Authorize?code=${Code}`, {
            method: 'POST',
            token: user.token,
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toBe(true);

        const state = await call(qcConnectGet, `/j/QuickConnect/Connect?Secret=${Secret}`);
        expect(await state.json()).toMatchObject({ Authenticated: true, Code });

        const again = await call(qcAuthorizePost, `/j/QuickConnect/Authorize?Code=${Code}`, {
            method: 'POST',
            token: user.token,
        });
        expect(again.status).toBe(400);
    });

    it('400 without a code, 404 for an unknown one, 403 for another user', async () => {
        const user = await makeUser();
        const post = (query: string): Promise<Response> =>
            call(qcAuthorizePost, `/j/QuickConnect/Authorize${query}`, {
                method: 'POST',
                token: user.token,
            });
        expect((await post('')).status).toBe(400);
        expect((await post('?code=000000')).status).toBe(404);
        expect((await post('?code=abc')).status).toBe(404);

        const { Code, Secret } = await initiate();
        expect((await post(`?code=${Code}&userId=${randomUUID().replace(/-/g, '')}`)).status).toBe(
            403,
        );
        expect((await post(`?code=${Code}&userId=${user.id.replace(/-/g, '')}`)).status).toBe(200);
        const state = await call(qcConnectGet, `/j/QuickConnect/Connect?Secret=${Secret}`);
        expect(await state.json()).toMatchObject({ Authenticated: true });
    });
});

describe.runIf(RUN)('/j QuickConnect/Authorize — budget and API keys', () => {
    it('allows 10 guesses a minute per user; the 11th is 429 even from a new address', async () => {
        const user = await makeUser();
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++) {
            const res = await call(qcAuthorizePost, '/j/QuickConnect/Authorize?code=000000', {
                method: 'POST',
                token: user.token,
                ip: `198.51.100.${i + 1}`,
            });
            statuses.push(res.status);
        }
        expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
        expect(statuses[10]).toBe(429);
    });

    it('refuses an API key (PAT) with 403 and leaves the code pending', async () => {
        const user = await makeUser();
        const pat = await mintJfPat(user.id);
        const init = await call(qcInitiatePost, '/j/QuickConnect/Initiate', { method: 'POST' });
        const { Code, Secret } = (await init.json()) as { Code: string; Secret: string };
        const res = await call(qcAuthorizePost, `/j/QuickConnect/Authorize?code=${Code}`, {
            method: 'POST',
            token: pat,
        });
        expect(res.status).toBe(403);
        const state = await call(qcConnectGet, `/j/QuickConnect/Connect?Secret=${Secret}`);
        expect(await state.json()).toMatchObject({ Authenticated: false });
    });
});

describe.runIf(RUN)('/j writes refuse API keys (pat: deny)', () => {
    it('Rating, UserImage and Users/Configuration answer 403 to a PAT and change nothing', async () => {
        const user = await makeUser();
        const pat = await mintJfPat(user.id);
        const itemId = await seedMovieWithArtwork();

        const rating = await call(ratingPost, `/j/UserItems/${itemId}/Rating?likes=true`, {
            method: 'POST',
            token: pat,
            params: { itemId },
        });
        expect(rating.status).toBe(403);

        const image = await sharp({
            create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
        })
            .png()
            .toBuffer();
        const upload = await call(userImagePost, '/j/UserImage', {
            method: 'POST',
            token: pat,
            body: image.toString('base64'),
            contentType: 'image/png',
        });
        expect(upload.status).toBe(403);
        const del = await call(userImageDelete, '/j/UserImage', { method: 'DELETE', token: pat });
        expect(del.status).toBe(403);

        const config = await call(configPost, '/j/Users/Configuration', {
            method: 'POST',
            token: pat,
            contentType: 'application/json',
            body: JSON.stringify({ SubtitleMode: 'None' }),
        });
        expect(config.status).toBe(403);

        const [prefs] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM user_playback_preferences WHERE user_id = ${user.id}`;
        expect(prefs.n).toBe(0);
        const [avatarRow] = await sql<{ has: boolean }[]>`
            SELECT avatar_data IS NOT NULL AS has FROM users WHERE id = ${user.id}`;
        expect(avatarRow.has).toBe(false);
    });
});

describe.runIf(RUN)('/j Users/Password', () => {
    it('is always refused with 403', async () => {
        const user = await makeUser();
        const body = JSON.stringify({ CurrentPw: 'x', NewPw: 'y' });
        const own = await call(passwordPost, '/j/Users/Password', {
            method: 'POST',
            token: user.token,
            body,
            contentType: 'application/json',
        });
        expect(own.status).toBe(403);
        const legacy = await call(legacyPasswordPost, `/j/Users/${user.id}/Password`, {
            method: 'POST',
            token: user.token,
            params: { userId: user.id },
            body,
            contentType: 'application/json',
        });
        expect(legacy.status).toBe(403);
        const other = await call(passwordPost, `/j/Users/Password?userId=${randomUUID()}`, {
            method: 'POST',
            token: user.token,
            body,
            contentType: 'application/json',
        });
        expect(other.status).toBe(403);
        expect(await other.text()).toContain('not allowed');
    });
});

describe.runIf(RUN)('/j UserImage POST/DELETE', () => {
    async function png(): Promise<Buffer> {
        return sharp({
            create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } },
        })
            .png()
            .toBuffer();
    }
    const avatar = async (id: string): Promise<boolean> => {
        const [row] = await sql<{ has: boolean }[]>`
            SELECT avatar_data IS NOT NULL AS has FROM users WHERE id = ${id}`;
        return row.has;
    };

    it('stores a base64 or raw upload and deletes it', async () => {
        const user = await makeUser();
        const image = await png();
        const b64 = await call(userImagePost, '/j/UserImage', {
            method: 'POST',
            token: user.token,
            body: image.toString('base64'),
            contentType: 'image/png',
        });
        expect(b64.status).toBe(204);
        expect(await avatar(user.id)).toBe(true);

        const del = await call(userImageDelete, '/j/UserImage', {
            method: 'DELETE',
            token: user.token,
        });
        expect(del.status).toBe(204);
        expect(await avatar(user.id)).toBe(false);

        const raw = await call(userImagePost, `/j/UserImage?userId=${user.id.replace(/-/g, '')}`, {
            method: 'POST',
            token: user.token,
            body: new Uint8Array(image),
            contentType: 'image/png',
        });
        expect(raw.status).toBe(204);
        expect(await avatar(user.id)).toBe(true);
    });

    it('accepts GIF and WebP uploads', async () => {
        const user = await makeUser();
        const base = sharp({
            create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 200, b: 10 } },
        });
        for (const [buf, type] of [
            [await base.clone().gif().toBuffer(), 'image/gif'],
            [await base.clone().webp().toBuffer(), 'image/webp'],
        ] as const) {
            const res = await call(userImagePost, '/j/UserImage', {
                method: 'POST',
                token: user.token,
                body: buf.toString('base64'),
                contentType: type,
            });
            expect(res.status).toBe(204);
        }
        expect(await avatar(user.id)).toBe(true);
    });

    it('413s an oversize upload (body over the cap, or a decoded image over 2 MB)', async () => {
        const user = await makeUser();
        const huge = await call(userImagePost, '/j/UserImage', {
            method: 'POST',
            token: user.token,
            body: new Uint8Array(3 * 1024 * 1024),
            contentType: 'image/png',
        });
        expect(huge.status).toBe(413);

        // PNG magic + padding: 2 MB + 1 KB raw, within the base64-sized body cap.
        const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const overTwoMb = Buffer.concat([pngMagic, Buffer.alloc(2 * 1024 * 1024 + 1024)]);
        const decodedTooBig = await call(userImagePost, '/j/UserImage', {
            method: 'POST',
            token: user.token,
            body: new Uint8Array(overTwoMb),
            contentType: 'image/png',
        });
        expect(decodedTooBig.status).toBe(413);
        expect(await avatar(user.id)).toBe(false);
    });

    it('400s bytes that only carry an image magic number (spoofed PNG / GIF)', async () => {
        const user = await makeUser();
        const spoofs = [
            Buffer.concat([
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                Buffer.from('<?php echo 1; ?> not really a png'),
            ]),
            Buffer.concat([Buffer.from('GIF89a'), Buffer.from('<script>alert(1)</script>')]),
        ];
        for (const spoof of spoofs) {
            const res = await call(userImagePost, '/j/UserImage', {
                method: 'POST',
                token: user.token,
                body: spoof.toString('base64'),
                contentType: 'image/png',
            });
            expect(res.status).toBe(400);
        }
        expect(await avatar(user.id)).toBe(false);
    });

    it('rejects a non-image and another user', async () => {
        const user = await makeUser();
        const other = await makeUser();
        const bad = await call(userImagePost, '/j/UserImage', {
            method: 'POST',
            token: user.token,
            body: Buffer.from('not an image').toString('base64'),
            contentType: 'image/png',
        });
        expect(bad.status).toBe(400);

        const forOther = await call(userImagePost, `/j/UserImage?userId=${other.id}`, {
            method: 'POST',
            token: user.token,
            body: (await png()).toString('base64'),
            contentType: 'image/png',
        });
        expect(forOther.status).toBe(403);
        const delOther = await call(userImageDelete, `/j/UserImage?userId=${other.id}`, {
            method: 'DELETE',
            token: user.token,
        });
        expect(delOther.status).toBe(403);
        expect(await avatar(other.id)).toBe(false);
    });
});

describe.runIf(RUN)('/j Users/Configuration', () => {
    it('stores the playback subset and /Users/Me reports it back', async () => {
        const user = await makeUser();
        const res = await call(
            configPost,
            `/j/Users/Configuration?userId=${user.id.replace(/-/g, '')}`,
            {
                method: 'POST',
                token: user.token,
                contentType: 'application/json',
                body: JSON.stringify({
                    AudioLanguagePreference: 'ger',
                    SubtitleLanguagePreference: 'eng',
                    SubtitleMode: 'OnlyForced',
                    EnableNextEpisodeAutoPlay: false,
                    OrderedViews: ['x'],
                }),
            },
        );
        expect(res.status).toBe(204);
        const [row] = await sql<
            {
                audio_language: string;
                subtitle_language: string;
                subtitles_enabled: boolean;
                forced_subtitles_enabled: boolean;
                autoplay_next_episode: boolean;
            }[]
        >`SELECT audio_language, subtitle_language, subtitles_enabled, forced_subtitles_enabled,
                 autoplay_next_episode
          FROM user_playback_preferences WHERE user_id = ${user.id}`;
        expect(row).toEqual({
            audio_language: 'de',
            subtitle_language: 'en',
            subtitles_enabled: false,
            forced_subtitles_enabled: true,
            autoplay_next_episode: false,
        });

        const me = (await (await call(meGet, '/j/Users/Me', { token: user.token })).json()) as {
            Configuration: Record<string, unknown>;
        };
        // Reported as ISO 639-2/T ('deu'), the form Jellyfin 10.11+ uses, even
        // though the client posted the bibliographic 'ger'.
        expect(me.Configuration).toMatchObject({
            AudioLanguagePreference: 'deu',
            SubtitleLanguagePreference: 'eng',
            SubtitleMode: 'OnlyForced',
            EnableNextEpisodeAutoPlay: false,
        });

        const legacy = await call(legacyConfigPost, `/j/Users/${user.id}/Configuration`, {
            method: 'POST',
            token: user.token,
            params: { userId: user.id },
            contentType: 'application/json',
            body: JSON.stringify({ SubtitleMode: 'None', AudioLanguagePreference: '' }),
        });
        expect(legacy.status).toBe(204);
        const [after] = await sql<{ audio_language: string | null; forced: boolean }[]>`
            SELECT audio_language, forced_subtitles_enabled AS forced
            FROM user_playback_preferences WHERE user_id = ${user.id}`;
        expect(after).toEqual({ audio_language: null, forced: false });
    });

    it('echoing /Users/Me Configuration back stores nothing for a user without preferences', async () => {
        const user = await makeUser();
        const me = (await (await call(meGet, '/j/Users/Me', { token: user.token })).json()) as {
            Configuration: Record<string, unknown>;
        };
        const res = await call(configPost, '/j/Users/Configuration', {
            method: 'POST',
            token: user.token,
            contentType: 'application/json',
            body: JSON.stringify(me.Configuration),
        });
        expect(res.status).toBe(204);
        const [prefs] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM user_playback_preferences WHERE user_id = ${user.id}`;
        expect(prefs.n).toBe(0);

        // A real change in the same echoed object is stored, and only that field.
        const res2 = await call(configPost, '/j/Users/Configuration', {
            method: 'POST',
            token: user.token,
            contentType: 'application/json',
            body: JSON.stringify({ ...me.Configuration, EnableNextEpisodeAutoPlay: false }),
        });
        expect(res2.status).toBe(204);
        const [row] = await sql<
            { audio_language: string | null; autoplay_next_episode: boolean | null }[]
        >`SELECT audio_language, autoplay_next_episode
          FROM user_playback_preferences WHERE user_id = ${user.id}`;
        expect(row).toEqual({ audio_language: null, autoplay_next_episode: false });
    });

    it('400 for a non-object body, 403 for another user', async () => {
        const user = await makeUser();
        const post = (path: string, body: string): Promise<Response> =>
            call(configPost, path, {
                method: 'POST',
                token: user.token,
                contentType: 'application/json',
                body,
            });
        expect((await post('/j/Users/Configuration', 'not json')).status).toBe(400);
        expect((await post('/j/Users/Configuration', '[]')).status).toBe(400);
        expect((await post(`/j/Users/Configuration?userId=${randomUUID()}`, '{}')).status).toBe(
            403,
        );
    });
});
