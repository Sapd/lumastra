// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Active Streams merge, exercised where it is actually dangerous.
 *
 * Two failure modes drive these tests:
 *
 * 1. **Double-counting.** Lumastra holds an ABS session open while it streams a
 *    book, so our own listeners appear in `/api/sessions/open` too. Missing the
 *    subtraction shows every Lumastra listener twice.
 * 2. **Privacy leak by resurrection.** If the subtraction ever ran against a
 *    privacy-filtered list, a user with `hide_streams` set would lose their
 *    Lumastra row, fail to claim its upstream id, and come back as a "direct"
 *    row — surfacing precisely the person who opted out.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
    ABS_SESSION_STALE_AFTER_MS,
    claimedUpstreamSessionIds,
    selectDirectSessions,
} from './audiobookshelf-direct-sessions.service.js';
import type { AudiobookSession } from '../audiobookshelf.js';
import type { StreamSession } from '../types.js';

function upstreamSession(overrides: Partial<AudiobookSession> = {}): AudiobookSession {
    return {
        id: 'abs-session-1',
        libraryItemId: 'li_book',
        displayTitle: 'Der Name des Lichtes',
        displayAuthor: 'Patrick Rothfuss',
        mediaMetadata: {} as AudiobookSession['mediaMetadata'],
        currentTime: 120,
        duration: 3600,
        chapters: [],
        updatedAt: 1_000_000,
        user: { username: 'denis' },
        mediaPlayer: 'AudiobookShelf',
        deviceInfo: { browserName: 'iOS App' },
        ...overrides,
    };
}

function localSession(overrides: Partial<StreamSession> = {}): StreamSession {
    return {
        __id: 'ps-1',
        id: 'uuid-book',
        mediaItemId: 'uuid-book',
        title: 'Der Name des Lichtes',
        mediaType: 'audiobook',
        username: 'denis',
        clientname: 'Lumastra',
        browsername: 'Safari',
        sessionSource: 'audiobookshelf',
        ...overrides,
    } as StreamSession;
}

describe('claimedUpstreamSessionIds', () => {
    it('claims the upstream id our own audiobook stream opened', () => {
        const claimed = claimedUpstreamSessionIds([
            localSession({ playSessionId: 'abs-session-1' }),
        ]);
        expect(claimed).toEqual(new Set(['abs-session-1']));
    });

    it('ignores non-audiobook sources so a Jellyfin PlaySessionId cannot suppress a real listener', () => {
        // Jellyfin PlaySessionIds live in the same field. If an id from another
        // source were allowed to claim, a colliding value would silently hide a
        // genuine direct listener rather than merely showing an extra row.
        const claimed = claimedUpstreamSessionIds([
            localSession({ sessionSource: 'jellyfin', playSessionId: 'abs-session-1' }),
            localSession({ sessionSource: 'lumastra', playSessionId: 'abs-session-2' }),
        ]);
        expect(claimed.size).toBe(0);
    });

    it('ignores our audiobook rows that carry no upstream id yet', () => {
        const claimed = claimedUpstreamSessionIds([localSession({ playSessionId: undefined })]);
        expect(claimed.size).toBe(0);
    });
});

describe('selectDirectSessions', () => {
    const now = 2_000_000;

    it('drops the upstream session backing our own stream — no double-count', () => {
        const ours = upstreamSession({ id: 'abs-session-1', updatedAt: now });
        const direct = upstreamSession({ id: 'abs-session-2', updatedAt: now });

        const result = selectDirectSessions([ours, direct], new Set(['abs-session-1']), now);

        expect(result.map((s) => s.id)).toEqual(['abs-session-2']);
    });

    it('keeps a session updated just inside the staleness window', () => {
        const session = upstreamSession({
            updatedAt: now - ABS_SESSION_STALE_AFTER_MS + 1_000,
        });
        expect(selectDirectSessions([session], new Set(), now)).toHaveLength(1);
    });

    it('drops a session lingering past the staleness window', () => {
        // AudiobookShelf has no client-liveness signal, so a crashed mobile app
        // leaves its session open forever. Without this cutoff the widget shows
        // a phantom listener indefinitely.
        const session = upstreamSession({
            updatedAt: now - ABS_SESSION_STALE_AFTER_MS - 1_000,
        });
        expect(selectDirectSessions([session], new Set(), now)).toHaveLength(0);
    });

    it('keeps a session whose updatedAt is missing rather than inventing a verdict', () => {
        const session = upstreamSession({ updatedAt: undefined as unknown as number });
        expect(selectDirectSessions([session], new Set(), now)).toHaveLength(1);
    });

    it('drops entries with no session id — they cannot be subtracted or keyed', () => {
        const session = upstreamSession({ id: '' });
        expect(selectDirectSessions([session], new Set(), now)).toHaveLength(0);
    });
});

describe('mergeDirectAudiobookshelfSessions', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.doUnmock('../config.js');
        vi.doUnmock('../audiobookshelf.js');
        vi.doUnmock('./database.service.js');
        vi.doUnmock('../cache/single-flight.js');
        vi.doUnmock('../database/queries/audiobooks.queries.js');
        vi.doUnmock('../database/queries/users.queries.js');
        vi.doUnmock('../database/queries/play-sessions.queries.js');
    });

    /**
     * Load the module under test with the whole outside world stubbed.
     * `getSessions` is reached through the real single-flight wrapper's
     * `compute` callback, which we short-circuit to a direct call.
     */
    async function loadWithUpstream(
        upstream: AudiobookSession[],
        opts: {
            audiobooks?: boolean;
            users?: Map<string, { id: string; username: string }>;
            books?: Map<string, { mediaId: string; title: string; imageRevision?: string }>;
            /** Upstream ids that one of our live download rows holds open. */
            downloadIds?: string[];
        } = {},
    ) {
        vi.doMock('../config.js', () => ({
            features: { audiobooks: opts.audiobooks ?? true },
        }));
        vi.doMock('../audiobookshelf.js', () => ({
            audiobookshelfClient: { getSessions: vi.fn().mockResolvedValue(upstream) },
        }));
        vi.doMock('./database.service.js', () => ({
            aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
        }));
        vi.doMock('../cache/single-flight.js', () => ({
            getOrComputeSingleFlight: vi.fn((o: { compute: () => Promise<string> }) => o.compute()),
        }));
        vi.doMock('../database/queries/audiobooks.queries.js', () => ({
            resolveAudiobooksByAbsItemIds: vi.fn().mockResolvedValue(opts.books ?? new Map()),
        }));
        vi.doMock('../database/queries/users.queries.js', () => ({
            resolveUsernamesToUsers: vi.fn().mockResolvedValue(opts.users ?? new Map()),
        }));
        vi.doMock('../database/queries/play-sessions.queries.js', () => ({
            getLiveDownloadAbsSessionIds: vi
                .fn()
                .mockResolvedValue(new Set(opts.downloadIds ?? [])),
        }));

        return import('./audiobookshelf-direct-sessions.service.js');
    }

    it('returns the input untouched when audiobooks are disabled', async () => {
        const { mergeDirectAudiobookshelfSessions } = await loadWithUpstream([upstreamSession()], {
            audiobooks: false,
        });
        const input = [localSession()];
        const result = await mergeDirectAudiobookshelfSessions(input, {
            isAdmin: true,
            hasWatchPermission: true,
        });
        expect(result).toBe(input);
    });

    it('does not list our own offline download as a direct listener', async () => {
        const { mergeDirectAudiobookshelfSessions } = await loadWithUpstream(
            [
                upstreamSession({ id: 'abs-download', updatedAt: Date.now() }),
                upstreamSession({ id: 'abs-2', updatedAt: Date.now(), user: { username: 'mara' } }),
            ],
            { downloadIds: ['abs-download'] },
        );

        const result = await mergeDirectAudiobookshelfSessions([], {
            isAdmin: true,
            hasWatchPermission: true,
        });

        expect(result.map((session) => session.__id)).toEqual(['abs-direct-abs-2']);
    });

    it('adds a direct listener as a read-only audiobook session', async () => {
        const { mergeDirectAudiobookshelfSessions } = await loadWithUpstream([
            upstreamSession({ id: 'abs-2', updatedAt: Date.now(), user: { username: 'mara' } }),
        ]);

        const result = await mergeDirectAudiobookshelfSessions([], {
            isAdmin: true,
            hasWatchPermission: false,
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            __id: 'abs-direct-abs-2',
            mediaType: 'audiobook',
            sessionSource: 'audiobookshelf',
            isReadOnly: true,
            username: 'mara',
        });
        // The cover route proxies ABS by library-item id, not by our UUID.
        expect(result[0]).not.toHaveProperty('imageId');
        expect(result[0].images).toMatchObject({
            primary: {
                href: '/api/image/audiobook/li_book?v=0',
                revision: '0',
                source: 'provider',
            },
        });
        // No stop path exists for another server's session, so nothing may be
        // left in the field the stop/enrichment lookups key on.
        expect(result[0].playSessionId).toBeUndefined();
    });

    it('does not double-count a listener we are streaming to ourselves', async () => {
        const { mergeDirectAudiobookshelfSessions } = await loadWithUpstream([
            upstreamSession({ id: 'abs-1', updatedAt: Date.now() }),
        ]);

        const ours = [localSession({ playSessionId: 'abs-1' })];
        const result = await mergeDirectAudiobookshelfSessions(ours, {
            isAdmin: true,
            hasWatchPermission: true,
        });

        expect(result).toBe(ours);
        expect(result).toHaveLength(1);
    });

    it('hides an unmatched listener from viewers who are neither admin nor watch-permissioned', async () => {
        // An ABS account with no Lumastra user has no hide_streams setting —
        // no privacy choice they were ever offered — so the row is restricted
        // to privileged viewers rather than shown site-wide.
        const { mergeDirectAudiobookshelfSessions } = await loadWithUpstream([
            upstreamSession({ id: 'abs-3', updatedAt: Date.now(), user: { username: 'stranger' } }),
        ]);

        const result = await mergeDirectAudiobookshelfSessions([], {
            isAdmin: false,
            hasWatchPermission: false,
        });

        expect(result).toHaveLength(0);
    });

    it('shows a MATCHED listener to unprivileged viewers, keyed on the canonical Lumastra identity', async () => {
        // Matched rows carry a userId and the canonical username, which is what
        // lets the downstream privacy filter apply that person's own
        // hide_streams setting and the card render their avatar.
        const { mergeDirectAudiobookshelfSessions } = await loadWithUpstream(
            [upstreamSession({ id: 'abs-4', updatedAt: Date.now(), user: { username: 'DENIS' } })],
            { users: new Map([['denis', { id: 'user-uuid', username: 'denis' }]]) },
        );

        const result = await mergeDirectAudiobookshelfSessions([], {
            isAdmin: false,
            hasWatchPermission: false,
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ username: 'denis', userId: 'user-uuid' });
    });

    it('prefers the local catalog row and exposes its UUID for linking', async () => {
        const { mergeDirectAudiobookshelfSessions } = await loadWithUpstream(
            [upstreamSession({ id: 'abs-5', updatedAt: Date.now() })],
            {
                books: new Map([
                    [
                        'li_book',
                        { mediaId: 'uuid-book', title: 'Local Title', imageRevision: '987' },
                    ],
                ]),
            },
        );

        const result = await mergeDirectAudiobookshelfSessions([], {
            isAdmin: true,
            hasWatchPermission: true,
        });

        expect(result[0]).toMatchObject({
            title: 'Local Title',
            mediaItemId: 'uuid-book',
            externalIds: { internal: 'uuid-book' },
            images: { primary: { revision: '987' } },
        });
    });

    it('still shows a listener whose book the sweep has not ingested yet', async () => {
        const { mergeDirectAudiobookshelfSessions } = await loadWithUpstream([
            upstreamSession({ id: 'abs-6', updatedAt: Date.now() }),
        ]);

        const result = await mergeDirectAudiobookshelfSessions([], {
            isAdmin: true,
            hasWatchPermission: true,
        });

        expect(result).toHaveLength(1);
        expect(result[0].title).toBe('Der Name des Lichtes');
        expect(result[0].externalIds).toBeUndefined();
    });

    it('serves the local sessions when AudiobookShelf is unreachable', async () => {
        vi.doMock('../config.js', () => ({ features: { audiobooks: true } }));
        vi.doMock('../audiobookshelf.js', () => ({
            audiobookshelfClient: {
                getSessions: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
            },
        }));
        vi.doMock('./database.service.js', () => ({
            aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
        }));
        vi.doMock('../cache/single-flight.js', () => ({
            getOrComputeSingleFlight: vi.fn((o: { compute: () => Promise<string> }) => o.compute()),
        }));
        vi.doMock('../database/queries/audiobooks.queries.js', () => ({
            resolveAudiobooksByAbsItemIds: vi.fn(),
        }));
        vi.doMock('../database/queries/users.queries.js', () => ({
            resolveUsernamesToUsers: vi.fn(),
        }));

        const { mergeDirectAudiobookshelfSessions } =
            await import('./audiobookshelf-direct-sessions.service.js');
        const input = [localSession()];
        const result = await mergeDirectAudiobookshelfSessions(input, {
            isAdmin: true,
            hasWatchPermission: true,
        });

        expect(result).toBe(input);
    });

    it('resolves the chapter title at the current position', async () => {
        const { mergeDirectAudiobookshelfSessions } = await loadWithUpstream([
            upstreamSession({
                id: 'abs-7',
                updatedAt: Date.now(),
                currentTime: 700,
                chapters: [
                    { title: 'Kapitel 1', start: 0, end: 600 },
                    { title: 'Kapitel 2', start: 600, end: 1200 },
                ],
            }),
        ]);

        const result = await mergeDirectAudiobookshelfSessions([], {
            isAdmin: true,
            hasWatchPermission: true,
        });

        expect(result[0].chapter).toBe('Kapitel 2');
    });
});
