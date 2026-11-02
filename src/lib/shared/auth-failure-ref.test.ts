// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    AUTH_FAILURE_MESSAGES,
    AUTH_FAILURE_REF_PARAM,
    formatAuthFailureBanner,
    formatAuthFailureReport,
    newAuthFailureRef,
    resolveAuthFailureMessage,
    sanitizeAuthFailureRef,
} from './auth-failure-ref.js';

describe('newAuthFailureRef', () => {
    it('produces an 8-char lowercase-hex token that survives its own sanitizer', () => {
        for (let i = 0; i < 25; i++) {
            const ref = newAuthFailureRef();
            expect(ref).toMatch(/^[0-9a-f]{8}$/);
            expect(sanitizeAuthFailureRef(ref)).toBe(ref);
        }
    });

    it('is not a constant (two calls differ)', () => {
        const refs = new Set(Array.from({ length: 20 }, () => newAuthFailureRef()));
        expect(refs.size).toBeGreaterThan(1);
    });
});

describe('sanitizeAuthFailureRef', () => {
    it('accepts a well-formed token', () => {
        expect(sanitizeAuthFailureRef('a1b2c3d4')).toBe('a1b2c3d4');
    });

    it('rejects anything that is not exactly 8 lowercase hex chars', () => {
        for (const bad of [
            null,
            undefined,
            '',
            'A1B2C3D4',
            'a1b2c3d',
            'a1b2c3d45',
            'zzzzzzzz',
            'a1b2c3d4 ',
            '<script>x</script>',
            'Call 1-800-555-0100 to unlock your account',
        ]) {
            expect(sanitizeAuthFailureRef(bad)).toBeNull();
        }
    });
});

describe('resolveAuthFailureMessage', () => {
    it('passes through every message the auth flows actually emit', () => {
        for (const msg of AUTH_FAILURE_MESSAGES) {
            expect(resolveAuthFailureMessage(msg)).toBe(msg);
        }
    });

    it('replaces attacker-supplied free text with the generic message', () => {
        const injected = 'Your account is locked. Call 1-800-555-0100 to restore access.';
        const out = resolveAuthFailureMessage(injected);
        expect(out).not.toContain('1-800-555-0100');
        expect(out).toBe('Sign-in failed. Please try again.');
    });

    it('returns null when there is no error at all', () => {
        expect(resolveAuthFailureMessage(null)).toBeNull();
        expect(resolveAuthFailureMessage('')).toBeNull();
    });

    // Regression: the allowlist was built from the OIDC CALLBACK's messages only,
    // so the two the OIDC LOGIN route emits collapsed to "Sign-in failed. Please
    // try again." — which tells a rate-limited user to do the one thing that keeps
    // them rate-limited.
    it('passes through the messages /auth/oidc/login emits', () => {
        expect(resolveAuthFailureMessage('Too many attempts. Try again later.')).toBe(
            'Too many attempts. Try again later.',
        );
        expect(resolveAuthFailureMessage('Single sign-on is unavailable.')).toBe(
            'Single sign-on is unavailable.',
        );
    });

    // forward-auth.ts redirects with a CODE, not a sentence, for a locally
    // disabled account. It must resolve to the real explanation.
    it('resolves the forward-auth `account_disabled` wire code to its sentence', () => {
        expect(resolveAuthFailureMessage('account_disabled')).toBe('This account is disabled.');
    });

    it('still refuses codes it does not know', () => {
        expect(resolveAuthFailureMessage('account_pwned')).toBe(
            'Sign-in failed. Please try again.',
        );
    });

    // The code table must not be reachable through Object.prototype, or
    // `?error=constructor` renders a function body in the banner.
    it('does not resolve inherited object properties as messages', () => {
        for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            expect(resolveAuthFailureMessage(key)).toBe('Sign-in failed. Please try again.');
        }
    });
});

describe('formatAuthFailureBanner', () => {
    it('appends the reference to the message', () => {
        expect(formatAuthFailureBanner('This account is disabled.', 'a1b2c3d4')).toBe(
            'This account is disabled. (reference: a1b2c3d4)',
        );
    });

    it('omits a malformed reference rather than reflecting it', () => {
        expect(formatAuthFailureBanner('This account is disabled.', '<b>oops</b>')).toBe(
            'This account is disabled.',
        );
    });

    it('still shows the reference when the message itself was rejected', () => {
        expect(formatAuthFailureBanner('totally made up', 'deadbeef')).toBe(
            'Sign-in failed. Please try again. (reference: deadbeef)',
        );
    });

    it('renders nothing when there is no error', () => {
        expect(formatAuthFailureBanner(null, 'deadbeef')).toBeNull();
    });

    it('names the query parameter the callback uses', () => {
        expect(AUTH_FAILURE_REF_PARAM).toBe('ref');
    });
});

describe('formatAuthFailureReport', () => {
    it('contains the message, the reference and a grep command for the maintainer', () => {
        const out = formatAuthFailureReport({
            message: 'Sign-in is temporarily unavailable.',
            ref: 'a1b2c3d4',
            occurredAt: '2026-08-06T10:20:30.000Z',
            appVersion: '1.4.2',
        });
        expect(out).toContain('Sign-in is temporarily unavailable.');
        expect(out).toContain('a1b2c3d4');
        expect(out).toContain('2026-08-06T10:20:30.000Z');
        expect(out).toContain('1.4.2');
        expect(out).toMatch(/grep .*a1b2c3d4/);
    });

    it('omits the log-grep section when there is no reference', () => {
        const out = formatAuthFailureReport({
            message: 'Sign-in failed. Please try again.',
            ref: null,
            occurredAt: '2026-08-06T10:20:30.000Z',
        });
        expect(out).not.toContain('grep');
        expect(out).toContain('Sign-in failed. Please try again.');
    });

    it('never emits an unvetted message even if one is passed in', () => {
        const out = formatAuthFailureReport({
            message: 'Call 1-800-555-0100',
            ref: 'a1b2c3d4',
            occurredAt: '2026-08-06T10:20:30.000Z',
        });
        expect(out).not.toContain('1-800-555-0100');
    });

    // The only production caller is the /login banner, and /login is anonymous by
    // definition — +layout.server.ts blanks appVersion for anonymous sessions on
    // purpose. So the Version row must not silently vanish; it has to ASK for the
    // version instead, or every report reaches the maintainer without one.
    it('asks the reporter for the version when the page could not disclose it', () => {
        for (const missing of ['', '   ', null, undefined]) {
            const out = formatAuthFailureReport({
                message: 'Sign-in failed. Please try again.',
                ref: 'a1b2c3d4',
                occurredAt: '2026-08-06T10:20:30.000Z',
                appVersion: missing,
            });
            expect(out).toContain('| Version |');
            expect(out).toMatch(/version or image tag/i);
        }
    });

    it('prefers the real version over the prompt when one is available', () => {
        const out = formatAuthFailureReport({
            message: 'Sign-in failed. Please try again.',
            ref: 'a1b2c3d4',
            occurredAt: '2026-08-06T10:20:30.000Z',
            appVersion: '1.4.2',
        });
        expect(out).toContain('| Version | 1.4.2 |');
        expect(out).not.toMatch(/version or image tag/i);
    });

    it('strips credentials that rode along in the version string', () => {
        const out = formatAuthFailureReport({
            message: 'Sign-in failed. Please try again.',
            ref: 'a1b2c3d4',
            occurredAt: '2026-08-06T10:20:30.000Z',
            appVersion: '1.4.2 built from https://ci:hunter2@build.example.com',
        });
        expect(out).not.toContain('hunter2');
        expect(out).toContain('<redacted>');
    });
});
