// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildSubjectPredicate } from '../run-filter-sql.js';

describe('subject predicate construction', () => {
    it('emits nothing when no subjectId is filtered', () => {
        expect(buildSubjectPredicate(undefined)).toBeNull();
    });

    it('emits a bare equality, never a null-guarded OR', () => {
        const frag = buildSubjectPredicate('media-1');
        expect(frag).not.toBeNull();
        expect(frag!.sql).toContain("scope->>'subjectId' =");
        // A null-guard OR would make the partial index unprovable under a
        // generic plan — this assertion is the guard against regressing it.
        expect(frag!.sql).not.toContain('IS NULL OR');
        expect(frag!.value).toBe('media-1');
    });
});
