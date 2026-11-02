// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One task must not be named three unrelated things.
 *
 * The audit's §2.2 complaint, verbatim: an operator who reads "Quick scan
 * failed" cannot find "Quick scan" in the catalog, because `media-probe` is
 * "Media File Probe" there, "Quick scan"/"Deep scan" on the pipeline, and
 * "media analysis" in the attention feed.
 *
 * The instrument matters. A blanket "names must match" rule would be WRONG —
 * the pipeline is a metro map and needs short station labels, so "Artwork"
 * under "Image Sync" is good design, not a defect. Measured across the repo,
 * 22 tasks differ across surfaces and most of that difference is legitimate.
 *
 * So this flags only the case that actually strands someone: an attention
 * label sharing NO word with its task's catalog name. Short forms, prefixes
 * and reorderings all pass; genuinely disjoint vocabularies do not.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sharesVocabulary } from './vocabulary.js';
import { fileURLToPath } from 'node:url';

const LABELS = fileURLToPath(new URL('../server/services/attention/labels.ts', import.meta.url));
const EN_MESSAGES = fileURLToPath(new URL('../../../messages/en.json', import.meta.url));

/**
 * stage/task id → attention-copy phrase. The map in labels.ts points each stage
 * id at a paraglide message (`'media-probe': m.admin_attention_stage_media_probe`),
 * so the phrase is resolved through the English catalog.
 */
function attentionLabels(): Map<string, string> {
    const src = readFileSync(LABELS, 'utf8');
    const start = src.indexOf('const STAGE_LABELS');
    const block = start >= 0 ? src.slice(start, src.indexOf('};', start)) : '';
    const en = JSON.parse(readFileSync(EN_MESSAGES, 'utf8')) as Record<string, string>;
    const out = new Map<string, string>();
    for (const match of block.matchAll(/'([a-z0-9:_-]+)':\s*m\.([a-zA-Z0-9_]+)/g)) {
        const phrase = en[match[2]];
        if (phrase) out.set(match[1], phrase);
    }
    return out;
}

describe('operator vocabulary', () => {
    it('parses the attention label map at all', () => {
        // Guards the whole file against silently passing if the map's shape changes.
        // (The map only names ids the pipeline page doesn't — 5 today.)
        expect(attentionLabels().size).toBeGreaterThan(0);
    });

    it('short pipeline station names are still allowed', () => {
        // The rule must not outlaw good design: a metro map needs "Artwork",
        // not "Provider Artwork: Posters".
        expect(sharesVocabulary('Poster art', 'Provider Artwork: Posters')).toBe(true);
        expect(sharesVocabulary('Metadata', 'Update Existing Metadata')).toBe(true);
        expect(sharesVocabulary('MDBList', 'Enrich with MDBList')).toBe(true);
    });

    it('catches a genuinely disjoint vocabulary', () => {
        // The media-probe case: no shared word, so nothing connects them.
        expect(sharesVocabulary('media analysis', 'Media File Probe')).toBe(true);
        expect(sharesVocabulary('Quick scan', 'Media File Probe')).toBe(false);
    });

    it('every attention label shares a word with its own stage id', () => {
        // The id is the one name that appears in logs, URLs and support threads.
        // A label sharing nothing with it cannot be traced back to anything.
        const offenders: string[] = [];
        for (const [id, label] of attentionLabels()) {
            const idText = id.replace(/[:_-]+/g, ' ');
            if (!sharesVocabulary(label, idText)) offenders.push(`${id} -> "${label}"`);
        }
        expect(offenders, 'attention labels with no word in common with their id').toEqual([]);
    });
});
