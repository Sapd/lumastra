// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard — the admin broadcast surface stays ADMIN-ONLY and INTERNAL.
 *
 * These four endpoints let one person write into every user's inbox and send
 * every registered device a push. That makes their gating the single most
 * consequential line in the feature, and it is a line that is easy to lose
 * silently: `auth` and `visibility` are plain object literals with no type
 * requiring either to be present, so deleting one is a valid def that quietly
 * becomes reachable — `auth: {kind:'user'}` by omission, or published into the
 * public `/api/v1` surface and the generated OpenAPI spec.
 *
 * Asserting on the def objects rather than by driving requests is deliberate:
 * the mount is what enforces these, and it is already tested. What is NOT
 * tested anywhere else is that these particular defs still DECLARE the right
 * thing.
 */

import { describe, it, expect } from 'vitest';
import {
    SendBroadcastRequestSchema,
    SetBroadcastPinRequestSchema,
} from '$lib/schemas/admin-broadcasts.js';

const { def: broadcastDef } = await import('./broadcast/index.js');
const { def: listDef } = await import('./broadcasts/index.js');
const { def: itemDef } = await import('./broadcasts/[id]/index.js');

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SEND_BASE = {
    title: 'Maintenance on Sunday',
    audience: 'all' as const,
    pinned: false,
    pushEnabled: true,
};

/** An instant safely in the past / future, as the ISO string the schema takes. */
function isoOffsetFromNow(ms: number): string {
    return new Date(Date.now() + ms).toISOString();
}

/** The `path` of every issue a failed parse produced, flattened for assertion. */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
    return (result.error?.issues ?? []).map((i) => i.path.join('.'));
}

const DEFS = [
    ['POST /api/admin/notifications/broadcast', broadcastDef],
    ['GET /api/admin/notifications/broadcasts', listDef],
    ['PATCH|DELETE /api/admin/notifications/broadcasts/{id}', itemDef],
] as const;

describe('admin broadcast defs — gating', () => {
    for (const [name, def] of DEFS) {
        it(`${name} requires admin`, () => {
            expect(def.auth).toEqual({ kind: 'admin' });
        });

        it(`${name} is internal-only`, () => {
            // Not merely undocumented: `visibility: 'internal'` is what keeps
            // it off the published /api/v1 surface. A def that loses this is
            // mounted publicly and appears in the generated spec.
            expect(def.visibility).toBe('internal');
        });
    }
});

describe('admin broadcast defs — method surface', () => {
    it('exposes only the methods the feature has', () => {
        expect(Object.keys(broadcastDef.handlers)).toEqual(['POST']);
        expect(Object.keys(listDef.handlers)).toEqual(['GET']);
        // Pin/unpin and delete — and NOTHING else. A sent broadcast's text is
        // immutable by product decision (it has already been copied into every
        // recipient's inbox and mirrored into however many push banners), so
        // the absence of a PUT here is the contract, not an omission. If a
        // text-edit endpoint ever appears, this assertion is where the decision
        // gets re-opened deliberately rather than by accident.
        expect(Object.keys(itemDef.handlers).sort()).toEqual(['DELETE', 'PATCH']);
    });

    it('validates the {id} param as a UUID rather than a bare string', () => {
        // The handler interpolates it into a `::uuid` cast; Postgres throws on
        // a malformed one, which the mount reports as a 500 for what is really
        // the caller's bad input.
        const params = itemDef.request?.params;
        expect(params).toBeDefined();
        expect(params!.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
        expect(params!.safeParse({ id: '11111111-1111-4111-8111-111111111111' }).success).toBe(
            true,
        );
    });

    it('accepts a bodyless DELETE — the def-level body schema is all-optional', () => {
        // `request.body` is declared once per def but the mount body-validates
        // DELETE too, decoding an absent body to `{}`. A required field here
        // would 422 every delete. The strict schema is re-applied inside PATCH
        // instead; see the def.
        expect(itemDef.request?.body?.safeParse({}).success).toBe(true);
    });
});

/**
 * The send request's cross-field rules.
 *
 * Each one exists because the SERVICE silently tolerates the input rather than
 * failing on it, so the schema is the only place the mistake can be named. The
 * caller who hits these is a PAT-scoped admin script, not the compose page —
 * the page cannot construct any of them.
 */
describe('SendBroadcastRequestSchema — cross-field rules', () => {
    it('accepts the ordinary shapes', () => {
        expect(SendBroadcastRequestSchema.safeParse(SEND_BASE).success).toBe(true);
        expect(
            SendBroadcastRequestSchema.safeParse({
                ...SEND_BASE,
                audience: 'users',
                userIds: [USER_A],
            }).success,
        ).toBe(true);
    });

    it('still requires userIds for the "users" audience', () => {
        const result = SendBroadcastRequestSchema.safeParse({ ...SEND_BASE, audience: 'users' });
        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain('userIds');
    });

    it('REJECTS userIds alongside audience "all" instead of dropping them', () => {
        const result = SendBroadcastRequestSchema.safeParse({
            ...SEND_BASE,
            audience: 'all',
            userIds: [USER_A],
        });

        // `resolveRecipients` never looks at `userIds` for the `all` audience,
        // so this used to send to EVERY user with no signal that the selection
        // was discarded. Between "reached everyone" and "reached the one person
        // I named", guessing is not acceptable.
        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain('userIds');
    });

    it('tolerates an empty userIds array with audience "all"', () => {
        // Nothing was discarded, so there is nothing to warn about — a client
        // that always sends the key must not be forced to omit it.
        expect(
            SendBroadcastRequestSchema.safeParse({ ...SEND_BASE, audience: 'all', userIds: [] })
                .success,
        ).toBe(true);
    });

    it('accepts a future pinExpiresAt', () => {
        expect(
            SendBroadcastRequestSchema.safeParse({
                ...SEND_BASE,
                pinned: true,
                pinExpiresAt: isoOffsetFromNow(60 * 60 * 1000),
            }).success,
        ).toBe(true);
    });

    it('REJECTS a pinExpiresAt already in the past', () => {
        const result = SendBroadcastRequestSchema.safeParse({
            ...SEND_BASE,
            pinned: true,
            pinExpiresAt: isoOffsetFromNow(-60 * 60 * 1000),
        });

        // `pinned_at` is set to now() unconditionally whenever `pinned` is
        // true, so the CHECK constraint is satisfied and the row stores as
        // pinned — while `pin_expires_at > now()` is already false, so no
        // recipient ever sees the pin. Accepted, stored, and invisible.
        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain('pinExpiresAt');
    });

    it('ignores a past pinExpiresAt on an UNPINNED send (the deadline is not stored)', () => {
        expect(
            SendBroadcastRequestSchema.safeParse({
                ...SEND_BASE,
                pinned: false,
                pinExpiresAt: isoOffsetFromNow(-60 * 60 * 1000),
            }).success,
        ).toBe(true);
    });

    it('caps an explicit recipient selection', () => {
        const ids = Array.from(
            { length: 5001 },
            (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${i.toString(16).padStart(12, '0')}`,
        );
        const result = SendBroadcastRequestSchema.safeParse({
            ...SEND_BASE,
            audience: 'users',
            userIds: ids,
        });
        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain('userIds');
        expect(
            SendBroadcastRequestSchema.safeParse({
                ...SEND_BASE,
                audience: 'users',
                userIds: ids.slice(0, 5000),
            }).success,
        ).toBe(true);
    });

    it('treats an omitted pinExpiresAt as "pin indefinitely", not as invalid', () => {
        expect(SendBroadcastRequestSchema.safeParse({ ...SEND_BASE, pinned: true }).success).toBe(
            true,
        );
    });
});

/**
 * The attached-link rules.
 *
 * This is the only field on the request that is not simply admin-trusted text:
 * whatever it holds is handed to every recipient's client as something to OPEN.
 * The schema is the ONLY place it is checked — the service, the presenter and
 * the drawer all treat a stored value as already-validated — so each rule below
 * is load-bearing rather than defensive.
 */
describe('SendBroadcastRequestSchema — attached link URL', () => {
    it('accepts an absolute http(s) URL', () => {
        for (const linkUrl of [
            'https://lumastra.org/release-notes',
            'http://status.example.com',
            'https://example.com/a?b=c#d',
        ]) {
            expect(SendBroadcastRequestSchema.safeParse({ ...SEND_BASE, linkUrl }).success).toBe(
                true,
            );
        }
    });

    it('treats an omitted or empty link as "no link", exactly like body', () => {
        expect(SendBroadcastRequestSchema.safeParse(SEND_BASE).success).toBe(true);
        // A client that always sends the key must not have to learn to omit it.
        expect(SendBroadcastRequestSchema.safeParse({ ...SEND_BASE, linkUrl: '' }).success).toBe(
            true,
        );
        expect(SendBroadcastRequestSchema.safeParse({ ...SEND_BASE, linkUrl: '   ' }).success).toBe(
            true,
        );
    });

    it('REJECTS every scheme outside the http(s) allowlist', () => {
        for (const linkUrl of [
            'javascript:alert(1)',
            // Upper-cased on purpose: `new URL` normalizes the scheme, so the
            // allowlist compares against a lower-cased protocol and a client
            // cannot slip past it with capitalization.
            'JavaScript:alert(1)',
            'data:text/html;base64,PHNjcmlwdD4=',
            'file:///etc/passwd',
            'vbscript:msgbox(1)',
        ]) {
            const result = SendBroadcastRequestSchema.safeParse({ ...SEND_BASE, linkUrl });
            // An announcement's link is rendered as an `href` by every client
            // that supports it — `javascript:` there executes in the app's own
            // origin, for every recipient at once.
            expect(result.success, linkUrl).toBe(false);
            expect(issuePaths(result)).toContain('linkUrl');
        }
    });

    it('REJECTS a relative or otherwise non-absolute value', () => {
        for (const linkUrl of ['/status', 'example.com/status', 'not a url at all']) {
            const result = SendBroadcastRequestSchema.safeParse({ ...SEND_BASE, linkUrl });
            // Parsed with no base on purpose: resolving one against whatever
            // origin happened to be current would store a link that means
            // different things on different surfaces.
            expect(result.success, linkUrl).toBe(false);
            expect(issuePaths(result)).toContain('linkUrl');
        }
    });

    it('REJECTS a URL past the length cap', () => {
        const result = SendBroadcastRequestSchema.safeParse({
            ...SEND_BASE,
            linkUrl: `https://example.com/${'a'.repeat(2048)}`,
        });
        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain('linkUrl');
    });
});

describe('SetBroadcastPinRequestSchema — pin deadline', () => {
    it('accepts a pin with a future deadline, and a bare unpin', () => {
        expect(
            SetBroadcastPinRequestSchema.safeParse({
                pinned: true,
                pinExpiresAt: isoOffsetFromNow(24 * 60 * 60 * 1000),
            }).success,
        ).toBe(true);
        expect(SetBroadcastPinRequestSchema.safeParse({ pinned: false }).success).toBe(true);
    });

    it('accepts an UNPIN that carries a lapsed deadline — unpinning clears the pin block', () => {
        expect(
            SetBroadcastPinRequestSchema.safeParse({
                pinned: false,
                pinExpiresAt: isoOffsetFromNow(-60 * 60 * 1000),
            }).success,
        ).toBe(true);
    });

    it('REJECTS a past deadline here too — same silent no-op as on send', () => {
        const result = SetBroadcastPinRequestSchema.safeParse({
            pinned: true,
            pinExpiresAt: isoOffsetFromNow(-1000),
        });
        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain('pinExpiresAt');
    });
});
