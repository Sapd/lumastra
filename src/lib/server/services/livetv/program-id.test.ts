// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { programUuid } from './program-id';

const CHANNEL = '8c1a0d16-1f4e-4a2b-9f3c-0d5e6a7b8c9d';
const OTHER_CHANNEL = '11111111-2222-3333-4444-555555555555';

describe('programUuid', () => {
    it('returns the same id for the same channel and start time', () => {
        expect(programUuid(CHANNEL, '2026-08-19T12:30:00Z')).toBe(
            programUuid(CHANNEL, '2026-08-19T12:30:00Z'),
        );
    });

    // The EPG feed is free to re-render the same instant in another offset or
    // precision between refreshes. That's the same programme, so it has to keep
    // its id — the hash runs on the parsed instant, not the string.
    it('normalises equivalent timestamp spellings to one id', () => {
        const base = programUuid(CHANNEL, '2026-08-19T12:30:00Z');

        expect(programUuid(CHANNEL, '2026-08-19T14:30:00+02:00')).toBe(base);
        expect(programUuid(CHANNEL, '2026-08-19T12:30:00.000Z')).toBe(base);
        expect(programUuid(CHANNEL, new Date('2026-08-19T12:30:00Z'))).toBe(base);
    });

    it('separates programmes by channel and by start time', () => {
        const base = programUuid(CHANNEL, '2026-08-19T12:30:00Z');

        expect(programUuid(OTHER_CHANNEL, '2026-08-19T12:30:00Z')).not.toBe(base);
        expect(programUuid(CHANNEL, '2026-08-19T12:35:00Z')).not.toBe(base);
    });

    it('emits a well-formed RFC 4122 v5 UUID', () => {
        const id = programUuid(CHANNEL, '2026-08-19T12:30:00Z');

        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    // Postgres would reject a non-uuid text, and an unparseable start time is a
    // feed bug we'd rather see as a dropped programme than as a failed import.
    it('rejects a start time it cannot parse', () => {
        expect(() => programUuid(CHANNEL, 'not a date')).toThrow();
    });
});
