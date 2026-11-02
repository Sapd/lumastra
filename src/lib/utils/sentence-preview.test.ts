// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { sentencePreview } from './sentence-preview';

const limits = { maxSentences: 3, maxChars: 400 };

describe('sentencePreview', () => {
    it('returns null when the text has at most maxSentences sentences', () => {
        expect(sentencePreview('One. Two. Three.', limits)).toBeNull();
        expect(sentencePreview('Only one sentence', limits)).toBeNull();
    });

    it('cuts after maxSentences sentences', () => {
        expect(sentencePreview('One. Two! Three? Four. Five.', limits)).toBe('One. Two! Three?');
    });

    it('ignores trailing whitespace and blank lines', () => {
        expect(sentencePreview('One. Two. Three.   ', limits)).toBeNull();
        expect(sentencePreview('One. Two. Three.\n\n', limits)).toBeNull();
        expect(sentencePreview('\n One.\n\nTwo. Three.\n', limits)).toBeNull();
    });

    it('cuts paragraphs at sentence ends', () => {
        expect(sentencePreview('One. Two.\n\nThree. Four.', limits)).toBe('One. Two.\n\nThree.');
    });

    it('caps a few very long sentences at a word boundary', () => {
        const long = `${'word '.repeat(200).trim()}.`;
        const preview = sentencePreview(long, limits);
        expect(preview).not.toBeNull();
        expect(preview!.length).toBeLessThanOrEqual(402);
        expect(preview).toMatch(/word …$/);
    });
});
