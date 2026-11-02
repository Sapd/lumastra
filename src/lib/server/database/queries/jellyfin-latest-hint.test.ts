// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { latestHintKey, type LatestItemsOptions } from './jellyfin-browse.queries';
import { unrestrictedAccess } from './builders/media-access-boundary';
import { toUserId } from '$lib/shared/user-id';

const base: LatestItemsOptions = {
    limit: 20,
    parentId: 'lib-1',
    groupItems: true,
    access: unrestrictedAccess(),
};
const alice = toUserId('00000000-0000-4000-8000-00000000000a');
const bob = toUserId('00000000-0000-4000-8000-00000000000b');
const types = ['movie', 'tv'];

describe('latestHintKey (the "go straight to the full listing" hint)', () => {
    it('is never shared across users once IsPlayed filters by watch state', () => {
        expect(latestHintKey({ ...base, isPlayed: false, userId: alice }, types)).not.toBe(
            latestHintKey({ ...base, isPlayed: false, userId: bob }, types),
        );
    });

    it('is shared when the listing does not depend on the user', () => {
        expect(latestHintKey({ ...base, userId: alice }, types)).toBe(
            latestHintKey({ ...base, userId: bob }, types),
        );
    });

    it('separates libraries, types and played state', () => {
        const k = (o: Partial<LatestItemsOptions>, t = types) =>
            latestHintKey({ ...base, userId: alice, ...o }, t);
        expect(
            new Set([
                k({}),
                k({ parentId: 'lib-2' }),
                k({}, ['movie']),
                k({ isPlayed: true }),
                k({ isPlayed: false }),
            ]).size,
        ).toBe(5);
    });
});
