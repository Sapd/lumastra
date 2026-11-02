// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit coverage for the shared hero/Continue-Watching metadata-language
 * overlay — the fix that stops the home hero, CW carousel, and Active Streams
 * widget from showing original-language titles to a viewer who selected another
 * language (while the media modal already localized them).
 */

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { heroLangCacheToken, overlayHeroMediaItems } from './hero-item-translation.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

/**
 * Minimal postgres tag mock: `getTranslationMapForItems` awaits a single
 * `sql\`…\`` tagged call and expects an array of translation rows. We ignore the
 * interpolated query and return whatever rows the test queued.
 */
function mockSql(rows: Record<string, unknown>[]): { sql: postgres.Sql; calls: () => number } {
    let calls = 0;
    const fn = (() => {
        calls++;
        return Promise.resolve(rows);
    }) as unknown as postgres.Sql;
    return { sql: fn, calls: () => calls };
}

describe('heroLangCacheToken', () => {
    it('is empty when no language resolves (feature off / primary)', () => {
        expect(heroLangCacheToken({ titleLang: null, textLang: null })).toBe('');
    });

    it('encodes both title and text language', () => {
        expect(heroLangCacheToken({ titleLang: 'de', textLang: 'de' })).toBe(':l:de.de');
    });

    it('encodes a title-only overlay', () => {
        expect(heroLangCacheToken({ titleLang: 'de', textLang: null })).toBe(':l:de.');
    });
});

describe('overlayHeroMediaItems', () => {
    it('is a zero-query no-op when neither language resolves', async () => {
        const { sql, calls } = mockSql([]);
        const items = [{ id: UUID_A, title: 'Original', overview: 'orig' }];
        await overlayHeroMediaItems(sql, items, { titleLang: null, textLang: null });
        expect(calls()).toBe(0);
        expect(items[0].title).toBe('Original');
    });

    it('is a zero-query no-op for an empty list', async () => {
        const { sql, calls } = mockSql([]);
        await overlayHeroMediaItems(sql, [], { titleLang: 'de', textLang: 'de' });
        expect(calls()).toBe(0);
    });

    it('swaps title + overview for a UUID-keyed item', async () => {
        const { sql } = mockSql([
            { media_id: UUID_A, title: 'Der Titel', overview: 'Die Beschreibung', tagline: null },
        ]);
        const items = [{ id: UUID_A, title: 'The Title', overview: 'The description' }];
        await overlayHeroMediaItems(sql, items, { titleLang: 'de', textLang: 'de' });
        expect(items[0].title).toBe('Der Titel');
        expect(items[0].overview).toBe('Die Beschreibung');
    });

    it('keys on externalIds.internal when there is no top-level id (movies/series fallback rows)', async () => {
        const { sql } = mockSql([
            { media_id: UUID_A, title: 'Der Titel', overview: 'Die Beschreibung', tagline: null },
        ]);
        const items = [
            { externalIds: { internal: UUID_A }, title: 'The Title', overview: 'The description' },
        ];
        await overlayHeroMediaItems(sql, items, { titleLang: 'de', textLang: 'de' });
        expect(items[0].title).toBe('Der Titel');
        expect(items[0].overview).toBe('Die Beschreibung');
    });

    it('leaves non-UUID ids untouched (synthetic / Sonarr new-episode rows)', async () => {
        // The lookup returns nothing for the bogus id; the guard also drops it so
        // it is never even queried. Either way, the original text survives.
        const { sql } = mockSql([]);
        const items = [{ id: 'new-42-S1E1', title: 'The Title', overview: 'The description' }];
        await overlayHeroMediaItems(sql, items, { titleLang: 'de', textLang: 'de' });
        expect(items[0].title).toBe('The Title');
        expect(items[0].overview).toBe('The description');
    });

    // ── Parent-series name (pass 2) ──────────────────────────────────────────
    //
    // An episode item carries BOTH its own title (episode name, keyed by the
    // episode's media_id) and `seriesName` (the parent series' title, a
    // media_items row of its own keyed by the SERIES id). Translating only the
    // former left the hero H1 in the primary language — `hero-first-slide.ts`
    // renders `seriesName ?? title` as the headline — while the subtitle
    // underneath rendered translated, i.e. a visibly mixed-language hero.

    it('translates seriesName from the SERIES id, not the episode id', async () => {
        const { sql } = mockSql([
            { media_id: UUID_A, title: 'Die Folge', overview: 'Folgentext', tagline: null },
            { media_id: UUID_B, title: 'Die Serie', overview: 'Serientext', tagline: null },
        ]);
        const items = [
            {
                id: UUID_A,
                seriesInternalId: UUID_B,
                title: 'The Episode',
                seriesName: 'The Series',
                overview: 'Episode text',
            },
        ];
        await overlayHeroMediaItems(sql, items, { titleLang: 'de', textLang: 'de' });
        expect(items[0].title).toBe('Die Folge');
        expect(items[0].seriesName).toBe('Die Serie');
        // The series' OWN overview must not clobber the episode synopsis.
        expect(items[0].overview).toBe('Folgentext');
    });

    it('accepts a UUID in `seriesId` (the SSR ContinueWatchingItem shape)', async () => {
        // `seriesId` is the internal series UUID in section-builder's shape but
        // the JELLYFIN id in the API mappers — the accessor is UUID-guarded so
        // it reads the right one without the caller having to know which.
        const { sql } = mockSql([
            { media_id: UUID_B, title: 'Die Serie', overview: 'Serientext', tagline: null },
        ]);
        const items = [{ id: 'not-a-uuid', seriesId: UUID_B, seriesName: 'The Series' }];
        await overlayHeroMediaItems(sql, items, { titleLang: 'de', textLang: 'de' });
        expect(items[0].seriesName).toBe('Die Serie');
    });

    it('ignores a non-UUID seriesId (Jellyfin id from the API mappers)', async () => {
        const { sql } = mockSql([]);
        const items = [{ id: UUID_A, seriesId: 'a1b2c3d4e5f6', seriesName: 'The Series' }];
        await overlayHeroMediaItems(sql, items, { titleLang: 'de', textLang: 'de' });
        expect(items[0].seriesName).toBe('The Series');
    });

    it('leaves seriesName alone for movie rows (no series id at all)', async () => {
        const { sql } = mockSql([
            { media_id: UUID_A, title: 'Der Film', overview: 'Filmtext', tagline: null },
        ]);
        const items = [{ id: UUID_A, title: 'The Movie' }];
        await overlayHeroMediaItems(sql, items, { titleLang: 'de', textLang: 'de' });
        expect(items[0].title).toBe('Der Film');
        expect('seriesName' in items[0]).toBe(false);
    });

    it('never throws when the translation lookup fails (serves primary language)', async () => {
        const throwingSql = vi.fn(() =>
            Promise.reject(new Error('db down')),
        ) as unknown as postgres.Sql;
        const items = [{ id: UUID_B, title: 'The Title', overview: 'The description' }];
        await expect(
            overlayHeroMediaItems(throwingSql, items, { titleLang: 'de', textLang: 'de' }),
        ).resolves.toBeUndefined();
        expect(items[0].title).toBe('The Title');
    });
});
