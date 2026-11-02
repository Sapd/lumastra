// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Integration tests for buildLibraryViews (GET /j/UserViews, /j/Items root).
 *
 * Regression coverage for the bug where /j clients (Streamyfin, Infuse, etc.)
 * showed the raw filesystem folder name ("4kmovies") instead of the
 * admin-configured library display name ("4K Movies") — buildLibraryViews
 * derived Name from the last path segment instead of joining library_groups.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { buildLibraryViews } from './library-views-utils.js';
import { verifyLibraryImageTag } from './library-image-tag.js';

const ADMIN_USER = { ownerIsAdmin: true };

describe('buildLibraryViews', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['library_paths', 'library_groups']);
    });

    it('uses the library group display_name when set', async () => {
        const groupId = randomUUID();
        await sql`
            INSERT INTO library_groups (id, name, display_name)
            VALUES (${groupId}::uuid, '4kmovies', '4K Movies')
        `;
        await sql`
            INSERT INTO library_paths (library_group_id, media_type, path, enabled)
            VALUES (${groupId}::uuid, 'movie', '/data/4kmovies', true)
        `;

        const items = await buildLibraryViews(sql, ADMIN_USER);
        const lib = items.find((i) => i.Id === groupId);
        expect(lib).toBeDefined();
        expect(lib!.Name).toBe('4K Movies');
    });

    it('falls back to the group name when display_name is not set', async () => {
        const groupId = randomUUID();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${groupId}::uuid, 'series')
        `;
        await sql`
            INSERT INTO library_paths (library_group_id, media_type, path, enabled)
            VALUES (${groupId}::uuid, 'tv', '/data/series', true)
        `;

        const items = await buildLibraryViews(sql, ADMIN_USER);
        const lib = items.find((i) => i.Id === groupId);
        expect(lib).toBeDefined();
        expect(lib!.Name).toBe('series');
    });

    // The library tile's art: a signed tag the public /j image route accepts
    // for this library only (library-image-tag.ts).
    it('advertises a signed Primary/Thumb tag that unlocks this library only', async () => {
        const groupId = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}::uuid, 'movies')`;
        await sql`
            INSERT INTO library_paths (library_group_id, media_type, path, enabled)
            VALUES (${groupId}::uuid, 'movie', '/data/movies', true)
        `;

        const lib = (await buildLibraryViews(sql, ADMIN_USER)).find((i) => i.Id === groupId);
        const tag = lib?.ImageTags?.Primary;
        expect(tag).toMatch(/^[0-9a-f]{40}$/);
        expect(lib?.ImageTags?.Thumb).toBe(tag);
        expect(verifyLibraryImageTag(groupId, tag)).toBe(true);
        expect(verifyLibraryImageTag(randomUUID(), tag)).toBe(false);
    });
});
