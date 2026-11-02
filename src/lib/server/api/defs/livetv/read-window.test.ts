// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ProgramsWindowSchema, validateReadWindow, encodeGuideCursor, decodeGuideCursor } from './read-window.js';

describe('Live TV read windows', () => {
    const from = '2026-10-17T00:00:00Z';
    it('requires both instants and rejects local datetimes', () => {
        expect(ProgramsWindowSchema.safeParse({ from }).success).toBe(false);
        expect(ProgramsWindowSchema.safeParse({ from: '2026-10-17T00:00:00', to: from }).success).toBe(false);
        expect(validateReadWindow({ from: 'invalid', to: from })?.status).toBe(422);
    });
    it('accepts offsets, 12 hours and exactly 24 hours', () => {
        expect(validateReadWindow({ from, to: '2026-10-17T14:00:00+02:00' })).toBeNull();
        expect(validateReadWindow({ from, to: '2026-10-18T00:00:00Z' })).toBeNull();
    });
    it('rejects zero/reversed windows and supplies the span cap', async () => {
        expect(validateReadWindow({ from, to: from })?.status).toBe(422);
        expect(validateReadWindow({ from, to: '2026-10-16T00:00:00Z' })?.status).toBe(422);
        const response = validateReadWindow({ from, to: '2026-10-18T00:00:01Z' })!;
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ details: { maxSpanSeconds: 86400 } });
    });
});

describe('guide cursor', () => {
    it('round-trips the last station id', () => {
        for (const id of ['a', '3f2c8a52-6d3e-4c1b-9d57-1c2f0f6a9b11']) {
            expect(decodeGuideCursor(encodeGuideCursor(id))).toBe(id);
        }
    });
    it('rejects corrupt, empty and unsupported cursors', () => {
        for (const cursor of ['', 'garbage', encodeGuideCursor(''),
            Buffer.from(JSON.stringify({ v: 2, stationId: 'a' })).toString('base64url'),
            Buffer.from(JSON.stringify({ v: 1, stationId: 'a', extra: 1 })).toString('base64url')]) {
            expect(decodeGuideCursor(cursor)).toBeNull();
        }
    });
});
