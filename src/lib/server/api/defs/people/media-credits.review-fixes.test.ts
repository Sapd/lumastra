// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { mapMediaCredits } from '../catalog/media-id.js';

describe('mapMediaCredits limits', () => {
    it('caps cast and crew at 100 and skips nameless crew', () => {
        const cast = Array.from({ length: 150 }, (_, i) => ({ name: `A${i}`, person_id: i + 1 }));
        const crew = [
            { name: '  ', person_id: 1, job: 'X' },
            ...Array.from({ length: 150 }, (_, i) => ({ name: `C${i}`, person_id: i + 1, job: 'Y' })),
        ];
        const out = mapMediaCredits({ cast, crew }, 'v1');
        expect(out.cast).toHaveLength(100);
        expect(out.crew).toHaveLength(100);
        expect(out.crew.every((c) => c.person.name.trim() !== '')).toBe(true);
    });

    it('builds the handle from the normalized TMDB person id and keeps provider ids as fallback', () => {
        const out = mapMediaCredits({ cast: [{ name: 'A', id: 42 }] }, 'v1');
        expect(out.cast[0].person.id).toBe('tmdb:42');
        const merged = mapMediaCredits({ cast: [{ name: 'A' }] }, 'v1', {
            credits: { cast: [{ id: 7, name: 'A' }] },
        });
        expect(merged.cast[0].person.id).toBe('tmdb:7');
    });
});
