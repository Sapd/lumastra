// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { V1RunsQuerySchema } from '$lib/schemas/api-query-params.js';
import { mediaItemIdForRun } from '../index.js';

describe('runs query schema', () => {
    it('accepts subjectId', () => {
        const parsed = V1RunsQuerySchema.parse({ subjectId: 'media-1' });
        expect(parsed.subjectId).toBe('media-1');
    });
});

describe('mediaItemIdForRun', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    it('prefers scope.subjectId', () => {
        expect(
            mediaItemIdForRun({ scope: { subjectId: uuid }, input: { mediaItemId: 'other' } }),
        ).toBe(uuid);
    });

    it('falls back to input.mediaItemId for runs that predate subject tagging', () => {
        expect(mediaItemIdForRun({ scope: undefined, input: { mediaItemId: uuid } })).toBe(uuid);
    });

    it('returns undefined when neither is a uuid', () => {
        expect(
            mediaItemIdForRun({ scope: undefined, input: { mediaId: 'not-a-uuid' } }),
        ).toBeUndefined();
    });
});
