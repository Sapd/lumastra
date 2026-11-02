// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A library writer controls sidecar `.vtt` content and a logged-in user triggers
 * its sanitisation, so every regex-based transform here must stay linear on
 * input that repeats an opener with no closer.
 */

import { describe, it, expect } from 'vitest';
import * as sanitizer from './subtitle-sanitizer.js';

const SIZE = Number(process.env.REDOS_SIZE ?? 1_000_000);
const BUDGET_MS = 750;

function repeat(unit: string, bytes = SIZE): string {
    return unit.repeat(Math.ceil(bytes / unit.length));
}

const CUE = '00:00:01.000 --> 00:00:02.000';

/** Adversarial inputs: repeated opener, closer absent / on a later line / at the very end. */
const ADVERSARIAL: Record<string, string> = {
    'ass tag opener x n': repeat('{\\'),
    'ass tag opener inside cue': `WEBVTT\n\n${CUE}\n${repeat('{\\x')}`,
    'font opener x n': repeat('<font'),
    'font opener with attrs': repeat('<font color="red" '),
    'microdvd opener x n': repeat('{y:'),
    'microdvd colour opener x n': repeat('{c:$'),
    'bold opener x n': repeat('{\\b1}'),
    'bold opener, closer on a later line': `${repeat('{\\b1}x')}\n{\\b0}`,
    'bold opener, closer at the end': `${repeat('{\\b1}x')}{\\b0}`,
    'italic opener x n': repeat('{\\i1}'),
    'underline opener x n': repeat('{\\u1}'),
    'empty ass tag x n': repeat('{\\}'),
    'ass tag opener, closer at the end': `${repeat('{\\a')}}`,
    'region setting after long whitespace': `Region: a\n${CUE}${' '.repeat(SIZE)}x`,
    'region: tokens separated by spaces': `Region: a\n${CUE} ${repeat(' region: ')}`,
    'region: without leading whitespace': `Region: a\n${CUE}${repeat('region:')}`,
    'whitespace run': `WEBVTT\n${' '.repeat(SIZE)}\n`,
    'timing line digits': `${'0'.repeat(SIZE)} --> x\n`,
    'many empty lines': `WEBVTT\n${'\n'.repeat(SIZE)}`,
    'many cue lines': repeat(`${CUE}\ntext\n\n`),
    'alignment tag x n': repeat(`${CUE}\n{\\an8}text\n\n`),
    'X-TIMESTAMP-MAP prefix x n': repeat('X-TIMESTAMP-MAP=MPEGTS:1'),
    'WEBVTT header, no newline': `WEBVTT${'x'.repeat(SIZE)}`,
};

/** Every exported function must be driven below; a new export fails the guard test. */
const TRANSFORMS: Record<string, (input: string) => unknown> = {
    sanitizeWebVTT: (input) => sanitizer.sanitizeWebVTT(input, { enableLogging: false }),
    fixTimestampMap: (input) =>
        sanitizer.fixTimestampMap(input, { enableLogging: false, mpegtsOffset: 70_200_000 }),
    processWebVTTForHLS: (input) =>
        sanitizer.processWebVTTForHLS(input, {
            enableLogging: false,
            mpegtsOffset: 90_000,
            seekOffsetSeconds: 1.5,
        }),
};

describe('subtitle-sanitizer regex transforms stay linear', () => {
    it('drives every exported function', () => {
        const exported = Object.entries(sanitizer)
            .filter(([, v]) => typeof v === 'function')
            .map(([k]) => k)
            .sort();
        expect(Object.keys(TRANSFORMS).sort()).toEqual(exported);
    });

    const cases = Object.entries(TRANSFORMS).flatMap(([fn, run]) =>
        Object.entries(ADVERSARIAL).map(([name, input]) => ({ fn, run, name, input })),
    );

    it.each(cases)('$fn: $name', ({ run, input }) => {
        const started = performance.now();
        run(input);
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(BUDGET_MS);
    });
});

/** The pre-rewrite regex pipeline (steps 2 and 4 to 8), kept as the oracle. */
function legacySanitize(input: string): string {
    let c = input;
    c = c
        .replace(/\{\\b[1-9]\d*\}(.*?)\{\\b0\}/g, '<b>$1</b>')
        .replace(/\{\\i1\}(.*?)\{\\i0\}/g, '<i>$1</i>')
        .replace(/\{\\u1\}(.*?)\{\\u0\}/g, '<u>$1</u>');
    c = c.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
    c = c
        .replace(/\{[yY]:i\}/g, '<i>')
        .replace(/\{[yY]:b\}/g, '<b>')
        .replace(/\{[yY]:u\}/g, '<u>');
    c = c.replace(/\{[yYcCfFsSPH]:[^}]*\}/g, '');
    c = c.replace(/<font[^>]*>/gi, '').replace(/<\/font>/gi, '');
    c = c.replace(/\{\\[^}]+\}/g, '');
    if (/^Region:\s/m.test(c)) {
        c = c
            .split('\n')
            .filter((line) => !line.trim().startsWith('Region:'))
            .map((line) => (line.includes('-->') ? line.replace(/\s+region:\S+/g, '') : line))
            .join('\n');
    }
    return c;
}

const TOKENS = [
    '{\\b1}',
    '{\\b700}',
    '{\\b0}',
    '{\\i1}',
    '{\\i0}',
    '{\\u1}',
    '{\\u0}',
    '{y:i}',
    '{Y:b}',
    '{c:$00FF00}',
    '{y:',
    '{P:1,2}',
    '{\\fs20}',
    '{\\}',
    '{\\',
    '{',
    '}',
    '<font',
    '<FONT color="red">',
    '</font>',
    '>',
    '<',
    'Region: id:a\n',
    ' region:r1',
    'region:',
    ' ',
    '\t',
    '\n',
    '\r',
    '\u2028',
    ' --> ',
    '00:01.000',
    'text',
    '\\N',
    '\\h',
];

function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('subtitle-sanitizer keeps output identical to the regex pipeline', () => {
    it('matches on random token soup', () => {
        const rnd = mulberry32(20261007);
        for (let i = 0; i < 4000; i++) {
            const n = 1 + Math.floor(rnd() * 30);
            let input = '';
            for (let j = 0; j < n; j++) input += TOKENS[Math.floor(rnd() * TOKENS.length)];
            const actual = sanitizer.sanitizeWebVTT(input, { enableLogging: false }).content;
            expect(actual, JSON.stringify(input)).toBe(legacySanitize(input));
        }
    });

    it('converts a real-shaped converted-ASS cue file', () => {
        const input = [
            'WEBVTT',
            '',
            '00:00:01.000 --> 00:00:03.000',
            '{\\b1}Hello{\\b0}, {\\i1}world{\\i0}!\\NSecond {\\u1}line{\\u0}',
            '',
            '00:00:04.000 --> 00:00:06.000',
            '{\\fad(200,200)}{\\c&HFFFFFF&}Plain <font color="#ff0000">red</font> text',
            '',
            '00:00:07.000 --> 00:00:09.000',
            '{y:i}old style{c:$0000FF}',
            '',
        ].join('\n');
        const { content, changes } = sanitizer.sanitizeWebVTT(input, { enableLogging: false });
        expect(content).toBe(
            [
                'WEBVTT',
                '',
                '00:00:01.000 --> 00:00:03.000',
                '<b>Hello</b>, <i>world</i>!',
                'Second <u>line</u>',
                '',
                '00:00:04.000 --> 00:00:06.000',
                'Plain red text',
                '',
                '00:00:07.000 --> 00:00:09.000',
                '<i>old style',
                '',
            ].join('\n'),
        );
        expect(changes).toContain('ass-styles');
    });
});
