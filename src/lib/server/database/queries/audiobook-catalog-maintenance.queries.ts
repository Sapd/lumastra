// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { Logger } from '../../utils/logger.js';
import { deriveSortTitle } from '../../utils/sort-title.js';
import { withTx } from '../with-tx.js';
import type { AudiobookshelfMetadata } from './audiobooks.queries.js';

/** Serialize link replacement against orphan deletion, including concurrent sweeps. */
export async function lockAudiobookCatalog(sql: postgres.Sql): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext('audiobook-catalog'))`;
}

const logger = Logger.for('AudiobookCatalog');

/** NFC display form and case-insensitive key; Unicode White_Space plus BOM. */
export function normalizeAudiobookName(name: string, display = false): string {
    const nfc = name.normalize('NFC');
    if (nfc.includes('\0') || [...nfc].length > 512) {
        logger.debug('Skipping invalid audiobook catalog name');
        return '';
    }
    const cleaned = nfc.replace(/[\p{White_Space}\uFEFF]+/gu, ' ').trim();
    return display ? cleaned : cleaned.toLowerCase();
}

/** Called in the same transaction as the book write; lock the book before replacing links. */
export async function syncAudiobookCatalog(
    sql: postgres.Sql,
    mediaId: string,
    metadata: AudiobookshelfMetadata,
): Promise<void> {
    return withTx(sql, async (sql) => {
        await lockAudiobookCatalog(sql);
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- sync-side maintenance of one book by id; no viewer
        const [book] = await sql<{ id: string }[]>`SELECT id FROM media_items
            WHERE id = ${mediaId}::uuid AND media_type = 'audiobook'
                AND NOT is_dismissed AND status = 'active' AND has_files FOR UPDATE`;
        if (!book) return;
        await sql`DELETE FROM audiobook_book_contributors WHERE media_id = ${mediaId}::uuid`;
        for (const role of ['author', 'narrator'] as const) {
            const raw = role === 'author' ? metadata?.authors : metadata?.narrators;
            const names = Array.isArray(raw) ? raw : [];
            const seen = new Set<string>();
            for (const [position, name] of names.entries()) {
                if (typeof name !== 'string') continue;
                const normalized = normalizeAudiobookName(name);
                if (!normalized || seen.has(normalized)) continue;
                seen.add(normalized);
                const [person] = await sql<{ id: string }[]>`
                INSERT INTO audiobook_contributors (name, normalized_name) VALUES (${normalizeAudiobookName(name, true)}, ${normalized})
                ON CONFLICT (normalized_name) DO UPDATE SET normalized_name = EXCLUDED.normalized_name RETURNING id
            `;
                await sql`INSERT INTO audiobook_book_contributors (media_id, contributor_id, role, position)
                VALUES (${mediaId}::uuid, ${person.id}::uuid, ${role}, ${position})`;
            }
        }
        const series = metadata?.derivedSeries;
        const normalized =
            typeof series?.name === 'string' ? normalizeAudiobookName(series.name) : '';
        if (series && typeof series.name === 'string' && normalized) {
            const [row] = await sql<{ id: string }[]>`
            INSERT INTO audiobook_series (name, normalized_name, sort_name)
            VALUES (${normalizeAudiobookName(series.name, true)}, ${normalized}, ${deriveSortTitle(normalizeAudiobookName(series.name, true))})
            ON CONFLICT (normalized_name) DO UPDATE SET normalized_name = EXCLUDED.normalized_name RETURNING id
        `;
            await sql`INSERT INTO audiobook_book_series (media_id, series_id, sequence)
            VALUES (${mediaId}::uuid, ${row.id}::uuid, ${typeof series.sequence === 'number' && Number.isFinite(series.sequence) ? series.sequence : null})
            ON CONFLICT (media_id) DO UPDATE SET series_id = EXCLUDED.series_id, sequence = EXCLUDED.sequence`;
        } else {
            await sql`DELETE FROM audiobook_book_series WHERE media_id = ${mediaId}::uuid`;
        }
    });
}

export async function cleanupAudiobookCatalog(sql: postgres.Sql): Promise<void> {
    return withTx(sql, async (sql) => {
        await lockAudiobookCatalog(sql);
        await sql`DELETE FROM audiobook_contributors c WHERE NOT EXISTS (
        SELECT 1 FROM audiobook_book_contributors bc WHERE bc.contributor_id = c.id)`;
        await sql`DELETE FROM audiobook_series s WHERE NOT EXISTS (
        SELECT 1 FROM audiobook_book_series bs WHERE bs.series_id = s.id)`;
    });
}
