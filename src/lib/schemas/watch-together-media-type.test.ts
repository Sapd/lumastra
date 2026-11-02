// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildPublicAuthor } from '$lib/shared/public-author';

/**
 * Watch-party media-type vocabulary split.
 *
 * The session's `mediaType` used to be whatever spelling the creating client
 * sent — stored in Valkey and echoed back verbatim — so the same response field
 * could be `tv` or `series` depending on which client opened the party, and the
 * published enum admitted both. Input stays lenient; the response vocabulary is
 * now narrow and canonical.
 */

import { describe, it, expect } from 'vitest';
import {
    watchTogetherMediaTypeSchema,
    watchTogetherPublicMediaTypeSchema,
    canonicalWatchTogetherMediaType,
    WatchTogetherPartySchema,
} from './watch-together';

describe('watch-party media-type input vocabulary', () => {
    it('still accepts the legacy `tv` token from older clients', () => {
        expect(watchTogetherMediaTypeSchema.safeParse('tv').success).toBe(true);
    });

    it('accepts the canonical tokens', () => {
        for (const t of ['movie', 'episode', 'series']) {
            expect(watchTogetherMediaTypeSchema.safeParse(t).success).toBe(true);
        }
    });
});

describe('watch-party media-type response vocabulary', () => {
    it('does NOT admit `tv`', () => {
        expect(watchTogetherPublicMediaTypeSchema.safeParse('tv').success).toBe(false);
    });

    it('admits movie, episode and series', () => {
        for (const t of ['movie', 'episode', 'series']) {
            expect(watchTogetherPublicMediaTypeSchema.safeParse(t).success).toBe(true);
        }
    });

    it('rejects a session payload carrying `tv`', () => {
        // Pins the published WatchTogetherParty component: a `tv` here is the
        // exact drift this split exists to prevent.
        const session = {
            code: 'ABCD',
            host: buildPublicAuthor('11111111-1111-4111-8111-111111111111', 'alice', 'internal'),
            itemId: 'm1',
            mediaType: 'tv',
            title: 'Drifting Clouds',
            currentTime: 0,
            isPlaying: false,
            playbackRate: 1,
            visibility: 'unlisted',
            participants: [],
            createdAt: Date.now(),
            lastSync: Date.now(),
        };
        expect(
            WatchTogetherPartySchema.safeParse({ ...session, mediaType: 'series' }).success,
        ).toBe(true);
        expect(WatchTogetherPartySchema.safeParse(session).success).toBe(false);
    });
});

describe('canonicalWatchTogetherMediaType', () => {
    it('maps the legacy token to the canonical one', () => {
        expect(canonicalWatchTogetherMediaType('tv')).toBe('series');
    });

    it('passes canonical tokens through unchanged', () => {
        expect(canonicalWatchTogetherMediaType('movie')).toBe('movie');
        expect(canonicalWatchTogetherMediaType('series')).toBe('series');
    });

    it('preserves `episode` — a real party media type a generic converter drops', () => {
        expect(canonicalWatchTogetherMediaType('episode')).toBe('episode');
    });
});
