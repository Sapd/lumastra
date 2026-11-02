// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    admitsPrepare,
    mayAttemptPrepare,
    prepareSlotKey,
    prepareSlotMember,
} from './prepare-cap.js';
import { isCoordinationKey } from '$lib/server/cache/valkey.js';

describe('prepareSlotMember', () => {
    it('identifies the ARTIFACT, not the request', () => {
        // The rendition's identity is (file, rung, audio track) — the same
        // triple the table's unique constraint uses. Keying on anything
        // request-shaped would make a re-POST look like a new prepare.
        expect(prepareSlotMember('f1', '720p', 1)).toBe(prepareSlotMember('f1', '720p', 1));
        expect(prepareSlotMember('f1', '720p', 1)).not.toBe(prepareSlotMember('f1', '540p', 1));
        expect(prepareSlotMember('f1', '720p', 1)).not.toBe(prepareSlotMember('f1', '720p', 2));
    });

    // The POST that holds the slot and the status GET that releases it must
    // build the SAME string. Stringifying null would give 'f1:720p:null', which
    // happens to match today — but only by accident, and one `?? ''` anywhere
    // upstream would silently desync the two and strand the slot until TTL.
    it('renders a video-only rendition with an explicit token, not "null"', () => {
        expect(prepareSlotMember('f1', '720p', null)).toBe('f1:720p:none');
        expect(prepareSlotMember('f1', '720p', 2)).toBe('f1:720p:2');
    });

    it('keeps a video-only rendition distinct from one with a real track', () => {
        expect(prepareSlotMember('f1', '720p', null)).not.toBe(prepareSlotMember('f1', '720p', 0));
    });

    // A held video-only slot must still count as "this same artifact", or a
    // re-POST of it is treated as a second preparation and refused under cap 1.
    it('lets a re-request of a held video-only rendition through the cap', () => {
        const member = prepareSlotMember('f1', '720p', null);
        expect(mayAttemptPrepare([member], 'f1', '720p', 1)).toBe(true);
        expect(mayAttemptPrepare([member], 'f2', '720p', 1)).toBe(false);
    });
});

describe('prepareSlotKey', () => {
    it('is scoped per user', () => {
        expect(prepareSlotKey('a')).not.toBe(prepareSlotKey('b'));
    });

    it('uses the coordination keyspace prefix', () => {
        // An evicted counter silently LIFTS the cap, which is the dangerous
        // direction. Asserting against `isCoordinationKey` itself — not just
        // that the key starts with a literal string — means removing the
        // `dl:prep:` entry from COORDINATION_KEY_PREFIXES in valkey.ts fails
        // this test, rather than leaving the real invariant unchecked.
        expect(isCoordinationKey(prepareSlotKey('a'))).toBe(true);
    });
});

describe('admitsPrepare', () => {
    it('admits while under the cap', () => {
        expect(admitsPrepare([], 'm1', 1)).toBe(true);
    });

    it('refuses a NEW prepare at the cap', () => {
        expect(admitsPrepare(['other'], 'm1', 1)).toBe(false);
    });

    it('ALWAYS admits a re-POST of a slot the user already holds', () => {
        // THE LOAD-BEARING CASE. A deferred rendition is advanced by nothing
        // except a re-POST after the stale window. If the cap blocked that
        // re-POST, a pool at its cap could never make progress and would stall
        // forever — the cap would cause the exact failure it exists to prevent.
        expect(admitsPrepare(['m1'], 'm1', 1)).toBe(true);
        expect(admitsPrepare(['m1', 'm2'], 'm1', 1)).toBe(true);
    });

    it('treats a cap below 1 as 1 rather than blocking everything', () => {
        expect(admitsPrepare([], 'm1', 0)).toBe(true);
    });
});
