// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { canRead, canPost, canModerate } from './access.js';

const cfg = { readGroups: ['members'], postGroups: ['posters'], adminGroups: ['mods'] };
const u = (groups: string[], isAdmin = false) => ({ username: 'x', groups, isAdmin });

describe('shoutbox access', () => {
    it('canRead: empty readGroups = all', () => {
        expect(canRead(u([]), { ...cfg, readGroups: [] })).toBe(true);
    });
    it('canRead: requires membership when set; admin always', () => {
        expect(canRead(u(['members']), cfg)).toBe(true);
        expect(canRead(u(['other']), cfg)).toBe(false);
        expect(canRead(u(['other'], true), cfg)).toBe(true);
    });
    it('canPost: needs read AND post membership', () => {
        expect(canPost(u(['members', 'posters']), cfg)).toBe(true);
        expect(canPost(u(['posters']), cfg)).toBe(false); // not a reader
        expect(canPost(u(['members']), cfg)).toBe(false); // reader, not poster
        expect(canPost(u([], true), cfg)).toBe(true); // admin
    });
    it('canModerate: adminGroups OR host admin; empty adminGroups = host admins only', () => {
        expect(canModerate(u(['mods']), cfg)).toBe(true);
        expect(canModerate(u([], true), cfg)).toBe(true);
        expect(canModerate(u(['members']), { ...cfg, adminGroups: [] })).toBe(false);
        expect(canModerate(u([], true), { ...cfg, adminGroups: [] })).toBe(true);
    });
    it('a group list saved as comma-separated text is matched by whole name, not substring', () => {
        const legacy = { readGroups: 'admins, family', postGroups: '', adminGroups: '' };
        expect(canRead(u(['admin']), legacy)).toBe(false); // "admins" contains "admin"
        expect(canRead(u(['family']), legacy)).toBe(true);
        expect(canPost(u(['family']), legacy)).toBe(true); // '' = all readers
    });
});
