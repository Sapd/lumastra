// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    ADMIN_LEGACY_PATHS,
    ADMIN_LEGACY_PREFIXES,
    resolveLegacyAdminPath,
    appendLegacySearch,
} from './admin-legacy-paths.js';
import { getAllAdminNavPaths } from './admin-nav.js';

describe('resolveLegacyAdminPath', () => {
    it('resolves an exact legacy hit', () => {
        expect(resolveLegacyAdminPath('/admin/sessions')).toBe('/admin/users/sessions');
    });

    it('resolves an exact legacy hit that carries a query/anchor target', () => {
        expect(resolveLegacyAdminPath('/admin/security')).toBe('/admin/system/health#security');
        expect(resolveLegacyAdminPath('/admin/cluster')).toBe('/admin/system/health?tab=cluster');
    });

    it('resolves a prefix hit, preserving the rest of the path', () => {
        expect(resolveLegacyAdminPath('/admin/media/abc-123')).toBe('/admin/library/media/abc-123');
        expect(resolveLegacyAdminPath('/admin/operations/jobs/some-task-id')).toBe(
            '/admin/tasks/some-task-id',
        );
    });

    it('resolves the bare prefix itself (no trailing segment)', () => {
        expect(resolveLegacyAdminPath('/admin/media')).toBe('/admin/library/media');
        expect(resolveLegacyAdminPath('/admin/operations/jobs')).toBe('/admin/tasks');
    });

    it('does not treat a sibling path sharing a prefix string as a match', () => {
        // '/admin/media-library' must NOT match the '/admin/media' prefix
        expect(resolveLegacyAdminPath('/admin/media-library')).toBeNull();
    });

    it('returns null for an unknown, never-existed path', () => {
        expect(resolveLegacyAdminPath('/admin/totally-made-up-xyz')).toBeNull();
    });

    it('returns null for every currently valid admin-nav path', () => {
        for (const path of getAllAdminNavPaths()) {
            expect(resolveLegacyAdminPath(path)).toBeNull();
        }
    });

    it('never has a legacy key that collides with a current admin-nav path', () => {
        const validPaths = getAllAdminNavPaths();
        for (const key of Object.keys(ADMIN_LEGACY_PATHS)) {
            expect(
                validPaths.has(key),
                `legacy key ${key} collides with a valid admin-nav path`,
            ).toBe(false);
        }
        for (const key of Object.keys(ADMIN_LEGACY_PREFIXES)) {
            expect(
                validPaths.has(key),
                `legacy prefix ${key} collides with a valid admin-nav path`,
            ).toBe(false);
        }
    });
});

describe('appendLegacySearch', () => {
    it('returns the target unchanged when there is no incoming search', () => {
        expect(appendLegacySearch('/admin/users/sessions', '')).toBe('/admin/users/sessions');
    });

    it('appends a plain query to a plain target', () => {
        expect(appendLegacySearch('/admin/tasks/pipeline', '?days=7')).toBe(
            '/admin/tasks/pipeline?days=7',
        );
    });

    it('places the query BEFORE an existing anchor', () => {
        expect(appendLegacySearch('/admin/system/health#security', '?foo=bar')).toBe(
            '/admin/system/health?foo=bar#security',
        );
    });

    it('merges incoming search with a target that already has its own query', () => {
        expect(appendLegacySearch('/admin/system/health?tab=cluster', '?nodeId=web-1')).toBe(
            '/admin/system/health?tab=cluster&nodeId=web-1',
        );
    });
});
