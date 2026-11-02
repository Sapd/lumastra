// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit coverage for the pure halves of the rich-notification contract:
 * text composition and the expiry anchor. The parts that need a database and a
 * mounted route (does the generated URL actually resolve? do real bytes come
 * back?) live in `push-rich-notification.integration.test.ts` — asserting on a
 * plausible-looking string in the payload is exactly the test that already let a
 * broken image path ship once.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            ...actual.config,
            get APP_NAME() {
                return 'Lumastra';
            },
        },
    };
});

import {
    composePushContent,
    pushRichUrlExpiresInSeconds,
    PUSH_RICH_URL_TTL_MS,
} from './push-rich-content.js';

const NEW_EPISODE = 'library.new_episode';
const REQUEST_AVAILABLE = 'request.available';

const episodePayload = {
    mediaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    seriesId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    seriesTitle: 'Starhaven',
    episodeTitle: 'Harbor Lantern',
    seasonNumber: 2,
    episodeNumber: 7,
};

describe('composePushContent', () => {
    it('names the series and zero-pads the episode code', () => {
        expect(composePushContent(NEW_EPISODE, episodePayload, 'en')).toEqual({
            title: 'Starhaven',
            body: 'S02E07 · Harbor Lantern is available',
        });
    });

    it('renders the same notification in German', () => {
        const de = composePushContent(NEW_EPISODE, episodePayload, 'de');
        expect(de.title).toBe('Starhaven');
        expect(de.body).toBe('S02E07 · Harbor Lantern ist verfügbar');
    });

    it('drops the episode title when the payload has none', () => {
        const { episodeTitle: _drop, ...untitled } = episodePayload;
        expect(composePushContent(NEW_EPISODE, untitled, 'en').body).toBe('S02E07 is available');
    });

    it('drops a release file name stored as the episode title', () => {
        const release = {
            ...episodePayload,
            episodeTitle:
                'Starhaven (2022)   S02E07   Harbor Lantern [WEBDL 1080p][8bit][H264][AAC 2.0] Grp',
        };
        expect(composePushContent(NEW_EPISODE, release, 'en').body).toBe('S02E07 is available');
    });

    it('keeps the series name when the numbering is missing', () => {
        const special = { ...episodePayload, seasonNumber: null, episodeNumber: null };
        expect(composePushContent(NEW_EPISODE, special, 'en')).toEqual({
            title: 'Starhaven',
            body: 'New episode available',
        });
    });

    it('titles a request notification with the media title and year', () => {
        expect(composePushContent(REQUEST_AVAILABLE, { title: 'Dawn', year: 2021 }, 'en')).toEqual({
            title: 'Dawn (2021)',
            body: 'Your request is ready to watch',
        });
    });

    it('omits the year when the payload has none', () => {
        expect(composePushContent(REQUEST_AVAILABLE, { title: 'Dawn' }, 'de').title).toBe('Dawn');
    });

    it('falls back to the content-free alert when the payload names nothing', () => {
        // Identical to what iOS shows if the extension times out — a thin
        // payload must degrade to "no change", never to a half-built banner.
        expect(composePushContent(NEW_EPISODE, {}, 'de')).toEqual({
            title: 'Lumastra',
            body: 'Neue Folge verfügbar',
        });
        expect(composePushContent(NEW_EPISODE, null, 'en').title).toBe('Lumastra');
    });
});

describe('pushRichUrlExpiresInSeconds', () => {
    it('is six hours for a notification created now', () => {
        const now = Date.now();
        expect(pushRichUrlExpiresInSeconds(new Date(now), now)).toBe(PUSH_RICH_URL_TTL_MS / 1000);
    });

    it('outlives the four-hour APNs storage window', () => {
        // The whole point: APNs may hold a push for 4h, so a URL minted at send
        // time must still be valid when a phone that was switched off wakes up.
        const now = Date.now();
        const remaining = pushRichUrlExpiresInSeconds(new Date(now), now);
        expect(remaining).toBeGreaterThan(4 * 60 * 60);
    });

    it('is anchored to created_at, so a retry cannot extend it', () => {
        const created = new Date('2026-08-11T10:00:00Z');
        const firstAttempt = new Date('2026-08-11T10:00:00Z').getTime();
        const lateRetry = new Date('2026-08-11T10:20:00Z').getTime();

        const first = pushRichUrlExpiresInSeconds(created, firstAttempt);
        const retry = pushRichUrlExpiresInSeconds(created, lateRetry);

        expect(first - retry).toBe(20 * 60);
    });

    it('goes non-positive once the window has closed', () => {
        const created = new Date(Date.now() - PUSH_RICH_URL_TTL_MS - 1000);
        expect(pushRichUrlExpiresInSeconds(created)).toBeLessThanOrEqual(0);
    });
});
