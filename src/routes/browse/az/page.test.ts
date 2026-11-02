// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { load } from './+page.js';
describe('legacy A–Z route', () => {
    it('redirects to Library · A–Z', () => {
        expect(() =>
            load({ url: new URL('https://example.test/browse/az?letter=M'), data: {} } as never),
        ).toThrow(expect.objectContaining({ status: 307, location: '/browse?letter=M&mode=az' }));
    });
});
