// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    collectAllowedOrigins,
    configuredEmbedOrigins,
    resolveAllowedEmbedUrl,
} from './embed-allowlist';

describe('collectAllowedOrigins', () => {
    it('collects origins from external http(s) links across lists', () => {
        const origins = collectAllowedOrigins(
            [{ url: 'https://game.example.com/', external: true }],
            [{ url: 'https://books.example.com', external: true }],
            [{ url: 'http://wiki.example.com/login', external: true }],
        );
        expect(origins).toEqual(
            new Set([
                'https://game.example.com',
                'https://books.example.com',
                'http://wiki.example.com',
            ]),
        );
    });

    it('ignores internal links (external !== true)', () => {
        const origins = collectAllowedOrigins([
            { url: 'https://internal.example.com', external: false },
            { url: 'https://nope.example.com' }, // external undefined
        ]);
        expect(origins.size).toBe(0);
    });

    it('skips relative, empty, and non-http(s) URLs', () => {
        const origins = collectAllowedOrigins([
            { url: '/dashboard', external: true },
            { url: '', external: true },
            { url: 'javascript:alert(1)', external: true },
            { url: 'ftp://files.example.com', external: true },
        ]);
        expect(origins.size).toBe(0);
    });

    it('tolerates undefined / non-array lists', () => {
        expect(
            collectAllowedOrigins(undefined, [{ url: 'https://ok.cc', external: true }]).size,
        ).toBe(1);
    });
});

describe('resolveAllowedEmbedUrl', () => {
    const allowed = new Set(['https://game.example.com', 'https://books.example.com']);

    it('allows an exact configured origin', () => {
        expect(resolveAllowedEmbedUrl('https://game.example.com/', allowed)).toBe(
            'https://game.example.com/',
        );
    });

    it('allows sub-paths within an allowed origin', () => {
        expect(resolveAllowedEmbedUrl('https://game.example.com/server/abc?x=1', allowed)).toBe(
            'https://game.example.com/server/abc?x=1',
        );
    });

    it('rejects an unconfigured host (open-framing attempt)', () => {
        expect(resolveAllowedEmbedUrl('https://evil.example/', allowed)).toBeNull();
    });

    it('rejects a different scheme on an allowed host (origin includes scheme)', () => {
        expect(resolveAllowedEmbedUrl('http://game.example.com/', allowed)).toBeNull();
    });

    it('rejects a different port on an allowed host', () => {
        expect(resolveAllowedEmbedUrl('https://game.example.com:8443/', allowed)).toBeNull();
    });

    it('rejects non-http(s) schemes', () => {
        expect(resolveAllowedEmbedUrl('javascript:alert(1)', allowed)).toBeNull();
        expect(resolveAllowedEmbedUrl('data:text/html,<h1>x', allowed)).toBeNull();
    });

    it('rejects unparseable input', () => {
        expect(resolveAllowedEmbedUrl('not a url', allowed)).toBeNull();
    });

    it('is not fooled by a userinfo @ trick', () => {
        // Parses as origin https://evil.example (game.example.com is userinfo) -> rejected
        expect(
            resolveAllowedEmbedUrl('https://game.example.com@evil.example/', allowed),
        ).toBeNull();
    });
});

describe('configuredEmbedOrigins', () => {
    it('reads the sidebar, user-menu and footer lists', () => {
        const lists: Record<string, unknown> = {
            SIDEBAR_LINKS: [{ url: 'https://a.example.com/x', external: true }],
            USER_MENU_LINKS: [{ url: 'https://b.example.com', external: true }],
            FOOTER_LINKS: [{ url: 'https://c.example.com', external: true }],
        };
        const origins = configuredEmbedOrigins(
            (key) => lists[key] as Parameters<typeof collectAllowedOrigins>[0],
        );
        expect([...origins].sort()).toEqual([
            'https://a.example.com',
            'https://b.example.com',
            'https://c.example.com',
        ]);
    });
});
