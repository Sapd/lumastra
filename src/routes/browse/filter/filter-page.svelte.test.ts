// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { load } from './+page.js';
describe('legacy browse filters', () => {
    it('redirects to the unified library without dropping search or filters', () => {
        expect(() =>
            load({
                url: new URL(
                    'https://example.test/browse/filter?genre=Action&q=star&libraryGroupId=kids&res=4K',
                ),
            } as never),
        ).toThrow(
            expect.objectContaining({
                status: 307,
                location: '/browse?genre=Action&q=star&libraryGroupId=kids&res=4K&mode=az',
            }),
        );
    });
});
