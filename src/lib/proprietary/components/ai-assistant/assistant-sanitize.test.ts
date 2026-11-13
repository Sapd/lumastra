// @vitest-environment happy-dom
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The assistant sanitiser's vocabulary rules, run against real parsed DOM.
 *
 * happy-dom cannot host DOMPurify itself (it drops every allowed tag), so the
 * DOMPurify pass is covered by its config here and the post-pass hook, which
 * carries the rules that matter, is run directly on the elements a browser
 * would hand it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdownLinks } from '$lib/utils/assistant-utils';
import {
    ASSISTANT_DATA_ATTRS,
    ASSISTANT_PURIFY_CONFIG,
    enforceAssistantVocabulary,
    assistantHtmlToSafeText,
} from './assistant-sanitize';

function parse(html: string): HTMLDivElement {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
}

function enforce(html: string): HTMLDivElement {
    const root = parse(html);
    for (const el of root.querySelectorAll('*')) enforceAssistantVocabulary(el);
    return root;
}

describe('ASSISTANT_PURIFY_CONFIG', () => {
    it('allows no free data-* and lists exactly the attributes the click handler reads', () => {
        expect(ASSISTANT_PURIFY_CONFIG.ALLOW_DATA_ATTR).toBe(false);
        const dataAttrs = ASSISTANT_PURIFY_CONFIG.ALLOWED_ATTR.filter((a) => a.startsWith('data-'));
        expect(dataAttrs.sort()).toEqual([...ASSISTANT_DATA_ATTRS].sort());
        const handler = readFileSync(join(__dirname, 'AssistantMessage.svelte'), 'utf8');
        const read = [...handler.matchAll(/dataset\.(\w+)/g)].map(
            (m) => 'data-' + m[1].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()),
        );
        for (const attr of read) expect(ASSISTANT_DATA_ATTRS).toContain(attr);
    });

    it('does not rely on DOMPurify for target/rel (the hook sets them)', () => {
        expect(ASSISTANT_PURIFY_CONFIG.ALLOWED_ATTR).not.toContain('target');
        expect(ASSISTANT_PURIFY_CONFIG.ALLOWED_ATTR).not.toContain('rel');
    });
});

describe('enforceAssistantVocabulary', () => {
    it('forces target=_blank rel=noopener on external links', () => {
        const a = enforce(
            '<a href="https://example.com/x" class="text-primary-400 hover:text-primary-300 underline">x</a>',
        ).querySelector('a')!;
        expect(a.getAttribute('target')).toBe('_blank');
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('drops a class the renderer did not emit', () => {
        const a = enforce(
            '<a href="https://e.test" class="fixed inset-0 z-50 opacity-0">x</a>',
        ).querySelector('a')!;
        expect(a.hasAttribute('class')).toBe(false);
    });

    it('drops data-* hooks from an external link (no forged internal link)', () => {
        const a = enforce(
            '<a href="https://e.test" data-internal-link="jellyfin" data-jellyfin-id="abc">x</a>',
        ).querySelector('a')!;
        // `data-internal-link` makes it an internal link: inert href, valid id kept.
        expect(a.getAttribute('href')).toBe('#');
        expect(a.hasAttribute('target')).toBe(false);
        const b = enforce('<a href="https://e.test" data-jellyfin-id="abc">x</a>').querySelector(
            'a',
        )!;
        expect(b.hasAttribute('data-jellyfin-id')).toBe(false);
        expect(b.getAttribute('target')).toBe('_blank');
    });

    it('drops data-* values outside their grammar', () => {
        const a = enforce(
            '<a href="#" data-internal-link="jellyseerr" data-external-id="12x" data-media-type="person" data-external-provider="evil">x</a>',
        ).querySelector('a')!;
        expect(a.getAttribute('data-internal-link')).toBe('jellyseerr');
        expect(a.hasAttribute('data-external-id')).toBe(false);
        expect(a.hasAttribute('data-media-type')).toBe(false);
        expect(a.hasAttribute('data-external-provider')).toBe(false);
    });

    it('removes non-http(s) hrefs', () => {
        for (const href of [
            'javascript:alert(1)',
            'data:text/html,x',
            '//evil.example',
            '/\\evil.example',
        ]) {
            const a = enforce(`<a href="${href}">x</a>`).querySelector('a')!;
            expect(a.hasAttribute('href'), href).toBe(false);
        }
    });

    it('keeps a same-origin path link, opened in a new tab', () => {
        const a = enforce('<a href="/browse?q=x">x</a>').querySelector('a')!;
        expect(a.getAttribute('href')).toBe('/browse?q=x');
        expect(a.getAttribute('target')).toBe('_blank');
    });

    it('strips class, href and data-* from non-anchor elements', () => {
        const span = enforce(
            '<span class="fixed inset-0" href="https://e.test" data-ref="1">x</span>',
        ).querySelector('span')!;
        expect(span.attributes.length).toBe(0);
    });
});

describe('parseMarkdownLinks + enforceAssistantVocabulary', () => {
    const ATTACKS = [
        '[a](https://evil.example/" class="fixed inset-0 z-50 opacity-0 cursor-pointer" data-x="1)',
        '[a](https://evil.example/" data-internal-link="jellyfin" data-jellyfin-id="abc)',
        '[a](https://a.test"><span class="fixed inset-0 z-50">Session expired</span>)',
        '[a](ref:1:movie" data-internal-link="jellyfin)',
        '[a](javascript:alert(1))',
    ];
    for (const attack of ATTACKS) {
        it(`leaves only vocabulary attributes for ${attack.slice(0, 50)}`, () => {
            const root = enforce(parseMarkdownLinks(attack));
            for (const el of root.querySelectorAll('*')) {
                for (const attr of Array.from(el.attributes)) {
                    const ok =
                        ['href', 'class', 'target', 'rel'].includes(attr.name) ||
                        (ASSISTANT_DATA_ATTRS as readonly string[]).includes(attr.name);
                    expect(ok, attr.name).toBe(true);
                }
                if (el.hasAttribute('class')) {
                    expect(el.getAttribute('class')).toMatch(
                        /^text-primary-400 hover:text-primary-300 underline/,
                    );
                }
            }
        });
    }
});

describe('every assistant component that renders raw HTML goes through the sanitiser', () => {
    it('imports sanitizeAssistantHtml and never DOMPurify directly', () => {
        for (const name of readdirSync(__dirname).filter((f) => f.endsWith('.svelte'))) {
            const text = readFileSync(join(__dirname, name), 'utf8');
            if (!/\{@html|innerHTML/.test(text)) continue;
            expect(text, name).toContain('sanitizeAssistantHtml');
            expect(text, name).not.toMatch(/from 'dompurify'/);
        }
    });
});

describe('assistantHtmlToSafeText (no-DOM fallback)', () => {
    it('drops generated tags and keeps the escaped text', () => {
        expect(assistantHtmlToSafeText('a &lt;b&gt;<br><strong>x</strong> <a href="#">y</a>')).toBe(
            'a &lt;b&gt; x y',
        );
    });

    it('never leaves a raw angle bracket', () => {
        expect(assistantHtmlToSafeText('<img src=x onerror=alert(1)')).not.toContain('<');
    });
});

describe('fenced code blocks', () => {
    it('keeps the <pre><code> the renderer emits, so line breaks survive', () => {
        const html = parseMarkdownLinks('```\nline one\nline two\n```');
        expect(html).toContain('<pre');
        expect(ASSISTANT_PURIFY_CONFIG.ALLOWED_TAGS).toEqual(
            expect.arrayContaining(['pre', 'code']),
        );
        const pre = parse(html).querySelector('pre');
        expect(pre?.textContent).toContain('line one\nline two');
    });
});
