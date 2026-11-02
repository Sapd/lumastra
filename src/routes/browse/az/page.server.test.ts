// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { load } from './+page.server.js';

describe('/browse/az watching policy', () => {
    it.each([
        [undefined, true],
        [{ isAgeRestricted: true }, true],
        [{ isAgeRestricted: false }, false],
    ])('returns watchingSuppressed=%s for the viewer policy', async (user, expected) => {
        const result = await load({ locals: { user } } as never);
        expect(result).toEqual({ watchingSuppressed: expected });
    });
});
