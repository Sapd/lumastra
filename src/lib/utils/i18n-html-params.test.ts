// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Some messages carry HTML (`<span class="…">{title}</span>`) and are rendered
 * as markup. Every `{param}` of such a message must be HTML-escaped at the call
 * site, or the parameter (a library title, a keyword) can inject markup. This
 * enumerates the HTML-bearing messages of every locale and scans the source for
 * their call sites, so a new HTML message or a new call site fails here.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const HTML_TAG = /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i;
const PARAM = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function loadHtmlMessages(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const locale of readdirSync(join(ROOT, 'messages')).filter((f) => f.endsWith('.json'))) {
        const catalog = JSON.parse(readFileSync(join(ROOT, 'messages', locale), 'utf8')) as Record<
            string,
            unknown
        >;
        for (const [key, value] of Object.entries(catalog)) {
            if (typeof value !== 'string' || !HTML_TAG.test(value)) continue;
            const params = [...value.matchAll(PARAM)].map((m) => m[1]);
            const known = out.get(key) ?? [];
            out.set(key, [...new Set([...known, ...params])]);
        }
    }
    return out;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === 'paraglide' || name === 'node_modules' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
    }
    return out;
}

/** Text between the parentheses of the call that starts at `open` (index of "("). */
function callArguments(text: string, open: number): string {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
}

describe('HTML-bearing i18n messages', () => {
    const htmlMessages = loadHtmlMessages();
    const sources = walk(join(ROOT, 'src')).map((f) => ({
        path: relative(ROOT, f),
        text: readFileSync(f, 'utf8'),
    }));

    it('exist (the scan is not vacuous)', () => {
        expect([...htmlMessages.keys()].sort()).toEqual([
            'livetv_admin_feed_invalid_xmltv',
            'section_because_you_watched',
            'section_you_like',
        ]);
    });

    it('escape every parameter at every call site', () => {
        const unescaped: string[] = [];
        let callSites = 0;
        for (const [key, params] of htmlMessages) {
            if (params.length === 0) continue;
            const call = new RegExp(`\\bm\\.${key}\\(`, 'g');
            for (const { path, text } of sources) {
                for (const hit of text.matchAll(call)) {
                    callSites++;
                    const args = callArguments(text, hit.index + hit[0].length - 1);
                    for (const param of params) {
                        const prop = new RegExp(`\\b${param}\\s*:\\s*([^,}]+)`).exec(args);
                        const expr = prop ? prop[1].trim() : '';
                        if (!expr.startsWith('escapeHtml(')) {
                            unescaped.push(
                                `${path}: m.${key}({ ${param}: ${expr || '<shorthand>'} })`,
                            );
                        }
                    }
                }
            }
        }
        expect(callSites).toBeGreaterThanOrEqual(3);
        expect(unescaped).toEqual([]);
    });
});
