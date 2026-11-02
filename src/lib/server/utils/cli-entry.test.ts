// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isCliEntry } from './cli-entry';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir: string, out: string[]): string[] {
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
            if (name === 'node_modules' || name === '__fixtures__') continue;
            walk(full, out);
        } else if (/\.(ts|js|mjs)$/.test(name) && !/\.test\.|\.spec\./.test(name)) {
            out.push(full);
        }
    }
    return out;
}

describe('isCliEntry', () => {
    const prev = process.env.LUMASTRA_CLI;
    afterEach(() => {
        if (prev === undefined) delete process.env.LUMASTRA_CLI;
        else process.env.LUMASTRA_CLI = prev;
    });

    it('is true only for the named script', () => {
        process.env.LUMASTRA_CLI = 'sync-tmdb-metadata';
        expect(isCliEntry('sync-tmdb-metadata')).toBe(true);
        expect(isCliEntry('sync-mdblist')).toBe(false);
    });

    it('is false when LUMASTRA_CLI is unset', () => {
        delete process.env.LUMASTRA_CLI;
        expect(isCliEntry('sync-tmdb-metadata')).toBe(false);
    });
});

describe('no argv[1] CLI guards under src/', () => {
    // The idiom is TRUE inside the worker-isolation bundle (a Worker's argv[1]
    // is the bundle itself), so a guarded CLI block runs — and process.exit()s
    // — in every isolated task run. See cli-entry.ts.
    it('no source file compares import.meta.url with process.argv[1]', () => {
        const offenders = walk(SRC_ROOT, []).filter((file) => {
            const src = readFileSync(file, 'utf8');
            return /import\.meta\.url\s*===?\s*`file:\/\/\$\{process\.argv\[1\]\}`/.test(src);
        });
        expect(offenders.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
    });
});
