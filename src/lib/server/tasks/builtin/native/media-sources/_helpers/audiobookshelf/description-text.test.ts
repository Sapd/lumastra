// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { sanitizeAudiobookDescription } from './description-text.js';

describe('sanitizeAudiobookDescription', () => {
    it('strips tags and the leading non-breaking space from the real production string', () => {
        // Verified against a live AudiobookShelf server for "001 - Der
        // Super-Papagei": description starts with `<p>\xa0Der neueste
        // Auftrag…`. This is the exact string that rendered literal `<p>`
        // tags in the modal before this fix.
        const html =
            '<p> Der neueste Auftrag an die sieben Detektive hört sich recht harmlos an: sie sollen einen bunten Papagei aufspüren, der einem alten Mann davongeflogen ist.</p>';

        const result = sanitizeAudiobookDescription(html);

        expect(result).not.toBeNull();
        expect(result).not.toContain('<p>');
        expect(result).not.toContain('</p>');
        expect(result).not.toContain(' ');
        expect(result).toBe(
            'Der neueste Auftrag an die sieben Detektive hört sich recht harmlos an: sie sollen einen bunten Papagei aufspüren, der einem alten Mann davongeflogen ist.',
        );
    });

    it('does not glue words across a paragraph boundary', () => {
        const html =
            '<p>Der neueste Auftrag hört sich harmlos an:</p><p>Doch kaum haben sie begonnen…</p>';

        const result = sanitizeAudiobookDescription(html);

        expect(result).not.toContain('an:Doch');
        expect(result).toBe(
            'Der neueste Auftrag hört sich harmlos an: Doch kaum haben sie begonnen…',
        );
    });

    it('treats <br> and </div>/</li> as boundaries too, not just </p>', () => {
        const html = '<div>First line<br>Second line</div><ul><li>One</li><li>Two</li></ul>';

        const result = sanitizeAudiobookDescription(html);

        expect(result).not.toContain('lineSecond');
        expect(result).not.toContain('OneTwo');
        expect(result).toBe('First line Second line One Two');
    });

    it('decodes the named entities that show up in this data', () => {
        const html =
            '<p>Tom &amp; Jerry &lt;3&gt; said &quot;hi&quot; &mdash; it&#39;s a &apos;test&apos;&nbsp;now</p>';

        const result = sanitizeAudiobookDescription(html);

        // &mdash; is intentionally not in the decode table (not seen in this
        // data) — assert only on the entities the contract promises.
        expect(result).toContain('Tom & Jerry');
        expect(result).toContain('<3>');
        expect(result).toContain('said "hi"');
        expect(result).toContain("it's a 'test'");
        expect(result).toContain('now');
    });

    it('decodes numeric entities, decimal and hex, including the right single quote from the bug report', () => {
        expect(sanitizeAudiobookDescription('It&#8217;s here')).toBe('It’s here');
        expect(sanitizeAudiobookDescription('It&#x2019;s here')).toBe('It’s here');
    });

    it('is idempotent — running it twice on its own output is a no-op', () => {
        const html =
            '<p> Der neueste Auftrag an die sieben Detektive hört sich recht harmlos an: sie so</p><p>Doch kaum haben sie begonnen…</p>';

        const once = sanitizeAudiobookDescription(html);
        const twice = sanitizeAudiobookDescription(once);

        expect(twice).toBe(once);
    });

    it('is idempotent on text that was already clean', () => {
        const clean = 'A perfectly ordinary description with no markup at all.';

        expect(sanitizeAudiobookDescription(clean)).toBe(clean);
        expect(sanitizeAudiobookDescription(sanitizeAudiobookDescription(clean))).toBe(clean);
    });

    it('returns null for an empty string', () => {
        expect(sanitizeAudiobookDescription('')).toBeNull();
    });

    it('returns null for a whitespace/tag-only string with nothing left after stripping', () => {
        expect(sanitizeAudiobookDescription('<p>  </p>')).toBeNull();
    });

    it('returns null for null input', () => {
        expect(sanitizeAudiobookDescription(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(sanitizeAudiobookDescription(undefined)).toBeNull();
    });
});
