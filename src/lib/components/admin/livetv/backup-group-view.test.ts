// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { BackupGroupAdmin, BackupGroupMember } from '$lib/schemas/livetv.js';
import {
    DEFAULT_GROUP_FILTER,
    filterGroups,
    filterOptions,
    groupFacts,
    shownFeedId,
    onAirFeedId,
    type GroupFilter,
} from './backup-group-view.js';

function feed(id: string, extra: Partial<BackupGroupMember> = {}): BackupGroupMember {
    return {
        id,
        name: id,
        isVisible: true,
        categoryId: 'news',
        categoryName: 'News',
        countryCode: 'DE',
        ...extra,
    };
}

function group(id: string, channels: BackupGroupMember[], primary?: string): BackupGroupAdmin {
    return { id, name: id, primaryChannelId: primary ?? channels[0]?.id, channels };
}

const groups = [
    group('Nordwelle', [feed('nordwelle-hd'), feed('nordwelle-sd')]),
    group(
        'Siebenstern',
        [
            feed('pro-fhd', { isVisible: false, categoryId: 'movies', categoryName: 'Movies' }),
            feed('pro-plus', { categoryId: 'movies', categoryName: 'Movies' }),
            feed('pro-raw', { categoryId: 'movies', categoryName: 'Movies' }),
        ],
        'pro-fhd',
    ),
    group('OSK 1', [feed('osk-de'), feed('osk-at', { countryCode: 'AT' })]),
    group('Off', [feed('off-1', { isVisible: false }), feed('off-2', { isVisible: false })]),
];
const facts = new Map(groups.map((g) => [g.id, groupFacts(g)]));
const names = (filter: Partial<GroupFilter>): string[] =>
    filterGroups(groups, facts, { ...DEFAULT_GROUP_FILTER, ...filter }).map((g) => g.name);

describe('groupFacts', () => {
    it('flags a hidden primary while another feed is visible', () => {
        expect(facts.get('Siebenstern')?.problems).toEqual(['primary-hidden']);
        expect(facts.get('Siebenstern')?.visibleCount).toBe(2);
        expect(facts.get('Siebenstern')?.categoryName).toBe('Movies');
    });

    it('flags feeds of different countries', () => {
        expect(facts.get('OSK 1')?.problems).toEqual(['mixed-countries']);
        expect(facts.get('OSK 1')?.countries).toEqual(['AT', 'DE']);
    });

    it('does not call an all-hidden group a hidden-primary problem', () => {
        expect(facts.get('Off')?.problems).toEqual([]);
        expect(facts.get('Off')?.visibleCount).toBe(0);
    });

    it('flags a group without a primary and one spread over categories', () => {
        const g = group('Mixed', [feed('a'), feed('b', { categoryId: 'sport' })], 'gone');
        expect(groupFacts(g).problems).toEqual(['no-primary', 'mixed-categories']);
    });
});

describe('filterGroups', () => {
    it('sorts by name, numbers in order', () => {
        expect(names({})).toEqual(['Nordwelle', 'Off', 'OSK 1', 'Siebenstern']);
    });

    it('searches group and feed names', () => {
        expect(names({ query: 'PRO-PL' })).toEqual(['Siebenstern']);
        expect(names({ query: 'nordwelle' })).toEqual(['Nordwelle']);
    });

    it('filters by category, country and air state', () => {
        expect(names({ categoryId: 'movies' })).toEqual(['Siebenstern']);
        expect(names({ country: 'AT' })).toEqual(['OSK 1']);
        expect(names({ air: 'off-air' })).toEqual(['Off']);
        expect(names({ air: 'on-air' })).not.toContain('Off');
    });

    it('lists only groups with problems', () => {
        expect(names({ problemsOnly: true })).toEqual(['OSK 1', 'Siebenstern']);
    });

    it('sorts by size and by category', () => {
        expect(names({ sort: 'size' })[0]).toBe('Siebenstern');
        expect(names({ sort: 'category' })).toEqual(['Siebenstern', 'Nordwelle', 'Off', 'OSK 1']);
    });
});

describe('filterOptions', () => {
    it('counts feeds per category and country, ungrouped ones included', () => {
        const { categories, countries } = filterOptions(
            groups,
            [feed('solo', { categoryId: undefined, categoryName: undefined, countryCode: 'US' })],
            'Uncategorized',
        );
        expect(categories).toEqual([
            { value: 'movies', label: 'Movies', count: 3 },
            { value: 'news', label: 'News', count: 6 },
            { value: 'uncategorized', label: 'Uncategorized', count: 1 },
        ]);
        expect(countries.map((c) => `${c.value}:${c.count}`)).toEqual(['AT:1', 'DE:8', 'US:1']);
    });
});

describe('shownFeedId', () => {
    it('is the primary while it is visible', () => {
        expect(shownFeedId(groups[0])).toBe('nordwelle-hd');
    });

    it('is the best visible feed when the primary is hidden: normal before transcoded, then quality', () => {
        const g = group(
            'Orb',
            [
                feed('orb-fhd', { isVisible: false, qualityTier: 'fhd' }),
                feed('orb-trans', { name: 'Orb (Transcoded)', qualityTier: 'uhd' }),
                feed('orb-sd', { qualityTier: 'sd' }),
                feed('orb-hd', { qualityTier: 'hd' }),
            ],
            'orb-fhd',
        );
        expect(shownFeedId(g)).toBe('orb-hd');
        expect(groupFacts(g).shownId).toBe('orb-hd');
    });

    it('is absent when no feed is visible', () => {
        expect(shownFeedId(groups[3])).toBeUndefined();
    });
});

describe('onAirFeedId', () => {
    it('picks the primary when it is a normal feed, hidden or not', () => {
        expect(onAirFeedId(groups[1])).toBe('pro-fhd');
    });

    it('passes over a degraded primary for the best normal feed', () => {
        const g = group(
            'Orb',
            [
                feed('orb-trans', { name: 'Orb (Transcoded)', qualityTier: 'uhd' }),
                feed('orb-sd', { qualityTier: 'sd' }),
                feed('orb-hd', { qualityTier: 'hd' }),
            ],
            'orb-trans',
        );
        expect(onAirFeedId(g)).toBe('orb-hd');
    });
});
