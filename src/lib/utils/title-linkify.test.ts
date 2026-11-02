// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { linkifyTitle } from './title-linkify';

describe('linkifyTitle', () => {
    it('links a known remixer inside a version tag, title otherwise verbatim', () => {
        expect(
            linkifyTitle('Harbortime (Ekoglow Remix)', [{ id: 'eko', title: 'Ekoglow' }]),
        ).toEqual([{ text: 'Harbortime (' }, { text: 'Ekoglow', id: 'eko' }, { text: ' Remix)' }]);
    });

    it('links case-insensitively with punctuation in the name (anonymized production shape)', () => {
        expect(
            linkifyTitle('Where Is the Love (Cc.K remix edit)', [{ id: 'cck', title: 'Cc.K' }]),
        ).toEqual([
            { text: 'Where Is the Love (' },
            { text: 'Cc.K', id: 'cck' },
            { text: ' remix edit)' },
        ]);
    });

    it('links both remixers of a collab tag', () => {
        expect(
            linkifyTitle('Song (A & B Remix)', [
                { id: 'a', title: 'A' },
                { id: 'b', title: 'B' },
            ]),
        ).toEqual([
            { text: 'Song (' },
            { text: 'A', id: 'a' },
            { text: ' & ' },
            { text: 'B', id: 'b' },
            { text: ' Remix)' },
        ]);
    });

    it('does NOT link a name that appears outside a version tag', () => {
        // "Refresh" is the track artist; it must not link inside the plain title.
        expect(linkifyTitle('Refresh Anthem', [{ id: 'r', title: 'Refresh' }])).toEqual([
            { text: 'Refresh Anthem' },
        ]);
    });

    it('does NOT let a shorter artist claim part of the title word before the tag', () => {
        expect(linkifyTitle('Harbortime (Ekoglow Remix)', [{ id: 's', title: 'Harbor' }])).toEqual([
            { text: 'Harbortime (Ekoglow Remix)' },
        ]);
    });

    it('links in the dash-suffix form', () => {
        expect(linkifyTitle('Song - Ekoglow Remix', [{ id: 'eko', title: 'Ekoglow' }])).toEqual([
            { text: 'Song - ' },
            { text: 'Ekoglow', id: 'eko' },
            { text: ' Remix' },
        ]);
    });

    it('never invents: unknown remixer stays plain', () => {
        expect(
            linkifyTitle('Harbortime (Ekoglow Remix)', [{ id: 'x', title: 'Someone Else' }]),
        ).toEqual([{ text: 'Harbortime (Ekoglow Remix)' }]);
    });

    it('requires whole-span delimiting inside the zone', () => {
        // Artist "Dan" must not claim half of "Dan Fenwick".
        expect(
            linkifyTitle('Bang The Drum (Dan Fenwick Bootleg Mix)', [{ id: 'd', title: 'Dan' }]),
        ).toEqual([{ text: 'Bang The Drum (Dan Fenwick Bootleg Mix)' }]);
    });

    it('blocklist: a library artist named after a version keyword never links', () => {
        // "(Extended Mix)" produces no candidate zone, so even a real artist
        // called "Extended" cannot claim it (spec §1 defensive blocklist).
        expect(linkifyTitle('Song (Extended Mix)', [{ id: 'e', title: 'Extended' }])).toEqual([
            { text: 'Song (Extended Mix)' },
        ]);
        expect(linkifyTitle('Song (Original Mix)', [{ id: 'o', title: 'Original' }])).toEqual([
            { text: 'Song (Original Mix)' },
        ]);
    });

    it('segment concatenation always reproduces the raw title', () => {
        const cases: Array<[string, { id?: string; title: string }[]]> = [
            ['Harbortime (Ekoglow Remix)', [{ id: 'eko', title: 'Ekoglow' }]],
            [
                'Song (A & B Remix)',
                [
                    { id: 'a', title: 'A' },
                    { id: 'b', title: 'B' },
                ],
            ],
            ['Plain Title', []],
        ];
        for (const [raw, artists] of cases) {
            const joined = linkifyTitle(raw, artists)
                .map((segment) => segment.text)
                .join('');
            expect(joined).toBe(raw);
        }
    });

    it('returns empty for an empty title and a single segment when nothing resolves', () => {
        expect(linkifyTitle('', [{ id: 'a', title: 'A' }])).toEqual([]);
        expect(linkifyTitle('Song (Club Mix)', [{ id: 'a', title: 'A' }])).toEqual([
            { text: 'Song (Club Mix)' },
        ]);
    });

    it('links through a stray bracket in a mixed-type double-wrapped tag (write/display consistency)', () => {
        const raw = 'Song [(Ekoglow Remix)]';
        const segments = linkifyTitle(raw, [{ id: 'eko', title: 'Ekoglow' }]);
        expect(segments).toContainEqual({ text: 'Ekoglow', id: 'eko' });
        expect(segments.map((segment) => segment.text).join('')).toBe(raw);
    });
});
