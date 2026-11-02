// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    foldWatchParties,
    formatPartyDrift,
    type PartyGroupableRow,
    type WatchPartyTag,
} from './watch-party-groups';

function tag(overrides: Partial<WatchPartyTag> = {}): WatchPartyTag {
    return {
        groupId: 'g1',
        visibility: 'listed',
        isHost: false,
        host: {
            userId: '11111111-1111-4111-8111-111111111111',
            displayName: 'anna',
            images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
        },
        participantCount: 3,
        viewerIsParticipant: false,
        syncState: 'synced',
        ...overrides,
    };
}

const row = (username: string, watchParty?: WatchPartyTag): PartyGroupableRow => ({
    username,
    watchParty,
});

describe('foldWatchParties', () => {
    it('folds a party into one card at its first position, host as representative', () => {
        const groups = [
            { key: 'a', session: row('ben', tag({ driftSeconds: 0.4 })) },
            { key: 'b', session: row('solo') },
            { key: 'c', session: row('anna', tag({ isHost: true, code: 'X-1' })) },
            { key: 'd', session: row('carl', tag({ isStalled: true })) },
        ];
        const out = foldWatchParties(groups);
        expect(out.map((g) => g.key)).toEqual(['party::g1', 'b']);
        const party = out[0];
        expect(party.session.username).toBe('anna');
        expect(party.party?.tag.code).toBe('X-1');
        expect(party.rows).toHaveLength(3);
        expect(party.party?.members.map((mb) => mb.displayName)).toEqual(['anna', 'ben', 'carl']);
        expect(party.party?.members[2].isStalled).toBe(true);
    });

    it('keeps two different parties apart', () => {
        const out = foldWatchParties([
            { key: 'a', session: row('ben', tag({ groupId: 'g1' })) },
            { key: 'b', session: row('zoe', tag({ groupId: 'g2' })) },
        ]);
        expect(out.map((g) => g.key)).toEqual(['party::g1', 'party::g2']);
    });

    it('leaves ordinary streams (including a double stream) as separate cards', () => {
        const out = foldWatchParties([
            { key: 'a', session: row('ben') },
            { key: 'b', session: row('ben') },
        ]);
        expect(out).toHaveLength(2);
        expect(out.every((g) => g.party === undefined)).toBe(true);
    });
});

describe('formatPartyDrift', () => {
    it.each([
        [0.4, '+0.4s'],
        [-1.23, '−1.2s'],
        [0.02, '±0.0s'],
        [undefined, '—'],
    ])('%s → %s', (input, expected) => {
        expect(formatPartyDrift(input)).toBe(expected);
    });
});
