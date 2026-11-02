// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export interface SentencePreviewLimits {
    maxSentences: number;
    /** Cap for texts made of a few very long sentences; cut at a word boundary + "…". */
    maxChars: number;
}

let segmenter: Intl.Segmenter | null | undefined;

function sentenceSegmenter(): Intl.Segmenter | null {
    if (segmenter === undefined) {
        segmenter =
            typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
                ? new Intl.Segmenter(undefined, { granularity: 'sentence' })
                : null;
    }
    return segmenter;
}

/**
 * A shortened version of `text` (its first `maxSentences` sentences, capped at
 * `maxChars`), or null when the text already fits (nothing to collapse).
 * Sentences come from Intl.Segmenter, so "Dr." or "z. B." are not sentence ends
 * in most locales; without it the text is only capped by length.
 */
export function sentencePreview(text: string, limits: SentencePreviewLimits): string | null {
    const full = text.trim();
    let preview = full;
    const seg = sentenceSegmenter();
    if (seg) {
        let count = 0;
        let end = 0;
        for (const { segment, index } of seg.segment(full)) {
            if (segment.trim() === '') continue;
            if (count === limits.maxSentences) break;
            count += 1;
            end = index + segment.length;
        }
        preview = full.slice(0, end).trimEnd();
    }
    if (preview.length > limits.maxChars) {
        const cut = preview.slice(0, limits.maxChars);
        const lastSpace = cut.lastIndexOf(' ');
        preview = `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:–-]+$/, '')} …`;
    }
    return preview.length < full.length ? preview : null;
}
