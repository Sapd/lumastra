// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { visibleNavItems } from './visible-nav-items';

const ITEMS = [
    { id: 'open', url: '/browse' },
    { id: 'empty-groups', url: '/music', groups: [] },
    { id: 'staff', url: 'https://grafana.internal', groups: ['Staff'] },
    { id: 'admin-only', url: '/admin', groups: ['__ADMIN__'] },
];

const ids = (items: Array<{ id: string }>): string[] => items.map((i) => i.id);

describe('visibleNavItems', () => {
    it('gives an anonymous visitor nothing', () => {
        expect(visibleNavItems(ITEMS, undefined)).toEqual([]);
        expect(visibleNavItems(ITEMS, null)).toEqual([]);
    });

    it('hides group-restricted and admin-only items from an ordinary user', () => {
        expect(ids(visibleNavItems(ITEMS, { userGroups: ['users'] }))).toEqual([
            'open',
            'empty-groups',
        ]);
    });

    it('shows an item to a member of a listed group, case-insensitively', () => {
        expect(ids(visibleNavItems(ITEMS, { userGroups: ['staff'] }))).toEqual([
            'open',
            'empty-groups',
            'staff',
        ]);
    });

    it('shows everything to an admin', () => {
        expect(ids(visibleNavItems(ITEMS, { isAdmin: true }))).toEqual(ids(ITEMS));
    });

    it('a member of an admin GROUP without the admin verdict does not get __ADMIN__ items', () => {
        // The verdict wins (admin_pinned can demote a member of an admin group).
        expect(
            ids(visibleNavItems(ITEMS, { isAdmin: false, userGroups: ['admin'] })),
        ).not.toContain('admin-only');
    });
});
