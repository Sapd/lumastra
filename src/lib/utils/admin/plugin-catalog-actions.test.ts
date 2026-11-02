// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What button a catalog row gets.
 *
 * The interesting cases are the ones where the honest answer is "no button":
 * a version this host cannot install, and a version OLDER than what is already
 * installed. Anti-rollback would refuse the second, and a button that always
 * fails is worse than no button.
 */

import { it, expect } from 'vitest';
import { catalogAction } from './plugin-catalog-actions.js';

const base = {
    version: '1.1.0',
    manifestUrl: 'https://x/m.json',
    signature: 'sig',
    installedVersion: null as string | null,
};

it('offers an install for something not present', () => {
    expect(catalogAction(base)).toBe('install');
});

it('offers an update when the catalog is ahead', () => {
    expect(catalogAction({ ...base, installedVersion: '1.0.0' })).toBe('update');
});

it('says up to date when the versions match', () => {
    expect(catalogAction({ ...base, installedVersion: '1.1.0' })).toBe('current');
});

it('offers NO downgrade when the catalog is behind — anti-rollback would refuse it', () => {
    expect(catalogAction({ ...base, installedVersion: '2.0.0' })).toBe('current');
});

it('reports unavailable when no version matched this host ABI', () => {
    expect(catalogAction({ ...base, version: null })).toBe('unavailable');
});

it('reports unavailable when the entry carries no signature — never offer an unverifiable install', () => {
    expect(catalogAction({ ...base, signature: null })).toBe('unavailable');
    expect(catalogAction({ ...base, manifestUrl: null })).toBe('unavailable');
});

it('compares numerically, not lexically', () => {
    // '10' < '9' as strings — the classic version-sort bug, which here would
    // hide a real update behind "up to date".
    expect(catalogAction({ ...base, version: '1.10.0', installedVersion: '1.9.0' })).toBe('update');
});
