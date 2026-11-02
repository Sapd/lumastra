// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildPublicAuthor } from '$lib/shared/public-author';

import { describe, it, expect } from 'vitest';
import {
    annotateStreamsWithParties,
    computePartySyncState,
    computeClientOffsets,
    partyGroupId,
    type PartyStreamSnapshot,
} from './watch-party-stream-overlay.js';
import type { StreamSession } from '../types.js';

const NOW = 1_000_000;
const ITEM = '11111111-1111-4111-8111-111111111111';

function row(overrides: Partial<StreamSession>): StreamSession {
    return {
        __id: `row-${overrides.userId ?? overrides.username}`,
        id: ITEM,
        mediaItemId: ITEM,
        title: 'Movie',
        mediaType: 'movie',
        username: 'someone',
        ...overrides,
    } as StreamSession;
}

function party(overrides: Partial<PartyStreamSnapshot> = {}): PartyStreamSnapshot {
    return {
        code: 'MOVIE-7X3K',
        visibility: 'listed',
        itemId: ITEM,
        host: buildPublicAuthor('28734cb5-e1ca-5fa7-8715-60d1d197645f', 'anna', 'internal'),
        ...{},
        hostClientId: 'c-anna',
        isPlaying: true,
        playbackRate: 1,
        participants: [
            {
                userId: '28734cb5-e1ca-5fa7-8715-60d1d197645f',
                displayName: 'anna',
                clientId: 'c-anna',
            },
            {
                userId: 'c99e93a8-3ccc-5262-9eb5-ec4669118a3d',
                displayName: 'ben',
                clientId: 'c-ben',
            },
        ],
        positions: new Map([
            ['c-anna', { position: 100, timestamp: NOW, isHost: true }],
            ['c-ben', { position: 99.6, timestamp: NOW, isHost: false }],
        ]),
        stalledClientIds: new Set(),
        bufferCheckPending: false,
        ...overrides,
    };
}

const anna = row({ userId: '28734cb5-e1ca-5fa7-8715-60d1d197645f', username: 'anna' });
const ben = row({ userId: 'c99e93a8-3ccc-5262-9eb5-ec4669118a3d', username: 'ben' });
const carl = row({ userId: 'ac62edf1-60b5-5341-bfe0-e409f9a0d39b', username: 'carl' });
const stranger = {
    userId: '10065ab1-1695-55c0-97f5-e4fa042eebff',
    username: 'zoe',
    isAdmin: false,
    publicListingEnabled: true,
};

describe('annotateStreamsWithParties', () => {
    it('tags both participants of a public party with the same group, host, and drift', () => {
        const out = annotateStreamsWithParties([anna, ben, carl], [party()], stranger, NOW);
        expect(out[0].watchParty).toMatchObject({
            groupId: partyGroupId('MOVIE-7X3K'),
            code: 'MOVIE-7X3K',
            isHost: true,
            participantCount: 2,
            viewerIsParticipant: false,
            syncState: 'synced',
        });
        expect(out[0].watchParty?.driftSeconds).toBeUndefined();
        expect(out[1].watchParty).toMatchObject({ isHost: false, driftSeconds: -0.4 });
        expect(out[2].watchParty).toBeUndefined();
    });

    it('never uses the join code as the group id', () => {
        expect(partyGroupId('MOVIE-7X3K')).not.toContain('MOVIE');
    });

    it('hides a private party from a non-participant: rows stay plain', () => {
        const out = annotateStreamsWithParties(
            [anna, ben],
            [party({ visibility: 'unlisted' })],
            stranger,
            NOW,
        );
        expect(out.every((r) => r.watchParty === undefined)).toBe(true);
    });

    it('groups a private party for an admin but withholds the code', () => {
        const out = annotateStreamsWithParties(
            [anna, ben],
            [party({ visibility: 'unlisted' })],
            { ...stranger, isAdmin: true },
            NOW,
        );
        expect(out[0].watchParty?.groupId).toBeDefined();
        expect(out[0].watchParty?.code).toBeUndefined();
    });

    it('gives a private party code to a participant, matched by UUID', () => {
        const out = annotateStreamsWithParties(
            [anna, ben],
            [party({ visibility: 'unlisted' })],
            {
                userId: 'c99e93a8-3ccc-5262-9eb5-ec4669118a3d',
                isAdmin: false,
                publicListingEnabled: true,
            },
            NOW,
        );
        expect(out[0].watchParty).toMatchObject({ code: 'MOVIE-7X3K', viewerIsParticipant: true });
    });

    it('does not grant unlisted-party visibility for a matching username', () => {
        const out = annotateStreamsWithParties(
            [anna, ben],
            [party({ visibility: 'unlisted' })],
            { ...stranger, username: 'ben' },
            NOW,
        );
        expect(out.every((stream) => stream.watchParty === undefined)).toBe(true);
    });

    it('withholds a public party code when the listing is disabled', () => {
        const out = annotateStreamsWithParties(
            [anna, ben],
            [party()],
            { ...stranger, publicListingEnabled: false },
            NOW,
        );
        expect(out[0].watchParty?.groupId).toBeDefined();
        expect(out[0].watchParty?.code).toBeUndefined();
    });

    it('does not tag a participant streaming something else', () => {
        const other = row({
            userId: 'c99e93a8-3ccc-5262-9eb5-ec4669118a3d',
            username: 'ben',
            mediaItemId: 'x',
            id: 'x',
        });
        const out = annotateStreamsWithParties([anna, other], [party()], stranger, NOW);
        expect(out[1].watchParty).toBeUndefined();
    });

    it('matches an episode row to a party keyed on its series', () => {
        const ep = row({
            userId: 'c99e93a8-3ccc-5262-9eb5-ec4669118a3d',
            username: 'ben',
            mediaItemId: 'ep',
            id: 'ep',
            seriesId: ITEM,
        });
        const out = annotateStreamsWithParties([ep], [party()], stranger, NOW);
        expect(out[0].watchParty).toBeDefined();
    });

    it('marks a stalled participant', () => {
        const out = annotateStreamsWithParties(
            [anna, ben],
            [party({ stalledClientIds: new Set(['c-ben']) })],
            stranger,
            NOW,
        );
        expect(out[1].watchParty).toMatchObject({ isStalled: true, syncState: 'buffering' });
        expect(out[0].watchParty?.isStalled).toBeUndefined();
    });

    it('returns the input untouched when there are no parties', () => {
        const input = [anna];
        expect(annotateStreamsWithParties(input, [], stranger, NOW)).toBe(input);
    });
});

describe('sync state', () => {
    const offsetsOf = (p: PartyStreamSnapshot) => computeClientOffsets(p, NOW);

    it('projects independently timed samples before comparing', () => {
        // Ben reported 5 s earlier at 95 s — projected to NOW he is at 100 s.
        const p = party({
            positions: new Map([
                ['c-anna', { position: 100, timestamp: NOW, isHost: true }],
                ['c-ben', { position: 95, timestamp: NOW - 5000, isHost: false }],
            ]),
        });
        expect(offsetsOf(p).get('c-ben')).toBeCloseTo(0, 5);
        expect(computePartySyncState(p, offsetsOf(p))).toBe('synced');
    });

    it('is drifting past the warn threshold', () => {
        const p = party({
            positions: new Map([
                ['c-anna', { position: 100, timestamp: NOW, isHost: true }],
                ['c-ben', { position: 96, timestamp: NOW, isHost: false }],
            ]),
        });
        expect(computePartySyncState(p, offsetsOf(p))).toBe('drifting');
    });

    it('is paused when the party is paused', () => {
        const p = party({ isPlaying: false });
        expect(computePartySyncState(p, offsetsOf(p))).toBe('paused');
    });

    it('buffering beats paused (a buffer check pauses the party)', () => {
        const p = party({ isPlaying: false, bufferCheckPending: true });
        expect(computePartySyncState(p, offsetsOf(p))).toBe('buffering');
    });

    it('is unknown without a fresh host/guest pair', () => {
        const p = party({
            positions: new Map([['c-anna', { position: 100, timestamp: NOW, isHost: true }]]),
        });
        expect(computePartySyncState(p, offsetsOf(p))).toBe('unknown');
    });

    it('ignores stale samples', () => {
        const p = party({
            positions: new Map([
                ['c-anna', { position: 100, timestamp: NOW, isHost: true }],
                ['c-ben', { position: 10, timestamp: NOW - 60_000, isHost: false }],
            ]),
        });
        expect(offsetsOf(p).has('c-ben')).toBe(false);
    });
});
