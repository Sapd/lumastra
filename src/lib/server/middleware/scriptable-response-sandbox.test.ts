// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resizeForPreset, transcodeToFormat } from '$lib/server/utils/image-proxy';
import {
    FIRST_PARTY_HTML_ENDPOINT_ROUTES,
    SCRIPTABLE_RESPONSE_CSP,
    isInertContentType,
    sandboxScriptableResponse,
} from './scriptable-response-sandbox';

// Artwork bytes come from library files, embedded cover tags and remote URLs
// (M3U logos, provider posters). An SVG that sharp cannot rasterise is served
// back unchanged and labelled image/svg+xml, so opening the image URL as a page
// would run its script on our origin unless the response is sandboxed.
const HOSTILE_SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>',
);

describe('image pipeline passes an unrasterisable SVG through', () => {
    it('resizeForPreset returns the original SVG bytes', async () => {
        const out = await resizeForPreset(HOSTILE_SVG, 'image/svg+xml', 'thumb', 'webp');
        expect(out.contentType).toBe('image/svg+xml');
        expect(out.buffer.equals(HOSTILE_SVG)).toBe(true);
    });

    it('transcodeToFormat returns the original SVG bytes', async () => {
        const out = await transcodeToFormat(HOSTILE_SVG, 'image/svg+xml', 'jpeg');
        expect(out.contentType).toBe('image/svg+xml');
    });
});

function endpoint(contentType: string | null, extra: Record<string, string> = {}): Response {
    const headers = new Headers(extra);
    if (contentType !== null) headers.set('Content-Type', contentType);
    return new Response('x', { headers });
}

// Any route id: the guard must not depend on which endpoint produced the bytes.
const SOME_ROUTES = [
    '/(modules)/j/Videos/[itemId]/[mediaSourceId]/Attachments/[index]',
    '/api/image/[id]/[type]',
    '/api/v1/media/[id]/images/[role]',
    '/subsonic/rest/[method]',
    null,
];

// Values an attacker can put in a file's mimetype tag or a provider header.
const EXECUTABLE = [
    'text/html',
    'TEXT/HTML; charset=utf-8',
    'text/html;',
    ' text/html',
    'image/svg+xml',
    'application/xhtml+xml',
    'application/xml',
    'text/xml',
    'application/rss+xml',
    'application/dash+xml',
    'text/xsl',
    'application/x-shockwave-flash',
    'message/rfc822',
    'application/vnd.unknown-thing',
    'x/y',
];

const INERT = [
    'image/webp',
    'image/jpeg',
    'image/png',
    'image/avif',
    'image/gif',
    'application/json',
    'application/problem+json',
    'application/vnd.apple.mpegurl',
    'video/mp2t',
    'video/mp4',
    'audio/mpeg',
    'font/woff2',
    'text/plain; charset=utf-8',
    'text/vtt',
    'text/event-stream',
    'application/octet-stream',
];

describe('sandboxScriptableResponse', () => {
    for (const routeId of SOME_ROUTES) {
        it.each(EXECUTABLE)(`sandboxes %s (route ${routeId})`, (ctype) => {
            expect(isInertContentType(ctype)).toBe(false);
            const res = endpoint(ctype);
            sandboxScriptableResponse(res, routeId, false);
            expect(res.headers.get('Content-Security-Policy')).toBe(SCRIPTABLE_RESPONSE_CSP);
            expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        });
    }

    it.each(INERT)('leaves %s alone', (ctype) => {
        expect(isInertContentType(ctype)).toBe(true);
        const res = endpoint(ctype);
        sandboxScriptableResponse(res, '/api/image/[id]/[type]', false);
        expect(res.headers.get('Content-Security-Policy')).toBeNull();
    });

    it('sandboxes a body with no Content-Type (the browser would sniff it)', () => {
        const res = new Response(new Uint8Array([60, 104, 49, 62]));
        expect(res.headers.has('Content-Type')).toBe(false);
        sandboxScriptableResponse(res, '/api/x', false);
        expect(res.headers.get('Content-Security-Policy')).toBe(SCRIPTABLE_RESPONSE_CSP);
    });

    it('leaves a bodiless response alone', () => {
        const res = new Response(null, { status: 304 });
        sandboxScriptableResponse(res, '/api/x', false);
        expect(res.headers.get('Content-Security-Policy')).toBeNull();
    });

    it('replaces a weaker route-set CSP on an executable response', () => {
        const res = endpoint('image/svg+xml', { 'Content-Security-Policy': "default-src 'none'" });
        sandboxScriptableResponse(res, '/api/users/[id]/images/[role]', false);
        expect(res.headers.get('Content-Security-Policy')).toBe(SCRIPTABLE_RESPONSE_CSP);
    });

    it('leaves SvelteKit-rendered pages to the document CSP', () => {
        const res = endpoint('text/html');
        sandboxScriptableResponse(res, '/admin', true);
        expect(res.headers.get('Content-Security-Policy')).toBeNull();
    });

    it('an x-sveltekit-page header on an endpoint response does not exempt it', () => {
        // An endpoint that copies an upstream response's headers could carry it.
        const res = endpoint('text/html', { 'x-sveltekit-page': 'true' });
        sandboxScriptableResponse(res, '/api/x', false);
        expect(res.headers.get('Content-Security-Policy')).toBe(SCRIPTABLE_RESPONSE_CSP);
    });

    it.each([...FIRST_PARTY_HTML_ENDPOINT_ROUTES])(
        'exempts the reviewed first-party HTML endpoint %s',
        (routeId) => {
            const res = endpoint('text/html');
            sandboxScriptableResponse(res, routeId, false);
            expect(res.headers.get('Content-Security-Policy')).toBeNull();
        },
    );

    it('policy sandboxes and blocks script', () => {
        expect(SCRIPTABLE_RESPONSE_CSP).toMatch(/(^|; )sandbox(;|$)/);
        expect(SCRIPTABLE_RESPONSE_CSP).toContain("default-src 'none'");
        expect(SCRIPTABLE_RESPONSE_CSP).not.toMatch(/script-src/);
    });
});

const ROUTES_DIR = new URL('../../../routes/', import.meta.url).pathname;

function serverFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return serverFiles(p);
        return name === '+server.ts' || name === '+server.js' ? [p] : [];
    });
}

function routeIdOf(file: string): string {
    return `/${relative(ROUTES_DIR, file).split(sep).slice(0, -1).join('/')}`;
}

describe('first-party HTML endpoint allowlist', () => {
    // Every +server.ts that emits text/html itself, or re-exports a handler
    // from one that does, is either on the reviewed list (and needs its script)
    // or gets sandboxed like any other endpoint. A new HTML endpoint fails here
    // until someone decides which.
    it('names exactly the endpoints that serve text/html', () => {
        const emitsHtml = (file: string, depth = 0): boolean => {
            const src = readFileSync(file, 'utf8');
            if (/['"`]text\/html/.test(src)) return true;
            if (depth > 3) return false;
            return [...src.matchAll(/from\s+['"](\.[^'"]*\+server(?:\.[jt]s)?)['"]/g)].some((m) => {
                const target = join(file, '..', m[1].replace(/(\.[jt]s)?$/, '.ts'));
                return emitsHtml(target, depth + 1);
            });
        };
        const htmlEndpoints = serverFiles(ROUTES_DIR)
            .filter((f) => emitsHtml(f))
            .map(routeIdOf)
            .sort();
        expect(htmlEndpoints).toEqual([...FIRST_PARTY_HTML_ENDPOINT_ROUTES].sort());
    });
});

describe('hooks.server.ts applies the sandbox before every early return', () => {
    // The image branch and the bypass-path branch return the response early
    // without the document CSP. The guard must run right after resolve(),
    // ahead of all of them, so no branch can skip it.
    it('sandboxScriptableResponse runs before the first return after resolve()', () => {
        const src = readFileSync(new URL('../../../hooks.server.ts', import.meta.url), 'utf8');
        const resolveAt = src.indexOf('const response = await resolve(event, {');
        expect(resolveAt).toBeGreaterThan(-1);
        const guardAt = src.indexOf(
            'sandboxScriptableResponse(response, event.route.id, renderedPage);',
            resolveAt,
        );
        // A statement after the resolve() call (not the transformPageChunk
        // callback's own return, and not the word in a comment).
        const afterCall = src.indexOf('});', resolveAt) + 3;
        const firstReturnAt = afterCall + src.slice(afterCall).search(/^\s*return\b/m);
        expect(guardAt).toBeGreaterThan(resolveAt);
        expect(guardAt).toBeLessThan(firstReturnAt);
    });
});

describe('hooks.server.ts marks rendered pages', () => {
    it('sets renderedPage only inside transformPageChunk', () => {
        const src = readFileSync(new URL('../../../hooks.server.ts', import.meta.url), 'utf8');
        const at = src.indexOf('const response = await resolve(event, {');
        const call = src.slice(at, src.indexOf('});', at));
        expect(call).toMatch(
            /transformPageChunk:\s*\(\{ html \}\)\s*=>\s*\{\s*renderedPage = true;/,
        );
        expect(src.match(/renderedPage = true/g)).toHaveLength(1);
    });
});
