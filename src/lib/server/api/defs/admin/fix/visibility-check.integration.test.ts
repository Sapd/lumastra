// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/admin/fix/visibility-check` against real tables, for the parts the gate
 * explanation computes itself rather than borrowing from the access code:
 *   - "present in the library" uses Browse's own filter, so a series counts by
 *     its file-backed episodes, not by its roll-up flag
 *   - a disabled account sees nothing, whatever the gates would allow
 *   - "administrator bypass" is not ticked for a non-admin
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';

vi.mock('$lib/server/database/connection.js', async () => {
    const { getTestDb: db } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { getAdminDb: () => db() };
});

import { def } from './visibility-check.js';
import {
    VisibilityCheckSchema,
    type VisibilityCheck,
} from '$lib/components/admin/fix/visibility-check.schema.js';

const TAG = `vis${Date.now().toString(36)}`;
let sql: postgres.Sql;

async function user(opts: { disabled?: boolean } = {}): Promise<string> {
    const [{ id }] = await sql<[{ id: string }]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups, disabled_at)
        VALUES (${`${TAG}-${crypto.randomUUID().slice(0, 8)}`}, false, true, ${[]}::text[],
                ${opts.disabled ? new Date() : null})
        RETURNING id
    `;
    return id;
}

async function item(
    mediaType: string,
    hasFiles: boolean,
    parentId: string | null = null,
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, created_at, updated_at)
        VALUES (${id}::uuid, ${`${TAG} ${mediaType}`}, ${mediaType}, 'active', ${hasFiles},
                ${parentId}::uuid, now(), now())
    `;
    return id;
}

async function attach(itemId: string): Promise<void> {
    const [{ id }] = await sql<[{ id: string }]>`
        INSERT INTO media_files (file_path) VALUES (${`/data/${TAG}/${itemId}.mkv`}) RETURNING id
    `;
    await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${id}::uuid, ${itemId}::uuid)`;
}

async function check(userId: string, mediaId: string): Promise<VisibilityCheck> {
    const resp = await def.handlers.GET!(
        {} as never,
        { input: { query: { userId, mediaId } } } as never,
    );
    return VisibilityCheckSchema.parse(await (resp as Response).json());
}

const gate = (r: VisibilityCheck, g: string) => r.gates.find((x) => x.gate === g);

beforeAll(() => {
    sql = getTestDb();
});

afterEach(async () => {
    await sql`DELETE FROM media_files WHERE file_path LIKE ${`/data/${TAG}/%`}`;
    await sql`DELETE FROM media_items WHERE title LIKE ${`${TAG}%`}`;
    await sql`DELETE FROM users WHERE username LIKE ${`${TAG}-%`}`;
});

afterAll(async () => {
    await closeTestDb();
});

describe('visibility-check (integration)', () => {
    it('explains the audiobook group floor as its effective rating', async () => {
        const userId = await user(),
            book = await item('audiobook', true),
            group = crypto.randomUUID();
        await sql`UPDATE users SET max_age_rating = 12, age_rating_pinned = true WHERE id = ${userId}`;
        await sql`INSERT INTO library_groups (id, name, max_age_rating) VALUES (${group}, 'Visibility audiobook floor', 18)`;
        try {
            await sql`UPDATE media_items SET library_group_id = ${group} WHERE id = ${book}`;
            const result = await check(userId, book);
            expect(gate(result, 'age-rating')).toMatchObject({
                passed: false,
                code: 'age-above',
                params: { rating: 18, max: 12 },
            });
        } finally {
            await sql`DELETE FROM library_groups WHERE id = ${group}`;
        }
    });

    it('a movie with a file is present in the library', async () => {
        const movie = await item('movie', true);
        await attach(movie);
        const r = await check(await user(), movie);
        expect(r.browsable).toBe(true);
        expect(gate(r, 'has-files')?.passed).toBe(true);
    });

    it('a series flagged has_files with no file-backed episode is not present', async () => {
        const series = await item('tv', true);
        const r = await check(await user(), series);
        expect(r.browsable).toBe(false);
        expect(gate(r, 'has-files')?.passed).toBe(false);
        expect(gate(r, 'has-files')?.code).toBe('files-container-none');
    });

    it('a series is present through a file-backed episode', async () => {
        const series = await item('tv', false);
        const season = await item('season', true, series);
        const episode = await item('episode', true, season);
        await attach(episode);
        const r = await check(await user(), series);
        expect(r.browsable).toBe(true);
    });

    it('a disabled account sees nothing, and the account gate says why', async () => {
        const movie = await item('movie', true);
        await attach(movie);
        const r = await check(await user({ disabled: true }), movie);
        expect(r.visible).toBe(false);
        expect(r.blockedBy).toBe('account');
    });

    it('administrator bypass is not ticked for a non-admin', async () => {
        const movie = await item('movie', true);
        await attach(movie);
        const r = await check(await user(), movie);
        expect(r.visible).toBe(true);
        expect(gate(r, 'admin-bypass')?.evaluated).toBe(false);
    });
});
