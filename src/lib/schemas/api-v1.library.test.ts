// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { LibraryIngestRequestSchema } from './api-v1.js';

describe('LibraryIngestRequestSchema', () => {
    it('accepts a path-based op-list', () => {
        const r = LibraryIngestRequestSchema.safeParse({
            libraryPathId: '550e8400-e29b-41d4-a716-446655440000',
            changes: [{ path: 'A/a.mkv', op: 'upsert' }],
        });
        expect(r.success).toBe(true);
    });
    it('rejects an empty changes array', () => {
        expect(
            LibraryIngestRequestSchema.safeParse({
                libraryPathId: '550e8400-e29b-41d4-a716-446655440000',
                changes: [],
            }).success,
        ).toBe(false);
    });
    it('requires exactly one of path|sourceUri per entry', () => {
        expect(
            LibraryIngestRequestSchema.safeParse({
                changes: [{ op: 'upsert' }],
            }).success,
        ).toBe(false);
    });
});
