// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { playlistsWithImages, playlistWithImages } from './playlist-transforms.js';
import type { PlaylistRow } from '../database/queries/playlists.queries.js';

let reads = 0;
const sql = postgres(getTestDatabaseUrl(), {
    max: 2,
    debug() {
        reads++;
    },
    onnotice() {},
});
const owner = randomUUID();
const otherOwner = randomUUID();
const movie = randomUUID();
const book = randomUUID();
const missing = randomUUID();
const row: PlaylistRow = {
    id: 1,
    user_id: owner,
    owner_display_name: 'Fictional Curator',
    name: 'Lunar Collection',
    description: null,
    visibility: 'private',
    revision: 1,
    cover_image: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    member_count: 2,
    item_count: 3,
    cover_items: [movie, book, missing].map((id, position) => ({
        internal_id: id,
        primary_ext_id: null,
        media_type: position === 1 ? 'audiobook' : 'movie',
        poster_url: null,
        position,
    })),
};

beforeAll(async () => {
    await sql`INSERT INTO users (id, username, display_name) VALUES (${owner}::uuid, ${'fixture_' + owner}, 'Fictional Curator')`;
    await sql`INSERT INTO users (id, username, display_name) VALUES (${otherOwner}::uuid, ${'fixture_' + otherOwner}, 'Other Fictional Curator')`;
    await sql`UPDATE users SET avatar_data = ${Buffer.from('fictional-avatar')}, avatar_updated_at = '2026-01-01T00:00:00Z' WHERE id = ${owner}::uuid`;
    await sql`INSERT INTO media_items (id,title,media_type,status,custom_poster_url) VALUES (${movie}::uuid, 'Moonlit Feature', 'movie', 'active', '/fictional/poster.jpg')`;
    await sql`INSERT INTO media_items (id,title,media_type,status,custom_metadata) VALUES (${book}::uuid, 'Lunar Chronicle', 'audiobook', 'active', '{"audiobookshelf":{"updatedAt":"edition-one"}}'::jsonb)`;
    // Warm one-time configuration discovery before counting list reads.
    await playlistWithImages(sql, row, 'owner', 'v1');
});
afterAll(async () => {
    await sql`DELETE FROM media_items WHERE id IN (${movie}::uuid, ${book}::uuid)`;
    await sql`DELETE FROM users WHERE id IN (${owner}::uuid, ${otherOwner}::uuid)`;
    await sql.end();
});

it('resolves overlapping covers and owners in a bounded number of reads', async () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
        row: {
            ...row,
            user_id: i % 2 ? otherOwner : owner,
            id: i + 1,
            name: `Lunar Collection ${i}`,
        },
        role: i % 2 ? ('editor' as const) : ('owner' as const),
    }));
    reads = 0;
    const items = await playlistsWithImages(sql, entries, 'v1');
    expect(reads).toBeLessThanOrEqual(3);
    expect(items.map((item) => item.id)).toEqual(entries.map(({ row }) => row.id));
    expect(items.map((item) => item.role)).toEqual(entries.map(({ role }) => role));
    expect(items.map((item) => item.owner.userId)).toEqual(entries.map(({ row }) => row.user_id));
    expect(items[0].owner.images.primary?.revision).toBe('1767225600000');
    expect(items[1].owner.images.primary?.revision).toBe('0');
    const cover = new URL(items[0].images.primary!.href, 'https://example.test');
    expect(cover.pathname).toMatch(/^\/api\/v1\//);
    expect(cover.searchParams.get('ids')?.split(',')).toEqual([movie, book]);
    expect(
        items.every((item) => item.images.primary?.revision === items[0].images.primary?.revision),
    ).toBe(true);
    const previousRevision = items[0].images.primary!.revision;
    await sql`UPDATE media_items SET custom_metadata = '{"audiobookshelf":{"updatedAt":"edition-two"}}'::jsonb WHERE id = ${book}::uuid`;
    expect((await playlistsWithImages(sql, entries, 'v1'))[0].images.primary!.revision).not.toBe(
        previousRevision,
    );
});

it('preserves custom covers, empty playlists and a single-resource response', async () => {
    const items = await playlistsWithImages(
        sql,
        [
            { row: { ...row, cover_image: '/fictional/custom.jpg' }, role: 'readonly' },
            { row: { ...row, id: 2, cover_items: [] }, role: 'editor' },
        ],
        'internal',
    );
    expect(items[0].images.primary?.href).toMatch(/^\/fictional\/custom.jpg\?v=/);
    expect(items[0].role).toBe('readonly');
    expect(items[1].images).toEqual({});
    expect(items[1]).toEqual(
        await playlistWithImages(sql, { ...row, id: 2, cover_items: [] }, 'editor', 'internal'),
    );
});

it('performs no reads for an empty page', async () => {
    reads = 0;
    expect(await playlistsWithImages(sql, [], 'internal')).toEqual([]);
    expect(reads).toBe(0);
});
