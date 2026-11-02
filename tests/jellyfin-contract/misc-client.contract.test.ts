// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * Contract suite: the small client endpoints (time sync, localization lists,
 * branding, item image list, years, thumbs rating, fallback fonts, auth
 * providers), through the real /j route handlers over real PG + Valkey.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { callAndCheck, jfEvent, mintJfSession } from './harness';
import { seedMovieEmbeddedSubs } from './seed';
import { GET as utcTimeGet } from '../../src/routes/(proprietary)/j/GetUtcTime/+server';
import { GET as culturesGet } from '../../src/routes/(proprietary)/j/Localization/Cultures/+server';
import { GET as countriesGet } from '../../src/routes/(proprietary)/j/Localization/Countries/+server';
import { GET as ratingsGet } from '../../src/routes/(proprietary)/j/Localization/ParentalRatings/+server';
import { GET as optionsGet } from '../../src/routes/(proprietary)/j/Localization/Options/+server';
import { GET as brandingGet } from '../../src/routes/(proprietary)/j/Branding/Configuration/+server';
import { GET as itemImagesGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/Images/+server';
import { GET as yearsGet } from '../../src/routes/(proprietary)/j/Years/+server';
import { GET as yearGet } from '../../src/routes/(proprietary)/j/Years/[year]/+server';
import {
    POST as ratingPost,
    DELETE as ratingDelete,
} from '../../src/routes/(proprietary)/j/UserItems/[itemId]/Rating/+server';
import { GET as fontsGet } from '../../src/routes/(proprietary)/j/FallbackFont/Fonts/+server';
import { GET as authProvidersGet } from '../../src/routes/(proprietary)/j/Auth/Providers/+server';
import { GET as resetProvidersGet } from '../../src/routes/(proprietary)/j/Auth/PasswordResetProviders/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c0d6';
let sql: postgres.Sql;
let token: string;

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
});
afterAll(async () => {
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    await ensureTestUser(sql, USER_ID);
    // Admin, for the admin-only /Auth/* provider lists.
    await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${USER_ID}`;
    const [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
});

const get = (path: string, params: Record<string, string> = {}): ReturnType<typeof jfEvent> =>
    jfEvent({ method: 'GET', path, token, params });

describe('/j misc client contract', () => {
    it('GetUtcTime', async () => {
        await callAndCheck('get-utc-time', 'UtcTimeResponse', utcTimeGet, get('/j/GetUtcTime'));
    });

    it('Localization lists', async () => {
        await callAndCheck(
            'localization-cultures',
            'List<CultureDto>',
            culturesGet,
            get('/j/Localization/Cultures'),
        );
        await callAndCheck(
            'localization-countries',
            'List<CountryInfo>',
            countriesGet,
            get('/j/Localization/Countries'),
        );
        await callAndCheck(
            'localization-parental-ratings',
            'List<ParentalRating>',
            ratingsGet,
            get('/j/Localization/ParentalRatings'),
        );
        await callAndCheck(
            'localization-options',
            'List<LocalizationOption>',
            optionsGet,
            get('/j/Localization/Options'),
        );
    });

    it('Branding/Configuration sends LoginDisclaimer, CustomCss, SplashscreenEnabled', async () => {
        const body = await callAndCheck(
            'branding-configuration',
            'BrandingOptionsDto',
            brandingGet,
            get('/j/Branding/Configuration'),
        );
        expect(body).toEqual({ LoginDisclaimer: '', CustomCss: '', SplashscreenEnabled: false });
    });

    it('Items/{id}/Images', async () => {
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
                  VALUES (${itemId}, 'tmdb', ${sql.json({ poster_path: '/p.jpg', backdrop_path: '/b.jpg' })})`;
        const body = (await callAndCheck(
            'items-images',
            'List<ImageInfo>',
            itemImagesGet,
            get(`/j/Items/${itemId}/Images`, { itemId }),
        )) as unknown[];
        expect(body.length).toBeGreaterThanOrEqual(2);
    });

    it('Years and Years/{year}', async () => {
        await seedMovieEmbeddedSubs(sql);
        const list = (await callAndCheck(
            'years',
            'BaseItemDtoQueryResult',
            yearsGet,
            get('/j/Years?SortBy=SortName&SortOrder=Ascending&Recursive=true'),
        )) as { TotalRecordCount: number };
        expect(list.TotalRecordCount).toBe(1);
        await callAndCheck('year', 'BaseItemDto', yearGet, get('/j/Years/2020', { year: '2020' }));
    });

    it('UserItems/{id}/Rating POST and DELETE', async () => {
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        const liked = await callAndCheck(
            'useritems-rating-post',
            'UserItemDataDto',
            ratingPost,
            jfEvent({
                method: 'POST',
                path: `/j/UserItems/${itemId}/Rating?likes=true`,
                token,
                params: { itemId },
            }),
        );
        expect(liked).toMatchObject({ Likes: true, Rating: 8 });
        const ev = jfEvent({
            method: 'POST',
            path: `/j/UserItems/${itemId}/Rating`,
            token,
            params: { itemId },
        });
        // jfEvent builds GET/POST only; DELETE needs its own Request.
        const del = { ...ev, request: new Request(ev.request, { method: 'DELETE' }) };
        const cleared = await callAndCheck(
            'useritems-rating-delete',
            'UserItemDataDto',
            ratingDelete,
            del,
        );
        expect(cleared).toMatchObject({ Likes: null, Rating: null });
    });

    it('FallbackFont/Fonts and the Auth provider lists', async () => {
        await callAndCheck(
            'fallback-fonts',
            'List<FontFile>',
            fontsGet,
            get('/j/FallbackFont/Fonts'),
        );
        await callAndCheck(
            'auth-providers',
            'List<NameIdPair>',
            authProvidersGet,
            get('/j/Auth/Providers'),
        );
        await callAndCheck(
            'auth-password-reset-providers',
            'List<NameIdPair>',
            resetProvidersGet,
            get('/j/Auth/PasswordResetProviders'),
        );
    });
});
