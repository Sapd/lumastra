// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '' }));

import { buildSubtitleDescriptor } from './playback-timeline.service.js';

const ITEM = 'e4709bae-154e-4f17-8fcb-6b2efaba4294';
const FILE = 'aa703c4b-606b-4585-81c0-7a84499d7608';

/** Does an emitted `/api/...` path land on a SvelteKit route directory with a +server.ts? */
function routeExists(pathname: string): boolean {
    const routesRoot = resolve(process.cwd(), 'src/routes');
    const walk = (dir: string, rest: string[]): boolean => {
        if (rest.length === 0) return existsSync(resolve(dir, '+server.ts'));
        const [head, ...tail] = rest;
        const literal = resolve(dir, head);
        if (existsSync(literal) && walk(literal, tail)) return true;
        return readdirSync(dir, { withFileTypes: true }).some(
            (entry) =>
                entry.isDirectory() &&
                /^\[[^.\]]+\]$/.test(entry.name) &&
                walk(resolve(dir, entry.name), tail),
        );
    };
    return walk(routesRoot, pathname.split('/').filter(Boolean));
}

describe('subtitle hrefs point at a mounted route on both surfaces', () => {
    for (const surface of ['internal', 'v1'] as const) {
        it(`${surface}: embedded text track`, () => {
            const d = buildSubtitleDescriptor(
                ITEM,
                FILE,
                { index: 3, codec: 'subrip', language: 'eng', default: false, forced: false },
                undefined,
                surface,
            );
            expect(routeExists(new URL(d.hrefs.text!, 'http://x').pathname)).toBe(true);
        });
        it(`${surface}: sidecar index 1000`, () => {
            const d = buildSubtitleDescriptor(
                ITEM,
                FILE,
                { index: 1000, codec: 'srt', language: 'eng', default: false, forced: false },
                'sidecar-id',
                surface,
            );
            expect(routeExists(new URL(d.hrefs.text!, 'http://x').pathname)).toBe(true);
        });
    }
});
