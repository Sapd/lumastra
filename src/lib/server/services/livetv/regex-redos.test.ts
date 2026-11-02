// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Channel names are untrusted playlist text. The feed-tag and section-header
 * rules must stay linear on names built to make a backtracking regex explode
 * (30 digits after "(Backup)" took 13 s, 40 took hours), and must keep the
 * accept/reject behaviour of the patterns they replaced.
 */

import { describe, expect, it } from 'vitest';
import {
    extractBaseName,
    hasFeedMarker,
    isDegradedFeed,
    isSeparatorEntry,
    separatorLabel,
} from './auto-processor.js';
import { parseSlot } from './lineup-noise.js';

const BUDGET_MS = 50;

function elapsed(fn: () => void): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
}

const DECOR_CHARS = ['✦', '●', '▼', '•', '#', '-', '★'];
const alternating = (n: number): string =>
    Array.from({ length: n }, (_, i) =>
        i % 2 === 0 ? DECOR_CHARS[i % DECOR_CHARS.length] : 'a',
    ).join('');

const ADVERSARIAL: Record<string, string> = {
    'backup + 50 digits + x': `(Backup)${'1'.repeat(50)}x`,
    'backup + digits with spaces + x': `(Backup)${'1 '.repeat(120)}x`,
    'transcoded + HD runs + x': `[Transcoded]${' HD'.repeat(80)}x`,
    'many brackets': `${'(Backup)'.repeat(60)}x`,
    'unclosed brackets': '['.repeat(300),
    'low quality + spaces': `low quality${' '.repeat(300)}x`,
    'alternating letters and decoration (256)': alternating(256),
    'decoration run, letter, decoration run': `✦✦${'✦a'.repeat(120)}✦ x`,
    'leading decoration, no end decoration': `✦✦${'a✦'.repeat(120)}b`,
    'whitespace and decoration mix': `✦✦ ${' ✦'.repeat(120)} a ${'✦ '.repeat(60)}x`,
};

describe('feed-tag and section-header rules are linear', () => {
    describe.each(Object.entries(ADVERSARIAL))('%s', (_label, name) => {
        it.each([
            ['extractBaseName', extractBaseName],
            ['hasFeedMarker', hasFeedMarker],
            ['isDegradedFeed', isDegradedFeed],
            ['isSeparatorEntry', isSeparatorEntry],
            ['separatorLabel', separatorLabel],
            ['parseSlot', parseSlot],
        ] as Array<[string, (n: string) => unknown]>)('%s', (_fn, fn) => {
            expect(elapsed(() => fn(name))).toBeLessThan(BUDGET_MS);
        });
    });

    it('keeps the old verdict on a corpus of short names', () => {
        // The patterns this replaced, kept here as the reference.
        const DECOR = String.raw`[^\p{L}\p{N}\p{M}\s\[\](){}+.,:'"&/\u{1F1E6}-\u{1F1FF}]`;
        const OLD_SEPARATOR = new RegExp(
            String.raw`^\s*(${DECOR}{2,}).*\p{L}.*?(${DECOR}+)\s*$`,
            'u',
        );
        const OLD_EDGES = new RegExp(String.raw`^(?:\s|${DECOR})+|(?:\s|${DECOR})+$`, 'gu');
        const OLD_TAG =
            /\s*[([]\s*(?:local\s+)?(?:transcoded|mobil(?:e)?|backup|low\s*quali\w*|hevc|h\.?265)\s*[)\]](?=(?:\s*(?:\d+|(?:U|F)?HD\+?|SD|4K))*\s*$)/i;
        const OLD_DEGRADED =
            /[([]\s*(?:local\s+)?(?:transcoded|mobil(?:e)?|backup|low\s*quali\w*)\s*[)\]](?:\s*(?:\d+|(?:U|F)?HD\+?|SD|4K))*\s*$|\blow\s*quali\w*\s*$|[([]\s*low\s*[)\]]|\blow\b(?=\s*(?:[([]\s*(?:hevc|h\.?265)\s*[)\]]\s*)?$)/i;
        const oldSeparator = (n: string): boolean => {
            const m = OLD_SEPARATOR.exec(n);
            if (!m) return false;
            const lead = new Set(m[1]);
            return [...m[2]].some((c) => lead.has(c));
        };

        const corpus = [
            '✦●✦ DE • Local RAW ✦●✦',
            '▼•●• TopLiga Replay •●• ▼',
            '### ADULT ###',
            '---AZERBAIJAN ---',
            '♥ Name',
            '☆ Welcome Channel ☆',
            '🇩🇪 Nordwelle 📺',
            '  ✦✦ x ✦✦  ',
            '✦✦ ✦✦',
            '✦✦a',
            '✦✦\na✦✦',
            '✦✦a\n✦✦',
            '✦✦ a ✦ ✦',
            '✦● a ●✦ (x)',
            '[DE] Das Erste',
            'Nordwelle (Backup)',
            'Nordwelle (Backup) HD',
            'Nordwelle [Local Transcoded] 2 FHD+',
            'Nordwelle (Mobile) 12',
            'Nordwelle (HEVC)',
            'Nordwelle (H.265) UHD 4K SD',
            'Nordwelle (Backup) news',
            'Nordwelle (Backup) 4Kx',
            'Nordwelle (Low Quality)',
            'Nordwelle Low Quality',
            'Nordwelle Low (HEVC)',
            'Nordwelle (Low)',
            'Nordwelle Low',
            'Nordwelle (Alt 2)',
            'Nordwelle ( backup ) ( mobil )',
            '(Backup)(Backup) 3',
            '(Backup) x (Backup) 1',
            'TNT 1 FHD HEVC',
            '',
            '   ',
        ];
        for (const name of corpus) {
            expect(isSeparatorEntry(name), `separator ${JSON.stringify(name)}`).toBe(
                oldSeparator(name),
            );
            expect(separatorLabel(name), `label ${JSON.stringify(name)}`).toBe(
                name.replace(OLD_EDGES, '').replace(/\s+/g, ' ').trim(),
            );
            expect(isDegradedFeed(name), `degraded ${JSON.stringify(name)}`).toBe(
                OLD_DEGRADED.test(name),
            );
            if (OLD_TAG.test(name)) {
                // A tag that only quality words follow is dropped, and so is the space before it.
                // (With two tags the old pattern left the first one for the later
                // marker strip, so only single-tag names compare like for like.)
                if ((name.match(/[([]/g) ?? []).length === 1) {
                    expect(extractBaseName(name)).toBe(extractBaseName(name.replace(OLD_TAG, '')));
                }
                expect(hasFeedMarker(name)).toBe(true);
            }
        }
    });
});
