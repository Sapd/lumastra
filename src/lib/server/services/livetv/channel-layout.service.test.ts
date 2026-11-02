// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { matchChannelLayout, type MatchableChannel } from './channel-layout.service.js';
import type { ChannelLayoutEntry } from '$lib/schemas/livetv.js';

function entry(
    baseName: string,
    opts: { epgId?: string | null; country?: string | null; sortOrder?: number } = {},
): ChannelLayoutEntry {
    return {
        match: {
            baseName,
            epgId: opts.epgId ?? null,
            country: opts.country === undefined ? 'de' : opts.country,
        },
        sortOrder: opts.sortOrder ?? 0,
        category: null,
        isVisible: true,
        displayName: null,
    };
}

function chan(
    id: string,
    baseName: string,
    epgId: string | null = null,
    country: string | null = 'de',
): MatchableChannel {
    return { id, baseName, epgId, country };
}

describe('matchChannelLayout', () => {
    it('matches by base name + country and partitions the rest', () => {
        const entries = [entry('ekr sachsen'), entry('kwf')];
        const current = [chan('c1', 'ekr sachsen'), chan('c2', 'sat 4')];

        const r = matchChannelLayout(entries, current);

        expect(r.matched).toEqual([{ channelId: 'c1', entry: entries[0] }]);
        expect(r.exportOnly).toEqual([entries[1]]); // 'kwf' not on the new provider
        expect(r.newOnly).toEqual(['c2']); // 'sat 4' is a new-provider extra
    });

    it('uses EPG id to disambiguate channels sharing base name + country', () => {
        const entries = [entry('nordwelle', { epgId: 'Nordwelle.de' })];
        const current = [
            chan('a', 'nordwelle', 'other.de'),
            chan('b', 'nordwelle', 'Nordwelle.de'),
        ];

        const r = matchChannelLayout(entries, current);

        expect(r.matched[0].channelId).toBe('b');
    });

    it('claims each channel at most once (no double assignment)', () => {
        const entries = [entry('x', { sortOrder: 0 }), entry('x', { sortOrder: 1 })];
        const current = [chan('only', 'x')];

        const r = matchChannelLayout(entries, current);

        expect(r.matched).toHaveLength(1);
        expect(r.matched[0].channelId).toBe('only');
        expect(r.exportOnly).toHaveLength(1); // the second 'x' entry can't claim anything
    });

    it('does not cross-match across country codes (regional variants stay separate)', () => {
        const entries = [entry('osk 1', { country: 'at' })];
        const current = [chan('de1', 'osk 1', null, 'de')];

        const r = matchChannelLayout(entries, current);

        expect(r.matched).toHaveLength(0);
        expect(r.exportOnly).toHaveLength(1);
        expect(r.newOnly).toEqual(['de1']);
    });

    it('treats null country consistently on both sides', () => {
        const entries = [entry('global news', { country: null })];
        const current = [chan('g', 'global news', null, null)];

        const r = matchChannelLayout(entries, current);

        expect(r.matched[0].channelId).toBe('g');
    });
});
