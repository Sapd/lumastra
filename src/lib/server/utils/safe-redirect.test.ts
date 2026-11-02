// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { sanitizeRedirect } from './safe-redirect';

describe('sanitizeRedirect', () => {
    it('accepts a same-site absolute path', () => {
        expect(sanitizeRedirect('/admin/library')).toBe('/admin/library');
        expect(sanitizeRedirect('/foo?bar=1#x')).toBe('/foo?bar=1#x');
    });

    it('falls back for empty / nullish input', () => {
        expect(sanitizeRedirect('', '/home')).toBe('/home');
        expect(sanitizeRedirect(null, '/home')).toBe('/home');
        expect(sanitizeRedirect(undefined)).toBe('/');
    });

    it('rejects protocol-relative open redirects', () => {
        expect(sanitizeRedirect('//evil.com')).toBe('/');
        expect(sanitizeRedirect('/\\evil.com')).toBe('/');
    });

    it('rejects absolute URLs with a scheme', () => {
        expect(sanitizeRedirect('https://evil.com')).toBe('/');
        expect(sanitizeRedirect('http://evil.com/path')).toBe('/');
        expect(sanitizeRedirect('javascript:alert(1)')).toBe('/');
    });

    it('rejects a path that smuggles a scheme in the first segment', () => {
        expect(sanitizeRedirect('/http://evil.com')).toBe('/');
    });

    it('never bounces back into the auth surface', () => {
        expect(sanitizeRedirect('/login')).toBe('/');
        expect(sanitizeRedirect('/login?redirect=/x')).toBe('/');
        expect(sanitizeRedirect('/setup')).toBe('/');
    });

    it('rejects control-character smuggling that collapses to scheme-relative', () => {
        // Browsers strip TAB/LF/CR, turning "/\t/evil" into "//evil".
        expect(sanitizeRedirect('/\t/evil.com')).toBe('/');
        expect(sanitizeRedirect('/\n/evil.com')).toBe('/');
        expect(sanitizeRedirect('/\r/evil.com')).toBe('/');
        expect(sanitizeRedirect('\t//evil.com')).toBe('/');
    });

    it('confines to the same origin (rejects any host-bearing resolution)', () => {
        expect(sanitizeRedirect('/\\/evil.com')).toBe('/');
        expect(sanitizeRedirect('/%2F%2Fevil.com')).toBe('/%2F%2Fevil.com'); // encoded slashes stay on-path
        // A bare leading slash followed by a backslash-host is rejected by prefix.
        expect(sanitizeRedirect('/\\evil.com/path')).toBe('/');
    });
});
