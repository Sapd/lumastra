// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Channel layout export/import.
 *
 * A "channel layout" is a portable snapshot of channel *curation* — ordering,
 * categories, visibility, and admin renames — independent of the underlying
 * provider. Exporting before switching Live TV providers and importing after
 * re-applies that curation to the new provider's channels by fuzzy matching on
 * the normalized base name (+ country, with EPG-id as a tiebreaker). It is a
 * best-effort ~80% restore: matches get the curation, the new provider's extra
 * channels are appended after, and layout entries with no match are reported.
 * The import is purely additive — it never deletes channels.
 *
 * @module services/livetv/channel-layout
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { extractBaseName } from './auto-processor.js';
import type {
    ChannelLayout,
    ChannelLayoutEntry,
    LayoutImportResponse,
} from '$lib/schemas/livetv.js';

// ── Matching (pure) ─────────────────────────────────────────────────────

/** A current-provider channel reduced to its cross-provider match key. */
export interface MatchableChannel {
    id: string;
    /** Normalized base name (quality/feed markers stripped), lowercased. */
    baseName: string;
    epgId: string | null;
    country: string | null;
}

export interface LayoutMatchResult {
    /** Layout entries paired with the current channel they re-curate. */
    matched: Array<{ channelId: string; entry: ChannelLayoutEntry }>;
    /** Layout entries with no current channel to apply to. */
    exportOnly: ChannelLayoutEntry[];
    /** Current channels not claimed by any layout entry (new-provider extras). */
    newOnly: string[];
}

function matchKey(baseName: string, country: string | null | undefined): string {
    return `${baseName}|${country ?? ''}`;
}

/**
 * Match layout entries to the current provider's channels. Primary key is the
 * normalized base name + country; when several channels share that key, an equal
 * EPG-id breaks the tie. Each channel is claimed at most once; entry order is
 * preserved so the first claimant wins a contested channel.
 */
export function matchChannelLayout(
    entries: ChannelLayoutEntry[],
    current: MatchableChannel[],
): LayoutMatchResult {
    const byKey = new Map<string, MatchableChannel[]>();
    for (const ch of current) {
        const k = matchKey(ch.baseName, ch.country);
        const bucket = byKey.get(k);
        if (bucket) bucket.push(ch);
        else byKey.set(k, [ch]);
    }

    const claimed = new Set<string>();
    const matched: LayoutMatchResult['matched'] = [];
    const exportOnly: ChannelLayoutEntry[] = [];

    for (const entry of entries) {
        const candidates = (
            byKey.get(matchKey(entry.match.baseName, entry.match.country)) ?? []
        ).filter((c) => !claimed.has(c.id));
        if (candidates.length === 0) {
            exportOnly.push(entry);
            continue;
        }
        let pick = candidates[0];
        if (entry.match.epgId) {
            const epgMatch = candidates.find(
                (c) => c.epgId != null && c.epgId === entry.match.epgId,
            );
            if (epgMatch) pick = epgMatch;
        }
        claimed.add(pick.id);
        matched.push({ channelId: pick.id, entry });
    }

    const newOnly = current.filter((c) => !claimed.has(c.id)).map((c) => c.id);
    return { matched, exportOnly, newOnly };
}

// ── Export ──────────────────────────────────────────────────────────────

interface LayoutChannelRow {
    title: string;
    epg_channel_id: string | null;
    country_code: string | null;
    sort_order: number;
    is_visible: boolean;
    admin_display_name: string | null;
    category_name: string | null;
}

/** Build a portable layout snapshot of all current channels' curation. */
export async function buildChannelLayout(sql: postgres.Sql): Promise<ChannelLayout> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only export of channel curation (route is operator-gated); reads the raw title to build the cross-provider match key
    const rows = await sql<LayoutChannelRow[]>`
		SELECT
			mi.title              AS title,
			lc.epg_channel_id,
			lc.country_code,
			lc.sort_order,
			lc.is_visible,
			lc.admin_display_name,
			lcat.name             AS category_name
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		ORDER BY lc.sort_order ASC
	`;
    const cats = await sql<{ name: string; sort_order: number }[]>`
		SELECT name, sort_order FROM livetv_categories ORDER BY sort_order ASC
	`;

    return {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        categories: cats.map((c) => ({ name: c.name, order: c.sort_order })),
        channels: rows.map((r) => ({
            match: {
                baseName: extractBaseName(r.title).toLowerCase(),
                epgId: r.epg_channel_id ?? null,
                country: r.country_code ?? null,
            },
            sortOrder: r.sort_order,
            category: r.category_name ?? null,
            isVisible: r.is_visible,
            displayName: r.admin_display_name ?? null,
        })),
    };
}

// ── Import ──────────────────────────────────────────────────────────────

/**
 * Re-apply a layout to the current provider's channels. Matched channels get the
 * layout's sort order, category, visibility, and rename; unmatched current
 * channels are appended after the curated block; unmatched layout entries are
 * only counted. Runs in one transaction; never deletes channels.
 */
export async function importChannelLayout(
    sql: postgres.Sql,
    layout: ChannelLayout,
): Promise<LayoutImportResponse> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only layout import (route is operator-gated); reads raw title for cross-provider matching
    const rows = await sql<
        { id: string; title: string; epg_channel_id: string | null; country_code: string | null }[]
    >`
		SELECT lc.id, mi.title, lc.epg_channel_id, lc.country_code
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
	`;
    const current: MatchableChannel[] = rows.map((r) => ({
        id: r.id,
        baseName: extractBaseName(r.title).toLowerCase(),
        epgId: r.epg_channel_id,
        country: r.country_code,
    }));

    const { matched, exportOnly, newOnly } = matchChannelLayout(layout.channels, current);
    const maxLayoutSort = layout.channels.reduce((m, e) => Math.max(m, e.sortOrder), 0);

    await withTx(sql, async (tx) => {
        // Ensure categories exist (matched by name) and carry their order.
        const categoryIdByName = new Map<string, string>();
        for (const cat of layout.categories) {
            const existing = await tx<{ id: string }[]>`
				SELECT id FROM livetv_categories WHERE name = ${cat.name} LIMIT 1
			`;
            if (existing[0]) {
                await tx`
					UPDATE livetv_categories SET sort_order = ${cat.order}, updated_at = NOW()
					WHERE id = ${existing[0].id}
				`;
                categoryIdByName.set(cat.name, existing[0].id);
            } else {
                const inserted = await tx<{ id: string }[]>`
					INSERT INTO livetv_categories (name, sort_order) VALUES (${cat.name}, ${cat.order})
					RETURNING id
				`;
                categoryIdByName.set(cat.name, inserted[0].id);
            }
        }

        // Apply curation to matched channels.
        for (const { channelId, entry } of matched) {
            const categoryId = entry.category
                ? (categoryIdByName.get(entry.category) ?? null)
                : null;
            await tx`
				UPDATE livetv_channels SET
					sort_order = ${entry.sortOrder},
					is_visible = ${entry.isVisible},
					category_id = ${categoryId}::uuid,
					admin_display_name = ${entry.displayName ?? null},
					updated_at = NOW()
				WHERE id = ${channelId}
			`;
        }

        // Append new-provider extras after the curated block, preserving their order.
        let nextSort = maxLayoutSort + 1;
        for (const channelId of newOnly) {
            await tx`
				UPDATE livetv_channels SET sort_order = ${nextSort}, updated_at = NOW()
				WHERE id = ${channelId}
			`;
            nextSort++;
        }
    });

    return { matched: matched.length, appended: newOnly.length, notFound: exportOnly.length };
}
