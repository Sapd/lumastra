// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library-group placement fixtures.
 *
 * Puts a media item inside a library group **the way the access filter
 * actually evaluates it**, so a differential access test cannot go false-green
 * against a database state that production never produces.
 *
 * ## Why this helper exists
 *
 * `buildLibraryAccessFilter` dispatches on `mi.media_type`. Leaf rows
 * (`movie`/`episode`/`track`/...) are judged by their OWN `media_file_items`;
 * container rows (`tv`/`season`/`artist`/`album`) are judged by their
 * DESCENDANTS' files plus their own `media_items.library_group_id` column, and
 * never by files attached directly to the container row.
 *
 * That distinction is not cosmetic — it matches reality. On production,
 * every one of the 6,570 `tv`, 4,806 `season`, 4,913 `artist` and 3,547
 * `album` rows owns exactly ZERO `media_file_items`; only leaf rows do
 * (verified 2026-09-15). The file scanner attaches files to episodes and
 * tracks, never to the containers above them.
 *
 * Tests that hand-rolled "attach a `media_files` row to the item" therefore
 * built an impossible state when the item was a container: the container
 * branch ignored the direct file, the `NOT EXISTS (any descendant file)`
 * arm admitted the row as an empty stub, and the restricted boundary
 * returned the unrestricted result. Six differential tests failed for exactly
 * that reason once the container-aware branches landed (147ecc40d and
 * follow-ups, 2026-09-13).
 *
 * Routing every placement through this helper keeps the fixture and the
 * predicate on the same model of the world: give it a container and it builds
 * the descendant chain the filter walks, exactly as a scan would.
 */

import type postgres from 'postgres';
import { randomUUID } from 'crypto';

/** Media types this helper knows how to place. */
export type PlaceableMediaType =
    'tv' | 'season' | 'artist' | 'album' | 'movie' | 'episode' | 'track' | 'audiobook' | 'extra';

/**
 * Descendant chain each container type needs before a file can be attached
 * somewhere the filter will actually look. The last entry owns the file.
 */
const DESCENDANT_CHAIN: Partial<Record<PlaceableMediaType, readonly PlaceableMediaType[]>> = {
    tv: ['season', 'episode'],
    season: ['episode'],
    artist: ['album', 'track'],
    album: ['track'],
};

export interface PlaceInLibraryGroupResult {
    /** The `media_files` row carrying `library_group_id`. */
    fileId: string;
    /** The item the file is attached to — the item itself, or its leaf descendant. */
    fileOwnerId: string;
    /** Descendant rows created to reach a file-owning leaf, outermost first. */
    createdDescendantIds: string[];
}

/**
 * Place `mediaItemId` in `libraryGroupId` so the library-access predicate can
 * exclude it.
 *
 * A leaf item gets the file directly. A container gets a freshly-created
 * descendant chain (`tv` -> season -> episode, `album` -> track, ...) whose
 * leaf owns the file — which is the only shape `buildLibraryAccessFilter`
 * inspects for container rows, and the only shape a real scan produces.
 *
 * `has_files` is propagated up the created chain and onto the item itself,
 * mirroring the scanner's own ancestor propagation.
 *
 * @param sql - test database handle
 * @param opts.mediaItemId - the item to place
 * @param opts.mediaType - its `media_items.media_type`; decides leaf vs container
 * @param opts.libraryGroupId - the group the file lands in
 */
export async function placeInLibraryGroup(
    sql: postgres.Sql,
    opts: {
        mediaItemId: string;
        mediaType: PlaceableMediaType;
        libraryGroupId: string;
    },
): Promise<PlaceInLibraryGroupResult> {
    const chain = DESCENDANT_CHAIN[opts.mediaType] ?? [];
    const createdDescendantIds: string[] = [];

    // Build the descendant chain, each row parented to the previous one.
    let parentId = opts.mediaItemId;
    for (const childType of chain) {
        const childId = randomUUID();
        await sql`
            INSERT INTO media_items (id, parent_id, title, media_type, status, has_files)
            VALUES (
                ${childId}::uuid,
                ${parentId}::uuid,
                ${`Access fixture ${childType} ${childId.slice(0, 8)}`},
                ${childType},
                'active',
                true
            )
        `;
        // season/episode rows carry their numbers; harmless elsewhere. The
        // number is taken one past the highest sibling rather than hardcoded:
        // `uq_media_items_season` / `uq_media_items_episode` are unique per
        // parent, and the item being placed may already own seasons/episodes
        // seeded by the test itself.
        if (childType === 'season') {
            await sql`
                UPDATE media_items SET season_number = (
                    SELECT COALESCE(MAX(sibling.season_number), 0) + 1
                    FROM media_items sibling
                    WHERE sibling.parent_id = ${parentId}::uuid
                      AND sibling.media_type = 'season'
                )
                WHERE id = ${childId}::uuid
            `;
        } else if (childType === 'episode') {
            await sql`
                UPDATE media_items
                SET season_number = (
                        SELECT parent.season_number FROM media_items parent
                        WHERE parent.id = ${parentId}::uuid
                    ),
                    episode_number = (
                        SELECT COALESCE(MAX(sibling.episode_number), 0) + 1
                        FROM media_items sibling
                        WHERE sibling.parent_id = ${parentId}::uuid
                          AND sibling.media_type = 'episode'
                    )
                WHERE id = ${childId}::uuid
            `;
        }
        createdDescendantIds.push(childId);
        parentId = childId;
    }

    // `parentId` is now the leaf that should own the file: the item itself when
    // it is already a leaf, otherwise the bottom of the chain just created.
    const fileOwnerId = parentId;
    const fileId = randomUUID();
    await sql`
        INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
        VALUES (
            ${fileId}::uuid,
            ${`/test/library-access/${fileOwnerId}.mkv`},
            ${opts.libraryGroupId}::uuid,
            NOW(),
            NOW()
        )
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${fileId}::uuid, ${fileOwnerId}::uuid)
        ON CONFLICT DO NOTHING
    `;
    await sql`UPDATE media_items SET has_files = true WHERE id = ${opts.mediaItemId}::uuid`;

    return { fileId, fileOwnerId, createdDescendantIds };
}
