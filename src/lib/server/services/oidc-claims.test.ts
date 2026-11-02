// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    parseEmailVerified,
    extractGroups,
    normalizeUsername,
    deriveBaseUsername,
    deriveUsernameCandidate,
    parseClaims,
} from './oidc-claims.js';

describe('parseEmailVerified (takeover-guard half)', () => {
    it('treats only boolean true / "true" as verified', () => {
        expect(parseEmailVerified(true)).toBe(true);
        expect(parseEmailVerified('true')).toBe(true);
    });
    it('fails closed for everything else', () => {
        for (const v of [false, 'false', undefined, null, 0, 1, 'yes', '', {}]) {
            expect(parseEmailVerified(v)).toBe(false);
        }
    });
});

describe('extractGroups', () => {
    it('reads a top-level array claim', () => {
        expect(extractGroups({ groups: ['admin', 'users'] }, 'groups')).toEqual(['admin', 'users']);
    });
    it('reads a nested dot-path claim (Keycloak realm_access.roles)', () => {
        expect(
            extractGroups({ realm_access: { roles: ['admin', 'x'] } }, 'realm_access.roles'),
        ).toEqual(['admin', 'x']);
    });
    it('splits a delimited string claim', () => {
        expect(extractGroups({ groups: 'admin, users  staff' }, 'groups')).toEqual([
            'admin',
            'users',
            'staff',
        ]);
    });
    it('filters non-strings and empties', () => {
        expect(extractGroups({ groups: ['a', 1, null, '', 'b'] }, 'groups')).toEqual(['a', 'b']);
    });
    it('returns [] for a missing claim', () => {
        expect(extractGroups({}, 'groups')).toEqual([]);
        expect(extractGroups({ a: {} }, 'a.b.c')).toEqual([]);
    });
});

describe('normalizeUsername', () => {
    it('lowercases and keeps valid characters', () => {
        expect(normalizeUsername('Alice.Doe_1')).toBe('alice.doe_1');
    });
    it('maps disallowed characters to dashes and strips leading/trailing punctuation', () => {
        expect(normalizeUsername('  Foo Bar! ')).toBe('foo-bar');
        expect(normalizeUsername('...x.y...')).toBe('x.y');
    });
    it('returns null for unsalvageable / too-short input', () => {
        expect(normalizeUsername('a')).toBeNull();
        expect(normalizeUsername('!')).toBeNull();
        expect(normalizeUsername('')).toBeNull();
    });
    it('truncates to 63 chars', () => {
        const out = normalizeUsername('a'.repeat(100));
        expect(out).not.toBeNull();
        expect(out!.length).toBe(63);
    });
    it('rejects a name reserved for an internal actor (e.g. "system")', () => {
        expect(normalizeUsername('system')).toBeNull();
        expect(normalizeUsername('System')).toBeNull();
        expect(normalizeUsername('  SYSTEM  ')).toBeNull();
    });
    it('does not reject a plausible operator name like "admin"', () => {
        expect(normalizeUsername('admin')).toBe('admin');
    });
});

describe('deriveBaseUsername', () => {
    const base = {
        issuer: 'https://idp',
        subject: 's',
        email: null,
        emailVerified: false,
        preferredUsername: null,
        name: null,
        groups: [],
    };
    it('prefers preferred_username', () => {
        expect(deriveBaseUsername({ ...base, preferredUsername: 'Jdoe', email: 'x@y.com' })).toBe(
            'jdoe',
        );
    });
    it('falls back to the email local-part', () => {
        expect(deriveBaseUsername({ ...base, email: 'John.Roe@example.com' })).toBe('john.roe');
    });
    it('falls back to "user" when nothing is usable', () => {
        expect(deriveBaseUsername({ ...base, preferredUsername: '!', email: null })).toBe('user');
    });
    it('never provisions the reserved "system" username from preferred_username', () => {
        expect(deriveBaseUsername({ ...base, preferredUsername: 'system', email: null })).toBe(
            'user',
        );
    });
});

describe('deriveUsernameCandidate (link-by-username — no generic fallback)', () => {
    const base = {
        issuer: 'https://idp',
        subject: 's',
        email: null,
        emailVerified: false,
        preferredUsername: null,
        name: null,
        groups: [],
    };
    it('returns the normalized preferred_username', () => {
        expect(deriveUsernameCandidate({ ...base, preferredUsername: 'Alice' })).toBe('alice');
    });
    it('falls back to the email local-part', () => {
        expect(deriveUsernameCandidate({ ...base, email: 'Bob@x.com' })).toBe('bob');
    });
    it('returns null when no real username signal exists (NEVER matches a "user" account)', () => {
        expect(deriveUsernameCandidate({ ...base })).toBeNull();
        expect(deriveUsernameCandidate({ ...base, preferredUsername: '!' })).toBeNull();
    });
    it('returns null for the reserved "system" username, even via the email fallback', () => {
        expect(deriveUsernameCandidate({ ...base, preferredUsername: 'system' })).toBeNull();
        expect(deriveUsernameCandidate({ ...base, email: 'system@example.com' })).toBeNull();
    });
});

describe('parseClaims', () => {
    it('maps a full claim set', () => {
        const c = parseClaims(
            {
                iss: 'https://idp.example.com/',
                sub: 'abc123',
                email: 'a@b.com',
                email_verified: true,
                preferred_username: 'alice',
                name: 'Alice A',
                groups: ['admin'],
                picture: 'https://idp.example.com/avatar.png',
            },
            'groups',
        );
        expect(c).toEqual({
            issuer: 'https://idp.example.com/',
            subject: 'abc123',
            email: 'a@b.com',
            emailVerified: true,
            preferredUsername: 'alice',
            name: 'Alice A',
            groups: ['admin'],
            picture: 'https://idp.example.com/avatar.png',
        });
    });
    it('defaults missing optional fields safely', () => {
        const c = parseClaims({ iss: 'https://i', sub: 's' }, 'groups');
        expect(c.email).toBeNull();
        expect(c.emailVerified).toBe(false);
        expect(c.groups).toEqual([]);
        expect(c.picture).toBeNull();
    });
    it('treats a non-string or empty picture as absent', () => {
        expect(parseClaims({ iss: 'i', sub: 's', picture: 42 }, 'groups').picture).toBeNull();
        expect(parseClaims({ iss: 'i', sub: 's', picture: '' }, 'groups').picture).toBeNull();
    });
});
