// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parseMediaId, validateParsedMediaId } from './media-key-parser';

describe('parseMediaId jellyfin composite ids', () => {
    it.each(['../Users', 'a/b', 'abc?x=1', 'zzzz', '..%2F..'])(
        'rejects non-GUID external id %j',
        (x) => {
            const parsed = parseMediaId(`jellyfin:${x}:movie`);
            expect(validateParsedMediaId(parsed)).toBe(false);
        },
    );

    it.each(['a1b2c3d4e5f60718293a4b5c6d7e8f90', 'a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90'])(
        'accepts Jellyfin GUID %s',
        (x) => {
            const parsed = parseMediaId(`jellyfin:${x}:movie`);
            expect(validateParsedMediaId(parsed)).toBe(true);
        },
    );

    it('leaves other providers alone', () => {
        expect(validateParsedMediaId(parseMediaId('tmdb:550:movie'))).toBe(true);
    });
});
