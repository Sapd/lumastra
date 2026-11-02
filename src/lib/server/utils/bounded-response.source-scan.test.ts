// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Enumerates every read of an outgoing fetch's body in the trees that fetch
 * URLs an attacker can influence (a playlist or guide host, a station's
 * now-playing metadata, a logo URL named by an M3U) and fails when one does not
 * go through `bounded-response.ts`. `await res.arrayBuffer()`, `.text()`,
 * `.json()` and a bare `gunzip` buffer whatever the remote sends, and undici
 * inflates `Content-Encoding` first.
 *
 * A site that talks to a first-party fixed host or an admin-configured media
 * server may stay unbounded, but only by an entry below that says why. A new
 * unbounded read in one of these trees fails here until it is either bounded or
 * listed with a reason.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_ROOT = path.resolve(__dirname, '..');

const SCANNED_TREES = [
    'services/livetv',
    'services/radio-metadata',
    'services/image-proxy',
    'tasks',
    'api/defs/webhooks',
    'providers/implementations',
    'utils',
];

/** `.arrayBuffer()` / `.text()` / `.json()` / `.blob()` on anything, or a gunzip call. */
const UNBOUNDED_READ = /\.(?:arrayBuffer|text|json|blob)\(\s*\)|\bgunzip(?!Bounded)\w*\(/;

/** Whole files whose fetches go to a fixed first-party host or an admin-configured server. */
const ALLOWED_FILES: Record<string, string> = {
    'services/livetv/stream-proxy-client.ts':
        "Lumastra's own stream-proxy sidecar at an operator-configured internal URL, not a provider",
    'services/image-proxy/logo-legibility.ts': 'fixed host image.tmdb.org, a w92 thumbnail',
    'services/image-proxy/providers/tmdb.provider.ts':
        'fixed hosts api.themoviedb.org / image.tmdb.org',
    'services/image-proxy/providers/jellyfin.provider.ts':
        'the admin-configured Jellyfin server (its own review group)',
    'services/image-proxy/providers/audiobookshelf.provider.ts':
        'the admin-configured Audiobookshelf server (its own review group)',
    'tasks/builtin/native/providers/tmdb.ts': 'fixed host api.themoviedb.org',
    'tasks/builtin/native/providers/mdblist.ts': 'fixed host mdblist.com',
    'tasks/rate-limiter.ts': 'clones the OUTGOING request body to replay it on retry',
    'utils/fetch-utils.ts':
        'generic fetch helper whose callers pick first-party or admin-configured hosts; also clones the outgoing request body',
    'utils/bounded-body-reader.ts':
        'the request-side reader: rebuilds a Response from bytes it already capped',
    'utils/bounded-response.ts': 'the bounded helper itself (gunzip with maxOutputLength)',
    'tasks/builtin/native/sonic-map-projection.ts': "Lumastra's own sonic-embedder sidecar",
    'tasks/builtin/native/sonic-clustering.ts': "Lumastra's own sonic-embedder sidecar",
    'tasks/builtin/native/fribb-anime-sync.ts': 'fixed first-party list host',
    'tasks/builtin/native/tmdb-metadata-sync.ts': 'fixed host api.themoviedb.org',
    'tasks/builtin/native/mal-anime-id-enrichment.ts': 'fixed host api.myanimelist.net',
    'tasks/builtin/native/integrations/jellyseerr.ts':
        'the admin-configured Jellyseerr; only an error text',
    'tasks/builtin/native/integrations/_arr-shared.ts':
        'the admin-configured Sonarr/Radarr; only an error text',
    'api/defs/webhooks/[id].ts': 'the incoming request body (size-bounded by the route layer)',
    'api/defs/webhooks/index.ts': 'the incoming request body (size-bounded by the route layer)',
    'providers/implementations/musicbrainz/acoustid.ts': 'fixed host api.acoustid.org',
    'providers/implementations/musicbrainz/lrclib.ts': 'fixed host lrclib.net',
    'providers/implementations/musicbrainz/api-client.ts': 'fixed host musicbrainz.org',
    'providers/implementations/tmdb/client.ts': 'fixed host api.themoviedb.org',
    'tasks/builtin/native/providers/jellyfin.ts':
        'the admin-configured Jellyfin server (its own review group)',
};

/**
 * Single lines of mixed files: `file::trimmed line` -> [expected occurrences, reason].
 * image-proxy/service.ts mixes sources the review treats separately; the
 * provider-chosen logo and radio-art URLs in it are bounded and not listed.
 */
const SERVICE = 'services/image-proxy/service.ts';
const ALLOWED_LINES: Record<string, [number, string]> = {
    [`${SERVICE}::buffer = Buffer.from(await result.clone().arrayBuffer());`]: [
        1,
        'clone of a Response utils/image-proxy.ts already read through the bounded reader',
    ],
};

interface Hit {
    file: string;
    line: number;
    text: string;
}

function listSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'fixtures') continue;
            out.push(...listSources(full));
        } else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function scan(): Hit[] {
    const hits: Hit[] = [];
    for (const tree of SCANNED_TREES) {
        for (const file of listSources(path.join(SERVER_ROOT, tree))) {
            const rel = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
            fs.readFileSync(file, 'utf8')
                .split('\n')
                .forEach((raw, i) => {
                    const text = raw.trim();
                    if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*'))
                        return;
                    if (/^import\b/.test(text)) return;
                    if (UNBOUNDED_READ.test(text)) hits.push({ file: rel, line: i + 1, text });
                });
        }
    }
    return hits;
}

describe('outgoing response bodies are read through bounded-response.ts', () => {
    const hits = scan();

    it('scans something', () => {
        expect(SCANNED_TREES.every((t) => fs.existsSync(path.join(SERVER_ROOT, t)))).toBe(true);
        expect(hits.length).toBeGreaterThan(0);
    });

    it('has no unbounded read outside the documented allowlist', () => {
        const lineCounts = new Map<string, number>();
        const offenders: string[] = [];
        for (const hit of hits) {
            if (ALLOWED_FILES[hit.file]) continue;
            const key = `${hit.file}::${hit.text}`;
            if (ALLOWED_LINES[key]) {
                lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
                continue;
            }
            offenders.push(`${hit.file}:${hit.line}  ${hit.text}`);
        }
        expect(offenders).toEqual([]);
        for (const [key, [expected]] of Object.entries(ALLOWED_LINES)) {
            expect(lineCounts.get(key) ?? 0, `allowlist entry ${key}`).toBe(expected);
        }
    });

    it('keeps no stale file allowlist entry', () => {
        const hitFiles = new Set(hits.map((h) => h.file));
        const stale = Object.keys(ALLOWED_FILES).filter((f) => !hitFiles.has(f));
        expect(stale).toEqual([]);
    });
});
