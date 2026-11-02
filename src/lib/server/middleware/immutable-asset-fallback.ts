// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fallback handle serving hashed client assets from PREVIOUS builds.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The container is recreated on every deploy (adapter-node's stock `node build`
 * server, fronted by sirv). sirv only serves files that exist in the CURRENT
 * `build/client` directory; a browser tab left open across a deploy will still
 * request the OLD build's hashed `/_app/immutable/...` chunks (e.g. for a
 * client-side navigation's lazy-loaded route), and sirv 404s them because they
 * no longer exist on disk — breaking the already-open tab.
 *
 * `start.sh` archives each build's `_app/immutable` assets into a persistent
 * `ASSET_HISTORY_DIR` (mounted outside the container's ephemeral filesystem)
 * before starting the new build. This handle serves from that history dir
 * whenever sirv has already fallen through to the SvelteKit hooks (i.e. the
 * file wasn't found in the current build), so stale tabs keep working until
 * they reload.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Handle } from '@sveltejs/kit';
import { base } from '$app/paths';

const IMMUTABLE_PREFIX = `${base}/_app/immutable/`;

const CONTENT_TYPES: Record<string, string> = {
    js: 'text/javascript',
    mjs: 'text/javascript',
    css: 'text/css',
    map: 'application/json',
    json: 'application/json',
    wasm: 'application/wasm',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    svg: 'image/svg+xml',
    png: 'image/png',
    webp: 'image/webp',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    avif: 'image/avif',
};

function contentTypeFor(pathname: string): string {
    const ext = path.extname(pathname).slice(1).toLowerCase();
    return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Resolve a request suffix (the part of the pathname after `/_app/immutable/`)
 * against the asset history directory. Returns the resolved absolute path, or
 * `null` if the suffix is malformed or would escape `dir` (path traversal).
 * Exported for unit testing.
 */
export function resolveHistoryPath(dir: string, suffix: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(suffix);
    } catch {
        return null;
    }
    if (decoded.includes('\0')) return null;

    const baseDir = path.resolve(dir);
    const resolved = path.resolve(baseDir, decoded);
    if (!resolved.startsWith(baseDir + path.sep)) return null;

    return resolved;
}

/**
 * Serves hashed client assets from previous builds when the current build (and
 * sirv) has already 404'd the request. Must be placed after the assets are
 * otherwise resolved — i.e. it only ever runs when sirv found nothing.
 */
export const immutableAssetFallbackHandle: Handle = async ({ event, resolve }) => {
    const { request, url } = event;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return resolve(event);
    }

    if (!url.pathname.startsWith(IMMUTABLE_PREFIX)) {
        return resolve(event);
    }

    const suffix = url.pathname.slice(IMMUTABLE_PREFIX.length);
    const historyDir = process.env.ASSET_HISTORY_DIR ?? '/config/asset-history';
    const resolved = resolveHistoryPath(historyDir, suffix);
    if (!resolved) {
        return resolve(event);
    }

    let data: Buffer;
    try {
        data = await readFile(resolved);
    } catch {
        return resolve(event);
    }

    const headers = new Headers({
        'Content-Type': contentTypeFor(resolved),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'x-asset-history': '1',
    });

    if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
    }

    return new Response(data as Uint8Array<ArrayBuffer>, { status: 200, headers });
};
