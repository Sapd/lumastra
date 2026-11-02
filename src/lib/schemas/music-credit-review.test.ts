// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { ArtistCreditChoiceSchema } from './music-credit-review.js';
it('rejects internal ASCII controls, empty names and oversized names while retaining deliberate Unicode names', () => {
    const choice = (name: string) => ({
        artist: { newName: name },
        creditedAs: 'Credit',
        role: 'performer',
    });
    for (const name of [
        '',
        ' '.repeat(2),
        'x'.repeat(256),
        'Name\u0000Tail',
        'Name\u001fTail',
        'Name\u007fTail',
        'Name\tTail',
        'Name\nTail',
    ])
        expect(ArtistCreditChoiceSchema.safeParse(choice(name)).success).toBe(false);
    expect(ArtistCreditChoiceSchema.parse(choice('  Étoile 東京  ')).artist).toEqual({
        newName: 'Étoile 東京',
    });
    expect(
        ArtistCreditChoiceSchema.safeParse({ ...choice('Valid'), creditedAs: 'Credit\u0001Tail' })
            .success,
    ).toBe(false);
});
