// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import {
    getSourceFavoritesForImport,
    restoreSourceFavorites,
    type SourceFavoriteSnapshotRow,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import {
    snapshotSourceChannelIdentities,
    type ImportedChannel,
} from './channel-numbers.service.js';
import { matchChannels, type ExistingChannel } from './channel-matcher.js';

export interface SourceFavoriteSnapshot {
    channels: ExistingChannel[];
    favorites: SourceFavoriteSnapshotRow[];
}

export async function snapshotSourceFavorites(
    sql: postgres.Sql,
    sourceId: string,
): Promise<SourceFavoriteSnapshot | null> {
    const favorites = await getSourceFavoritesForImport(sql, sourceId);
    if (favorites.length === 0) return null;
    return { channels: await snapshotSourceChannelIdentities(sql, sourceId), favorites };
}

/** Same identity matcher as numbers; scoped to this source and the import transaction. */
export async function carryOverSourceFavorites(
    sql: postgres.Sql,
    snapshot: SourceFavoriteSnapshot,
    imported: ImportedChannel[],
): Promise<void> {
    const byProcessed = new Map(imported.map((ch) => [ch.processed, ch.id]));
    const replacement = new Map(
        matchChannels(
            snapshot.channels,
            imported.map((ch) => ch.processed),
        ).matched.map((match) => [match.existingChannel.id, byProcessed.get(match.newChannel)]),
    );
    const rows = snapshot.favorites.flatMap((favorite) => {
        const channel_id = replacement.get(favorite.channel_id);
        return channel_id ? [{ ...favorite, channel_id }] : [];
    });
    await restoreSourceFavorites(sql, rows);
}
