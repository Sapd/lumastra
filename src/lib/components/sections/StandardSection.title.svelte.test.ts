// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Section header titles carry library data (the "Because you watched X"
 * word). The header must show it as text once — not double-escaped — and must
 * never let it add classes.
 *
 * The mounted case uses the structured `titleParts` path, which involves no
 * HTML sanitiser (happy-dom cannot host DOMPurify). The HTML path's chunk
 * builder is covered on its own below.
 */
import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StandardSection from './StandardSection.svelte';
import { titleChunksFromHtml, titleChunksFromParts, decodeEscapedText } from './section-title';
import type { PageSection } from '$lib/types/server-driven-ui';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

afterEach(cleanup);

const HOSTILE = 'X</span><span class="fixed inset-0">pwn</span>';
const AMP = 'Tom & Jerry';

function section(sourceTitle: string): PageSection {
    return {
        id: 'because-test',
        type: 'carousel',
        // What the server sends: an HTML title with the data escaped…
        title: `Because you watched <span class="text-purple-400 font-heading">${sourceTitle
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')}</span>`,
        items: [],
        meta: {
            // …and the same title as plain structured parts.
            titleParts: [
                { text: 'Because you watched ' },
                { text: sourceTitle, highlight: true, color: 'purple' },
            ],
        },
    } as PageSection;
}

describe('StandardSection header title', () => {
    it('shows an ampersand title once, not double-escaped', () => {
        const { container } = render(StandardSection, { props: { section: section(AMP) } });
        const heading = container.querySelector('h2');
        expect(heading?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
            'Because you watched Tom & Jerry',
        );
        expect(container.innerHTML).not.toContain('&amp;amp;');
    });

    it('shows a markup title as text and adds no class', () => {
        const { container } = render(StandardSection, { props: { section: section(HOSTILE) } });
        expect(container.querySelector('.fixed')).toBeNull();
        expect(container.querySelector('.inset-0')).toBeNull();
        expect(container.querySelector('h2')?.textContent).toContain(HOSTILE);
    });
});

describe('title chunk builders', () => {
    it('HTML path: escaped text decodes once and unknown classes are dropped', () => {
        const chunks = titleChunksFromHtml(
            'Because you watched <span class="fixed inset-0 text-purple-400">Tom &amp; Jerry</span>',
        );
        expect(chunks.map((c) => c.text).join('')).toBe('Because you watched Tom & Jerry');
        expect(chunks[1].className).toBe('text-purple-400');
    });

    it('HTML path: an escaped injection stays text', () => {
        const chunks = titleChunksFromHtml(
            'You like <span class="text-cyan-400">X&lt;/span&gt;&lt;span class=&quot;fixed inset-0&quot;&gt;pwn</span>',
        );
        expect(chunks.every((c) => !c.className?.includes('fixed'))).toBe(true);
        expect(chunks.map((c) => c.text).join('')).toContain('<span class="fixed inset-0">');
    });

    it('parts path: class comes from a closed colour map', () => {
        const chunks = titleChunksFromParts([
            { text: 'a ' },
            { text: 'b', highlight: true, color: 'cyan' },
        ]);
        expect(chunks).toEqual([
            { text: 'a ', className: undefined },
            { text: 'b', className: 'text-cyan-400' },
        ]);
    });

    it('decodes the SSR (tag-stripped) text once', () => {
        expect(decodeEscapedText('Tom &amp; Jerry &lt;3 &#039;x&#039;')).toBe("Tom & Jerry <3 'x'");
    });
});
