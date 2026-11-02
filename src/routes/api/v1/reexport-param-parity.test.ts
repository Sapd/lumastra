// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard for v1 routes that re-export an internal handler with `export *`.
 *
 * SvelteKit binds path params by the name of the route that MOUNTS the handler,
 * not the one that defines it. So `/api/v1/playback/[id]/…` re-exporting
 * `/api/playback/[itemId]/…` runs that handler with `params.id` set and
 * `params.itemId` undefined. Anything reading the defining route's name — most
 * dangerously a Zod params schema that REQUIRES it — fails on every v1 request
 * while the internal route stays green.
 *
 * That is not hypothetical: `trickplayParamsSchema` required `itemId`, so
 * `GET /api/v1/playback/{id}/trickplay/{width}/manifest` 422'd on 100% of calls
 * and seek-preview thumbnails were silently dead for every native client, on
 * items with hundreds of tiles already generated. Clients swallow a failed
 * trickplay fetch, so it degraded to "no preview images" rather than an error
 * and went unreported.
 *
 * These re-exports are invisible to the def/route audits — they mount no def
 * and export no named handler — which is why they need their own check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { trickplayParamsSchema } from '$lib/schemas/playback';

const V1_ROOT = resolve(__dirname);
const ROUTES_ROOT = resolve(__dirname, '../../..'); // src/routes

/**
 * Re-exports whose param names legitimately differ. Each MUST say why the
 * mismatch is harmless — i.e. why nothing in the handler reads the defining
 * route's param name.
 */
const ALLOWED_MISMATCH: Record<string, string> = {
    'playback/[id]/trickplay/[width]': 'trickplayParamsSchema accepts id OR itemId (both optional)',
    'playback/[id]/trickplay/[width]/manifest':
        'trickplayParamsSchema accepts id OR itemId (both optional)',
    'playback/[id]/probe-status': 'no params validation; id comes from withIdResolution',
    'playback/[id]/file': 'no params validation; id comes from withIdResolution',
    'playback/[id]/chapter-image/[index]': 'no params validation; id comes from withIdResolution',
    'playback/[id]/subtitles/external/[subtitleId]':
        'no params validation; id comes from withIdResolution',
};

function collectServerFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collectServerFiles(full, acc);
        else if (entry.name === '+server.ts') acc.push(full);
    }
    return acc;
}

/** Ordered dynamic segment names in a route directory path, e.g. ['id','width']. */
function paramNames(routeDir: string): string[] {
    return routeDir
        .split('/')
        .filter((seg) => seg.startsWith('[') && seg.endsWith(']'))
        .map((seg) => seg.slice(1, -1).replace(/^\.\.\./, ''));
}

interface ReExport {
    /** v1 route dir, relative to src/routes/api/v1 */
    v1: string;
    /** target route dir, relative to src/routes */
    target: string;
    v1Params: string[];
    targetParams: string[];
}

function collectReExports(): ReExport[] {
    const out: ReExport[] = [];
    for (const file of collectServerFiles(V1_ROOT)) {
        const src = readFileSync(file, 'utf8');
        const match = src.match(/export\s+\*\s+from\s+['"]([^'"]+)['"]/);
        if (!match) continue;

        const v1Dir = relative(V1_ROOT, dirname(file));
        const targetFile = resolve(dirname(file), match[1]).replace(/\.js$/, '.ts');
        const targetDir = relative(ROUTES_ROOT, dirname(targetFile));

        out.push({
            v1: v1Dir,
            target: targetDir,
            v1Params: paramNames(v1Dir),
            targetParams: paramNames(targetDir),
        });
    }
    return out;
}

describe('v1 export-* re-exports: param-name parity', () => {
    const reExports = collectReExports();

    it('finds the re-export corpus', () => {
        // If discovery breaks, the guard silently passes.
        expect(reExports.length).toBeGreaterThan(0);
    });

    it('every param-name mismatch is known and justified', () => {
        const unexplained = reExports
            .filter((r) => r.v1Params.join(',') !== r.targetParams.join(','))
            .filter((r) => !ALLOWED_MISMATCH[r.v1])
            .map(
                (r) =>
                    `${r.v1} (binds ${r.v1Params.join('/')}) re-exports ${r.target} ` +
                    `(defined with ${r.targetParams.join('/')}) — the handler will read the ` +
                    `defining route's names and get undefined. Confirm nothing requires them, ` +
                    `then add it to ALLOWED_MISMATCH with a reason.`,
            );

        expect(unexplained, unexplained.join('\n')).toEqual([]);
    });

    it('keeps the allowlist honest', () => {
        // A stale entry would mask a real mismatch appearing later.
        const byV1 = new Map(reExports.map((r) => [r.v1, r]));
        for (const key of Object.keys(ALLOWED_MISMATCH)) {
            const entry = byV1.get(key);
            expect(entry, `ALLOWED_MISMATCH['${key}'] no longer matches a re-export`).toBeDefined();
            expect(
                entry!.v1Params.join(',') !== entry!.targetParams.join(','),
                `ALLOWED_MISMATCH['${key}'] no longer mismatches — remove the entry`,
            ).toBe(true);
        }
    });
});

describe('trickplayParamsSchema tolerates both mounts', () => {
    // Direct guard against re-tightening: the v1 route binds `id`, the internal
    // route binds `itemId`, and one shared handler serves both.
    it('accepts v1-shaped params (id)', () => {
        expect(trickplayParamsSchema.safeParse({ id: 'abc', width: '320' }).success).toBe(true);
    });

    it('accepts internal-shaped params (itemId)', () => {
        expect(trickplayParamsSchema.safeParse({ itemId: 'abc', width: '320' }).success).toBe(true);
    });

    it('still requires a usable width', () => {
        expect(trickplayParamsSchema.safeParse({ id: 'abc' }).success).toBe(false);
        expect(trickplayParamsSchema.safeParse({ id: 'abc', width: 'wide' }).success).toBe(false);
    });
});
