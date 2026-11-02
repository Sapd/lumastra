// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringifySonarrId } from './upcoming.js';

describe('stringifySonarrId', () => {
    it('stringifies a raw Sonarr numeric series ID', () => {
        // Sonarr's calendar API returns `series.id` as a number (see
        // transformSonarrToMediaItem in transformers.ts + `sonarrSeriesId?: number`
        // in server/types.ts). RecommendedMediaRefSchema.ids is z.record(string,
        // string) — a raw number here fails strict client decoding (tvOS).
        expect(stringifySonarrId(456)).toBe('456');
    });

    it('passes through an already-stringified ID unchanged', () => {
        expect(stringifySonarrId('456')).toBe('456');
    });

    it('returns empty string for null/undefined', () => {
        expect(stringifySonarrId(undefined)).toBe('');
        expect(stringifySonarrId(null)).toBe('');
    });
});

const { mockApplyOverlay } = vi.hoisted(() => ({
    mockApplyOverlay: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/utils/translation-overlay.js', () => ({
    applyTranslationOverlay: mockApplyOverlay,
}));

describe('overlayUpcomingItems', () => {
    beforeEach(() => {
        mockApplyOverlay.mockClear();
    });

    // Loaded after the vi.mock above so the dynamic `import('$lib/server/utils/
    // translation-overlay.js')` inside overlayUpcomingItems resolves to the mock.
    async function loadOverlay() {
        const mod = await import('./upcoming.js');
        return mod.overlayUpcomingItems;
    }

    it('no-ops (no DB call) when langs has neither titleLang nor textLang', async () => {
        const overlayUpcomingItems = await loadOverlay();
        await overlayUpcomingItems(
            {} as never,
            [
                {
                    id: 'tmdb:1:series',
                    catalogId: null,
                    type: 'episode',
                    title: 'X',
                    ids: {},
                    images: {},
                },
            ],
            { titleLang: null, textLang: null },
        );
        expect(mockApplyOverlay).not.toHaveBeenCalled();
    });

    it('no-ops when items is empty', async () => {
        const overlayUpcomingItems = await loadOverlay();
        await overlayUpcomingItems({} as never, [], { titleLang: 'de', textLang: null });
        expect(mockApplyOverlay).not.toHaveBeenCalled();
    });

    it('no-ops when langs is undefined (buildAccessContext never resolved it)', async () => {
        const overlayUpcomingItems = await loadOverlay();
        await overlayUpcomingItems(
            {} as never,
            [
                {
                    id: 'tmdb:1:series',
                    catalogId: null,
                    type: 'episode',
                    title: 'X',
                    ids: {},
                    images: {},
                },
            ],
            undefined,
        );
        expect(mockApplyOverlay).not.toHaveBeenCalled();
    });

    it('wires a UUID-guarded id accessor and a setTitle setter into applyTranslationOverlay', async () => {
        const overlayUpcomingItems = await loadOverlay();
        const items = [
            {
                id: '123e4567-e89b-12d3-a456-426614174000',
                catalogId: '123e4567-e89b-12d3-a456-426614174000',
                type: 'episode',
                title: 'Old Title',
                ids: {},
                images: {},
            },
        ];
        await overlayUpcomingItems({} as never, items as never, {
            titleLang: 'de',
            textLang: null,
        });

        expect(mockApplyOverlay).toHaveBeenCalledTimes(1);
        const [, passedItems, langs, opts] = mockApplyOverlay.mock.calls[0];
        expect(passedItems).toBe(items);
        expect(langs).toEqual({ titleLang: 'de', textLang: null });

        // Real internal UUID resolves through the accessor...
        expect(opts.id(items[0])).toBe('123e4567-e89b-12d3-a456-426614174000');
        opts.setTitle(items[0], 'Neuer Titel');
        expect(items[0].title).toBe('Neuer Titel');
    });

    it('id accessor returns null for the sonarr:<id>:series composite fallback (not a real UUID)', async () => {
        const overlayUpcomingItems = await loadOverlay();
        const items = [
            {
                id: 'tmdb:456:series',
                catalogId: null,
                type: 'episode',
                title: 'Old',
                ids: {},
                images: {},
            },
        ];
        await overlayUpcomingItems({} as never, items as never, {
            titleLang: 'de',
            textLang: null,
        });

        const opts = mockApplyOverlay.mock.calls.at(-1)![3];
        expect(opts.id(items[0])).toBeNull();
    });
});

describe('upcoming calendar continuation query', () => {
    it('declares offset on the parent endpoint so calendar pages can be requested', async () => {
        const { def } = await import('./upcoming.js');
        expect(
            def.request!.query.parse({ view: 'calendar', offset: '20', limit: '10' }),
        ).toMatchObject({ view: 'calendar', offset: 20, limit: 10 });
        expect(def.request!.query.safeParse({ offset: '-1' }).success).toBe(false);
        expect(def.docs?.GET?.query).toBeDefined();
    });
});
