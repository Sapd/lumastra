// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { searchQuerySchema, searchSuggestQuerySchema } from '$lib/schemas/browse.js';

describe('search query length', () => {
    it('rejects a q far longer than any real search', () => {
        expect(searchQuerySchema.safeParse({ q: 'a'.repeat(16_000) }).success).toBe(false);
        expect(searchSuggestQuerySchema.safeParse({ q: 'a'.repeat(16_000) }).success).toBe(false);
    });

    it('accepts an ordinary q', () => {
        expect(searchQuerySchema.safeParse({ q: 'moon tide s01e02' }).success).toBe(true);
        expect(searchSuggestQuerySchema.safeParse({ q: 'moon' }).success).toBe(true);
    });
});

/**
 * Enumerates every `q` / `query` / `search` string in the request schemas and
 * fails on one with no `.max(...)`. A search term is matched with regexes and
 * ILIKE, and a GET is not covered by the request-body cap, so a 16 KB term per
 * request is cheap to send and expensive to answer.
 */
const SRC_ROOT = path.resolve(__dirname, '../../..');
const SCANNED = ['lib/schemas', 'lib/server/api/defs', 'routes/api'];
const SEARCH_FIELD = /\b(?:q|query|search)\??\s*:\s*z\s*\.string\(\)/g;

/** Response (or non-request) fields that happen to share the name. */
const ALLOWED: Record<string, string> = {
    "lib/schemas/api-ai-responses.ts::query: z.string().describe('Query'),": 'response field',
    'lib/schemas/api-admin-unmatched-responses.ts::query: z.string(),': 'response field',
    'routes/api/ai/search-embeddings/+server.ts::query: z.string(),': 'response field',
};

function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sources(full));
        else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name))
            out.push(full);
    }
    return out;
}

/** The field's expression: from `z` to the first `,` outside any brackets. */
function expression(text: string, from: number): string {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) return text.slice(from, i);
            depth--;
        } else if (c === ',' && depth === 0) return text.slice(from, i);
    }
    return text.slice(from);
}

describe('every search term in a request schema has a max length', () => {
    it('has no unbounded q / query / search string', () => {
        const offenders: string[] = [];
        let seen = 0;
        for (const root of SCANNED) {
            for (const file of sources(path.join(SRC_ROOT, root))) {
                const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
                const text = fs.readFileSync(file, 'utf8');
                for (const match of text.matchAll(SEARCH_FIELD)) {
                    seen++;
                    const line = text.slice(0, match.index).split('\n').length;
                    const lineText = text.split('\n')[line - 1].trim();
                    if (ALLOWED[`${rel}::${lineText}`]) continue;
                    if (!/\.max\(/.test(expression(text, match.index + match[0].indexOf('z'))))
                        offenders.push(`${rel}:${line}  ${lineText}`);
                }
            }
        }
        expect(seen).toBeGreaterThan(10);
        expect(offenders).toEqual([]);
    });
});

describe('catalog series search name', () => {
    it('is capped in the request schema', async () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, 'defs/catalog/series/search.ts'),
            'utf8',
        );
        expect(source).toMatch(/name:\s*z\.string\(\)\.min\(1[^)]*\)\.max\(200\)/);
        // The handler reads the raw query string, so it must enforce the same cap.
        expect(source).toMatch(/nameRaw\.length > 200/);
    });
});
