// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `isPushRichSignedPath` — the predicate that decides which
 * `/api/v1/notifications/…` paths skip the surface's bearer gate.
 *
 * Two failure directions, both real:
 *   - too narrow → the signed URL is 401'd before its signature is ever
 *     checked, and the whole rich-notification feature is dead (the bug this
 *     matcher exists to fix);
 *   - too wide → an authenticated notifications route runs unauthenticated on
 *     attacker-chosen input. `csrf.test.ts` pins the same lesson for its own
 *     exempt list ("`/api/joke` must not be exempt for starting with `/j`").
 *
 * The near-miss block below is therefore the important half of this file.
 */

import { describe, it, expect } from 'vitest';
import { isPushRichSignedPath, PUSH_CONTENT_LOCALE_SEGMENTS } from './push-rich-paths.js';

const UUID = '8f2b1c34-5d6e-4a7b-8c9d-0e1f2a3b4c5d';

describe('isPushRichSignedPath — the two signed rich-notification routes', () => {
    it('matches the artwork path', () => {
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/push-image`)).toBe(true);
    });

    it('matches the forwarded-notification artwork path', () => {
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/image`)).toBe(true);
    });

    it('matches the content path for every locale the sender can mint', () => {
        for (const locale of PUSH_CONTENT_LOCALE_SEGMENTS) {
            expect(
                isPushRichSignedPath(`/api/v1/notifications/${UUID}/push-content/${locale}`),
            ).toBe(true);
        }
    });

    it('matches an uppercase UUID (postgres emits lowercase, but the hex is case-insensitive)', () => {
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID.toUpperCase()}/push-image`)).toBe(
            true,
        );
    });

    it('ignores the query string — the predicate is given a pathname only', () => {
        // Callers pass event.url.pathname; a `?sig=` never reaches here.
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/push-image`)).toBe(true);
    });
});

describe('isPushRichSignedPath — near misses that must stay gated', () => {
    it('does NOT exempt the /api/v1/notifications/ prefix wholesale', () => {
        expect(isPushRichSignedPath('/api/v1/notifications')).toBe(false);
        expect(isPushRichSignedPath('/api/v1/notifications/')).toBe(false);
        expect(isPushRichSignedPath('/api/v1/notifications/unread-count')).toBe(false);
        expect(isPushRichSignedPath('/api/v1/notifications/preferences')).toBe(false);
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}`)).toBe(false);
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/read`)).toBe(false);
    });

    it('does NOT exempt a path that merely CONTAINS an exempt segment', () => {
        // The `/api/joke` lesson: an exempt segment appearing anywhere else in
        // the path must not carry the exemption with it.
        expect(isPushRichSignedPath('/api/v1/notifications/push-image')).toBe(false);
        expect(isPushRichSignedPath('/api/v1/notifications/push-image/settings')).toBe(false);
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/push-image/raw`)).toBe(false);
        expect(isPushRichSignedPath('/api/v1/admin/push-image')).toBe(false);
        expect(isPushRichSignedPath(`/api/v1/media/${UUID}/push-content/en`)).toBe(false);
    });

    it('does NOT exempt a non-UUID id segment', () => {
        expect(isPushRichSignedPath('/api/v1/notifications/me/push-image')).toBe(false);
        expect(isPushRichSignedPath('/api/v1/notifications/../push-image')).toBe(false);
        // Dash-less UUID: could never carry a valid signature (signUrl signs the
        // pathname verbatim, and minted URLs are always dashed).
        expect(
            isPushRichSignedPath(`/api/v1/notifications/${UUID.replaceAll('-', '')}/push-image`),
        ).toBe(false);
        // Too short / too long by one hex digit.
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID.slice(0, -1)}/push-image`)).toBe(
            false,
        );
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}a/push-image`)).toBe(false);
        // Non-hex character inside an otherwise well-shaped UUID.
        expect(
            isPushRichSignedPath(
                '/api/v1/notifications/8f2b1c34-5d6e-4a7b-8c9d-0e1f2a3b4c5z/push-image',
            ),
        ).toBe(false);
    });

    it('does NOT exempt an unknown locale segment', () => {
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/push-content/fr`)).toBe(false);
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/push-content/en-US`)).toBe(
            false,
        );
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/push-content/EN`)).toBe(false);
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/push-content`)).toBe(false);
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/push-content/`)).toBe(false);
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/push-content/en/extra`)).toBe(
            false,
        );
    });

    it('does NOT exempt the internal /api mirror — signatures are minted for /api/v1 only', () => {
        expect(isPushRichSignedPath(`/api/notifications/${UUID}/push-image`)).toBe(false);
        expect(isPushRichSignedPath(`/api/notifications/${UUID}/push-content/en`)).toBe(false);
    });

    it('does NOT exempt a path that merely ends with an exempt route', () => {
        expect(isPushRichSignedPath(`/x/api/v1/notifications/${UUID}/push-image`)).toBe(false);
        expect(isPushRichSignedPath(`/api/v2/notifications/${UUID}/push-image`)).toBe(false);
    });

    it('does NOT exempt a sibling of the forwarded-notification image', () => {
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/images`)).toBe(false);
        expect(isPushRichSignedPath(`/api/v1/notifications/${UUID}/image/x`)).toBe(false);
        expect(isPushRichSignedPath(`/api/v1/notifications/not-a-uuid/image`)).toBe(false);
        expect(isPushRichSignedPath(`/api/notifications/${UUID}/image`)).toBe(false);
    });
});
