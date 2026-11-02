// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Library Type Settings Query Module
 *
 * Tests CRUD operations for library_type_settings table.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    getAllLibraryTypeSettings,
    getLibraryTypeSetting,
    upsertLibraryTypeSetting,
    deleteLibraryTypeSetting,
    ensureLibraryTypeSetting,
} from './library-type-settings.queries.js';

describe('Library Type Settings Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['library_type_settings']);
    });

    // ========================================================================
    // getAllLibraryTypeSettings
    // ========================================================================

    describe('getAllLibraryTypeSettings', () => {
        it('returns empty array when no settings exist', async () => {
            const result = await getAllLibraryTypeSettings(sql);
            expect(result).toEqual([]);
        });

        it('returns settings ordered by sort_order then media_type', async () => {
            await upsertLibraryTypeSetting(sql, {
                mediaType: 'training',
                displayName: 'TV Shows',
                sidebarVisible: true,
                icon: 'tv',
                sortOrder: 2,
            });
            await upsertLibraryTypeSetting(sql, {
                mediaType: 'home_video',
                displayName: 'Movies',
                sidebarVisible: true,
                icon: 'film',
                sortOrder: 1,
            });

            const result = await getAllLibraryTypeSettings(sql);
            expect(result).toHaveLength(2);
            expect(result[0].media_type).toBe('home_video');
            expect(result[1].media_type).toBe('training');
        });
    });

    // ========================================================================
    // getLibraryTypeSetting
    // ========================================================================

    describe('getLibraryTypeSetting', () => {
        it('returns setting for a media type', async () => {
            await upsertLibraryTypeSetting(sql, {
                mediaType: 'home_video',
                displayName: 'Movies',
                sidebarVisible: true,
                icon: 'film',
                sortOrder: 1,
            });

            const result = await getLibraryTypeSetting(sql, 'home_video');

            expect(result).toBeDefined();
            expect(result!.media_type).toBe('home_video');
            expect(result!.display_name).toBe('Movies');
            expect(result!.sidebar_visible).toBe(true);
            expect(result!.icon).toBe('film');
            expect(result!.sort_order).toBe(1);
        });

        it('returns undefined for non-existent media type', async () => {
            const result = await getLibraryTypeSetting(sql, 'nonexistent');
            expect(result).toBeUndefined();
        });
    });

    // ========================================================================
    // upsertLibraryTypeSetting
    // ========================================================================

    describe('upsertLibraryTypeSetting', () => {
        it('inserts a new setting', async () => {
            const result = await upsertLibraryTypeSetting(sql, {
                mediaType: 'educational',
                displayName: 'Music',
                sidebarVisible: false,
                icon: 'music',
                sortOrder: 3,
            });

            expect(result.media_type).toBe('educational');
            expect(result.display_name).toBe('Music');
            expect(result.sidebar_visible).toBe(false);
            expect(result.icon).toBe('music');
            expect(result.sort_order).toBe(3);
            expect(result.updated_at).toBeInstanceOf(Date);
        });

        it('updates existing setting on conflict', async () => {
            await upsertLibraryTypeSetting(sql, {
                mediaType: 'home_video',
                displayName: 'Old Movies',
                sidebarVisible: true,
                icon: 'film',
                sortOrder: 1,
            });

            const result = await upsertLibraryTypeSetting(sql, {
                mediaType: 'home_video',
                displayName: 'New Movies',
                sidebarVisible: false,
                icon: 'clapperboard',
                sortOrder: 2,
            });

            expect(result.display_name).toBe('New Movies');
            expect(result.sidebar_visible).toBe(false);
            expect(result.icon).toBe('clapperboard');
            expect(result.sort_order).toBe(2);
        });

        it('handles null displayName and icon', async () => {
            const result = await upsertLibraryTypeSetting(sql, {
                mediaType: 'personal',
                displayName: null,
                sidebarVisible: true,
                icon: null,
                sortOrder: 99,
            });

            expect(result.display_name).toBeNull();
            expect(result.icon).toBeNull();
        });
    });

    // ========================================================================
    // deleteLibraryTypeSetting
    // ========================================================================

    describe('deleteLibraryTypeSetting', () => {
        it('deletes a setting and returns true', async () => {
            await upsertLibraryTypeSetting(sql, {
                mediaType: 'training',
                displayName: 'Games',
                sidebarVisible: false,
                icon: 'gamepad',
                sortOrder: 10,
            });

            const deleted = await deleteLibraryTypeSetting(sql, 'training');
            expect(deleted).toBe(true);

            const result = await getLibraryTypeSetting(sql, 'training');
            expect(result).toBeUndefined();
        });

        it('returns false for non-existent media type', async () => {
            const result = await deleteLibraryTypeSetting(sql, 'nonexistent');
            expect(result).toBe(false);
        });
    });

    // ========================================================================
    // ensureLibraryTypeSetting (instance-profile apply)
    // ========================================================================

    describe('ensureLibraryTypeSetting', () => {
        const customised = {
            mediaType: 'training',
            displayName: 'Courses',
            sidebarVisible: false,
            icon: 'academic-cap',
            sortOrder: 7,
        };

        it('creates a visible row when none exists', async () => {
            const wrote = await ensureLibraryTypeSetting(sql, {
                mediaType: 'training',
                sortOrder: 2,
                reveal: false,
            });
            expect(wrote).toBe(true);
            expect(await getLibraryTypeSetting(sql, 'training')).toMatchObject({
                sidebar_visible: true,
                sort_order: 2,
                display_name: null,
            });
        });

        it('leaves an existing row exactly as the admin set it when not revealing', async () => {
            await upsertLibraryTypeSetting(sql, customised);
            const wrote = await ensureLibraryTypeSetting(sql, {
                mediaType: 'training',
                sortOrder: 0,
                reveal: false,
            });
            expect(wrote).toBe(false);
            expect(await getLibraryTypeSetting(sql, 'training')).toMatchObject({
                display_name: 'Courses',
                sidebar_visible: false,
                icon: 'academic-cap',
                sort_order: 7,
            });
        });

        it('revealing shows a hidden row but keeps its name, icon and order', async () => {
            await upsertLibraryTypeSetting(sql, customised);
            const wrote = await ensureLibraryTypeSetting(sql, {
                mediaType: 'training',
                sortOrder: 0,
                reveal: true,
            });
            expect(wrote).toBe(true);
            expect(await getLibraryTypeSetting(sql, 'training')).toMatchObject({
                display_name: 'Courses',
                sidebar_visible: true,
                icon: 'academic-cap',
                sort_order: 7,
            });
        });

        it('revealing an already visible row writes nothing', async () => {
            await upsertLibraryTypeSetting(sql, { ...customised, sidebarVisible: true });
            const wrote = await ensureLibraryTypeSetting(sql, {
                mediaType: 'training',
                sortOrder: 0,
                reveal: true,
            });
            expect(wrote).toBe(false);
        });
    });
});
