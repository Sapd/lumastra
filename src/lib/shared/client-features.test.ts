// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    normalizeClientFeatures,
    announcesFeature,
    MAX_CLIENT_FEATURES,
    MAX_CLIENT_FEATURE_LENGTH,
    CLIENT_FEATURE_ADMIN_MESSAGE,
    CLIENT_FEATURE_WATCH_TOGETHER,
    KNOWN_CLIENT_FEATURES,
    WEB_CLIENT_FEATURES,
} from './client-features.js';

describe('normalizeClientFeatures', () => {
    it('keeps tokens this build has never heard of', () => {
        // The load-bearing property: a client newer than the server must not be
        // refused or silently stripped down to what this build knows. If this
        // ever filters against KNOWN_CLIENT_FEATURES, a newer client's
        // announcement becomes invisible to the admin surface.
        expect(normalizeClientFeatures(['admin_message', 'holographic_toast'])).toEqual([
            'admin_message',
            'holographic_toast',
        ]);
    });

    it('lowercases and trims', () => {
        expect(normalizeClientFeatures(['  Admin_Message  '])).toEqual(['admin_message']);
    });

    it('de-duplicates while preserving first-seen order', () => {
        expect(
            normalizeClientFeatures(['maintenance_notice', 'admin_message', 'maintenance_notice']),
        ).toEqual(['maintenance_notice', 'admin_message']);
    });

    it('drops malformed tokens without rejecting the whole list', () => {
        expect(
            normalizeClientFeatures([
                'admin_message',
                '',
                '   ',
                'has space',
                'has-dash',
                'Ünicode',
                '_leading',
                'trailing_ok',
            ]),
        ).toEqual(['admin_message', 'trailing_ok']);
    });

    it('drops over-long tokens', () => {
        const tooLong = 'a'.repeat(MAX_CLIENT_FEATURE_LENGTH + 1);
        const justRight = 'b'.repeat(MAX_CLIENT_FEATURE_LENGTH);
        expect(normalizeClientFeatures([tooLong, justRight])).toEqual([justRight]);
    });

    it('caps the list', () => {
        const many = Array.from({ length: MAX_CLIENT_FEATURES + 20 }, (_, i) => `feature_${i}`);
        expect(normalizeClientFeatures(many)).toHaveLength(MAX_CLIENT_FEATURES);
    });

    it('preserves presence: undefined stays undefined, a list stays a list', () => {
        // The two are different claims and both have a consumer that acts on
        // the difference — NULL vs {} in play_sessions.client_features, and
        // heartbeat's supportsWatchTogether resolution, which must NOT fall
        // back to the deviceType==='tv' guess for a client that announced [].
        expect(normalizeClientFeatures(undefined)).toBeUndefined();
        expect(normalizeClientFeatures([])).toEqual([]);
        expect(normalizeClientFeatures(['', 'has space'])).toEqual([]);
    });
});

describe('the empty-list claim reaches the consumers that act on it', () => {
    it('reads as "does not announce" rather than as "unknown"', () => {
        const announced = normalizeClientFeatures([]);
        expect(announced).not.toBeUndefined();
        expect(announcesFeature(announced, CLIENT_FEATURE_ADMIN_MESSAGE)).toBe(false);
        expect(announcesFeature(announced, CLIENT_FEATURE_WATCH_TOGETHER)).toBe(false);
    });
});

describe('announcesFeature', () => {
    it('treats absent and empty as the same answer', () => {
        expect(announcesFeature(undefined, CLIENT_FEATURE_ADMIN_MESSAGE)).toBe(false);
        expect(announcesFeature(null, CLIENT_FEATURE_ADMIN_MESSAGE)).toBe(false);
        expect(announcesFeature([], CLIENT_FEATURE_ADMIN_MESSAGE)).toBe(false);
    });

    it('matches an announced token exactly', () => {
        expect(announcesFeature(['admin_message'], CLIENT_FEATURE_ADMIN_MESSAGE)).toBe(true);
        expect(announcesFeature(['maintenance_notice'], CLIENT_FEATURE_ADMIN_MESSAGE)).toBe(false);
    });
});

describe('the token vocabulary itself', () => {
    it('survives normalisation unchanged', () => {
        // A token that normalizeClientFeatures would rewrite could never be
        // matched: the client's announcement is normalised on the way in, the
        // constant is not. Catches an uppercase or hyphenated token at review
        // time instead of as a silently-never-true gate.
        for (const token of KNOWN_CLIENT_FEATURES) {
            expect(normalizeClientFeatures([token])).toEqual([token]);
        }
    });

    it('only claims tokens the vocabulary defines for the web player', () => {
        for (const token of WEB_CLIENT_FEATURES) {
            expect(KNOWN_CLIENT_FEATURES).toContain(token);
        }
    });
});
