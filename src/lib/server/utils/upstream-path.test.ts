// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { encodePathSegment, isSafePathSegment } from './upstream-path';

describe('encodePathSegment', () => {
    it('keeps ordinary ids unchanged', () => {
        expect(encodePathSegment('0a1b2c3d4e5f60718293a4b5c6d7e8f9')).toBe(
            '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
        );
        expect(encodePathSegment(42)).toBe('42');
    });

    it('escapes separators, query and fragment characters', () => {
        expect(encodePathSegment('a/b?c#d')).toBe('a%2Fb%3Fc%23d');
        expect(encodePathSegment('x/../../Users')).not.toContain('/');
    });

    it('refuses empty and dot segments', () => {
        for (const bad of ['', '.', '..']) {
            expect(isSafePathSegment(bad)).toBe(false);
            expect(() => encodePathSegment(bad)).toThrow();
        }
    });
});

// Source scan: every `${base}/path/${x}` template under src/lib/server that
// targets an integration must encode each path interpolation as one segment.
const ROOT = join(__dirname, '..');
// Any template whose first interpolation looks like a URL base (`base`,
// `baseUrl`, `basePath`, `FOO_URL`, `origin`) followed by `/`.
const BASE_EXPR = /^\s*\$\{[^}]*(base|url|origin)[^}]*\}\//i;

// Interpolations that are not request-controlled ids. Keyed `<file>::<expr>`;
// every entry says why it is safe.
const ALLOWED_EXPR = new Set<string>([
    // Fixed endpoint strings chosen by the calling code, never an id.
    'jellyseerr.ts::endpoint',
    'providers/implementations/musicbrainz/api-client.ts::endpoint',
    'providers/implementations/musicbrainz/lrclib.ts::endpoint',
    'tasks/builtin/native/providers/musicbrainz.ts::endpoint',
    'providers/implementations/musicbrainz/cover-art.ts::resourceType',
    'services/image-proxy/service.ts::typeConfig.endpoint',
    'services/mdblist-api.ts::mediaType',
    'audiobookshelf.ts::action',
    // Looked up from a fixed map / pre-built query string.
    'services/image-proxy/providers/jellyfin.provider.ts::jellyfinType',
    'services/image-proxy/providers/jellyfin.provider.ts::queryString',
    // Lumastra's own origin (HLS playlists handed to clients), not an upstream.
    'handlers/hls/lumastra-segment-handler.ts::apiPrefix',
    'handlers/hls/lumastra-segment-handler.ts::itemId',
    'utils/info.utils.ts::itemId',
]);

// Files whose `${base}/...` templates are NOT requests to an integration that
// carries a server credential: URLs Lumastra hands to its own clients (own
// origin), a filesystem path, or the credential-free TMDB image CDN.
const EXCLUDED_PREFIXES = [
    'api/defs/', // API payloads linking to Lumastra's own /media, /images routes
    'handlers/hls/', // HLS playlists served from Lumastra's own origin
    'services/hls/',
    'utils/hls-master-playlist.ts',
    'utils/synthetic-iframe.ts',
    'services/transcoding/gpu-identity.ts', // sysfs path, not a URL
    'providers/implementations/tmdb/client.ts', // public image CDN, no credential
];

// The module trees (jellyfin-compat and assistant, both under server/) are skipped, as before.
const MODULE_TREES = new Set(['jellyfin-compat', 'assistant']);

function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name === 'node_modules' || MODULE_TREES.has(relative(ROOT, p))) continue;
            walk(p, out);
        } else if (p.endsWith('.ts') && !/\.(test|spec|integration\.test)\.ts$/.test(p)) {
            out.push(p);
        }
    }
}

function interpolations(template: string): string[] {
    const exprs: string[] = [];
    for (let i = 0; i < template.length; i++) {
        if (template[i] === '$' && template[i + 1] === '{') {
            let depth = 1;
            let j = i + 2;
            while (j < template.length && depth > 0) {
                if (template[j] === '{') depth++;
                else if (template[j] === '}') depth--;
                j++;
            }
            exprs.push(template.slice(i + 2, j - 1).trim());
            i = j - 1;
        }
    }
    return exprs;
}

/** Template literals (single-level) starting with a base-URL interpolation + `/`. */
function findUnencodedUpstreamPaths(source: string, rel = ''): string[] {
    const hits: string[] = [];
    const re = /`([^`]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
        const body = m[1];
        if (!BASE_EXPR.test(body)) continue;
        // Path portion only: stop at the first literal `?`.
        const afterBase = body.replace(/^\s*\$\{[^}]*\}/, '');
        const q = afterBase.indexOf('?');
        const pathPart = q === -1 ? afterBase : afterBase.slice(0, q);
        for (const expr of interpolations(pathPart)) {
            // A bare encodeURIComponent leaves `.`/`..` intact, which the URL parser
            // collapses; only encodePathSegment refuses them.
            if (/^encodePathSegment\(/.test(expr)) continue;
            if (ALLOWED_EXPR.has(`${rel}::${expr}`)) continue;
            hits.push(`${body.trim()}  [unencoded: ${expr}]`);
        }
    }
    return hits;
}

describe('upstream integration URLs encode every path segment', () => {
    it('detector flags a raw interpolation (self-check)', () => {
        expect(
            findUnencodedUpstreamPaths('x(`${this.baseUrl}/api/items/${id}/cover`)'),
        ).toHaveLength(1);
        expect(
            findUnencodedUpstreamPaths(
                'x(`${this.baseUrl}/api/items/${encodePathSegment(id)}/cover`)',
            ),
        ).toHaveLength(0);
        expect(
            findUnencodedUpstreamPaths('x(`${this.baseUrl}/api/items/${encodeURI(id)}/cover`)'),
        ).toHaveLength(1);
        expect(
            findUnencodedUpstreamPaths('x(`${base}/Items/${encodeURIComponent(id)}`)'),
        ).toHaveLength(1);
        // query values may use encodeURIComponent
        expect(
            findUnencodedUpstreamPaths('x(`${base}/search?q=${encodeURIComponent(q)}`)'),
        ).toHaveLength(0);
    });

    it('has no unencoded path interpolation under src/lib/server', () => {
        const files: string[] = [];
        walk(ROOT, files);
        const offenders: string[] = [];
        for (const f of files) {
            const rel = relative(ROOT, f);
            if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
            for (const h of findUnencodedUpstreamPaths(
                readFileSync(f, 'utf8'),
                relative(ROOT, f),
            )) {
                offenders.push(`${relative(ROOT, f)}: ${h}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
