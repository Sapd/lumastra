// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

describe('media count labels', () => {
    it.each([0, 1, 2])('uses the right English and German plurals for %i', (count) => {
        expect(m.admin_media_entries_count({ count }, { locale: 'en' })).toBe(
            `${count} ${count === 1 ? 'entry' : 'entries'}`,
        );
        expect(m.admin_media_entries_count({ count }, { locale: 'de' })).toBe(
            `${count} ${count === 1 ? 'Eintrag' : 'Einträge'}`,
        );
        expect(
            m.media_sync_synced_counts({ seasons: count, episodes: count }, { locale: 'en' }),
        ).toBe(
            `Refreshed ${count} ${count === 1 ? 'season' : 'seasons'} and ${count} ${count === 1 ? 'episode' : 'episodes'}`,
        );
        expect(
            m.media_sync_synced_counts({ seasons: count, episodes: count }, { locale: 'de' }),
        ).toBe(
            `Aktualisiert: ${count} ${count === 1 ? 'Staffel' : 'Staffeln'} und ${count} ${count === 1 ? 'Episode' : 'Episoden'}`,
        );
        expect(m.album_merge_tracks({ count, total: count }, { locale: 'en' })).toBe(
            `${count} ${count === 1 ? 'track moves' : 'tracks move'}; ${count} ${count === 1 ? 'track' : 'tracks'} in the resulting album.`,
        );
    });
    it('pluralizes the two counts independently', () => {
        expect(m.media_sync_synced_counts({ seasons: 1, episodes: 2 }, { locale: 'en' })).toBe(
            'Refreshed 1 season and 2 episodes',
        );
        expect(m.album_merge_tracks({ count: 2, total: 1 }, { locale: 'en' })).toBe(
            '2 tracks move; 1 track in the resulting album.',
        );
    });
});
