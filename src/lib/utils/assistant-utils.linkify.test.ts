// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for linkifyTitles — making recommended titles in assistant prose
 * clickable (modal links), without trusting the LLM to emit link markup.
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdownLinks, linkifyTitles } from './assistant-utils';

describe('linkifyTitles', () => {
    it('wraps a recommended title in a modal link with its index', () => {
        const html = parseMarkdownLinks('You might like The Lantern tonight.');
        const out = linkifyTitles(html, [{ title: 'The Lantern' }]);
        expect(out).toContain('data-internal-link="modal"');
        expect(out).toContain('data-movie-index="0"');
        expect(out).toContain('>The Lantern</a>');
    });

    it('links the correct index for multiple movies', () => {
        const html = parseMarkdownLinks('Try Haze or Dawn.');
        const out = linkifyTitles(html, [{ title: 'Haze' }, { title: 'Dawn' }]);
        expect(out).toMatch(/data-movie-index="0"[^>]*>Haze</);
        expect(out).toMatch(/data-movie-index="1"[^>]*>Dawn</);
    });

    it('works through bold markup (title rendered as <strong>)', () => {
        const html = parseMarkdownLinks('I recommend **Daydream** highly.');
        const out = linkifyTitles(html, [{ title: 'Daydream' }]);
        expect(out).toContain('<strong>');
        expect(out).toContain('data-internal-link="modal"');
        expect(out).toContain('Daydream</a>');
    });

    it('only links the first occurrence of a title', () => {
        const html = parseMarkdownLinks('Dawn is great. Dawn rocks.');
        const out = linkifyTitles(html, [{ title: 'Dawn' }]);
        expect(out.match(/data-internal-link="modal"/g)).toHaveLength(1);
    });

    it('does not match a short title inside a longer word', () => {
        const html = parseMarkdownLinks('Superman is not Up.');
        const out = linkifyTitles(html, [{ title: 'Up' }]);
        // "Up" must not match inside "Superman"
        expect(out).not.toMatch(/Super<a/);
    });

    it('does not double-link inside an existing anchor', () => {
        // Title also appears as an existing jellyseerr link text.
        const html = parseMarkdownLinks('Watch [The Lantern](https://req.example/movie/603) now.');
        const out = linkifyTitles(html, [{ title: 'The Lantern' }]);
        // Existing anchor preserved; no nested modal anchor created.
        expect(out.match(/<a /g)?.length).toBe(1);
        expect(out).not.toContain('data-internal-link="modal"');
    });

    it('returns input unchanged when there are no movies', () => {
        const html = parseMarkdownLinks('Just some text.');
        expect(linkifyTitles(html, [])).toBe(html);
    });
});

describe('parseMarkdownLinks — headers & bullets', () => {
    it('renders ### headers as bold, not literal hashes', () => {
        const out = parseMarkdownLinks('### Serien\nfoo');
        expect(out).toContain('<strong>Serien</strong>');
        expect(out).not.toContain('###');
    });

    it('renders bullet markers as a bullet glyph', () => {
        const out = parseMarkdownLinks('- one\n- two');
        expect(out).toContain('• one');
        expect(out).toContain('• two');
    });

    it('does not treat **bold** at line start as a bullet', () => {
        const out = parseMarkdownLinks('**Title** is great');
        expect(out).toContain('<strong>Title</strong>');
        expect(out).not.toContain('• ');
    });

    it('renders *italic* as <em>', () => {
        const out = parseMarkdownLinks('Stromberg *(IMDb: 7.4)*');
        expect(out).toContain('<em>(IMDb: 7.4)</em>');
    });

    it('keeps **bold** and *italic* distinct in one string', () => {
        const out = parseMarkdownLinks('**Bold** and *italic* together');
        expect(out).toContain('<strong>Bold</strong>');
        expect(out).toContain('<em>italic</em>');
    });
});

describe('parseMarkdownLinks entity handling', () => {
    it('does not double-decode &quot; typed into an external URL', () => {
        const out = parseMarkdownLinks('[x](https://example.com/?a=&quot;b)');
        // The literal text "&quot;" must survive (escaped for the attribute), not become a quote.
        expect(out).toContain('a=&amp;quot;b');
        expect(out).not.toContain('%22');
    });
});
