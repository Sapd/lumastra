// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolves WHAT the Top Shelf overlay should burn for an item — the policy
 * layer over the pure token/style primitives.
 *
 * Movies/series prefer their title-treatment logo and fall back to title text.
 * Episodes prefer the INHERITED series logo plus a small `S01E02` badge —
 * `getImageMetadata(..., 'logo')` walks the parent chain (episode → season →
 * series) with a presence-ranked CTE, so an episode resolves its series' logo.
 * Only an episode whose series has no logo at all falls back to burning
 * `S01E02 · Name` as text.
 */

import type postgres from 'postgres';
import { isEpisode } from '$lib/server/utils/media-types.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getMediaItemOverlayFields } from '$lib/server/database/queries/topshelf-overlay.queries.js';
import { getImageMetadata } from '$lib/server/database/queries/catalog-operations.queries.js';
import {
    computeOverlayContentHash,
    type OverlayMode,
    type OverlayStyle,
} from './topshelf-overlay.js';

const logger = Logger.for('TopShelfOverlayResolver');

export interface ResolvedOverlay {
    mode: OverlayMode;
    /** Present for mode 'text'. */
    text?: string;
    /**
     * Present for mode 'logo' on EPISODES only — the small `S01E02` chip the
     * compositor bakes under the inherited series logo. Absent for movies and
     * series (plain logo), and for episodes with no season/episode number.
     */
    badge?: string;
    /** Present for 'logo' and 'text'. */
    contentHash?: string;
}

function pad2(n: number): string {
    return n.toString().padStart(2, '0');
}

/**
 * `S01E02`-style badge for an episode. Each segment is dropped when its number
 * is null (a season-less episode still gets `E02`); both null → no badge, and
 * the logo is then burned bare.
 */
function episodeBadge(fields: {
    seasonNumber: number | null;
    episodeNumber: number | null;
}): string | null {
    const season = fields.seasonNumber !== null ? `S${pad2(fields.seasonNumber)}` : '';
    const episode = fields.episodeNumber !== null ? `E${pad2(fields.episodeNumber)}` : '';
    const badge = `${season}${episode}`;
    return badge.length > 0 ? badge : null;
}

/**
 * `title` is already pre-trimmed (see `resolveOverlay`) — a whitespace-only
 * title trims to `null` upstream, so this never has to re-check blankness.
 */
function episodeLabel(fields: {
    seasonNumber: number | null;
    episodeNumber: number | null;
    title: string | null;
}): string | null {
    const parts: string[] = [];
    if (fields.seasonNumber !== null && fields.episodeNumber !== null) {
        parts.push(`S${pad2(fields.seasonNumber)}E${pad2(fields.episodeNumber)}`);
    }
    if (fields.title) parts.push(fields.title);
    if (parts.length === 0) return null;
    return parts.join(' · ');
}

/**
 * Logo identity for `mediaId` — the inherited `logo_path` (parent chain) or the
 * item's own custom logo URL. Returns null when the item genuinely has no logo.
 */
async function resolveLogoIdentity(
    sql: postgres.Sql,
    mediaId: string,
    customLogoUrl: string | null,
): Promise<string | null> {
    const meta = await getImageMetadata(sql, mediaId, 'logo').catch((err: unknown) => {
        // Do not let a real DB error masquerade as "this item has no logo" —
        // log it before falling back so an outage is visible instead of
        // silently degrading every logo-mode overlay to text.
        logger.warn('Top Shelf overlay logo metadata lookup failed', {
            mediaId,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    });
    return meta?.logo_path ?? customLogoUrl;
}

export async function resolveOverlay(
    sql: postgres.Sql,
    mediaId: string,
    _style: OverlayStyle,
    _locale: string,
): Promise<ResolvedOverlay> {
    const fields = await getMediaItemOverlayFields(sql, mediaId);
    if (!fields) return { mode: 'none' };

    // A whitespace-only title (`"   "`) passes a bare truthiness check and
    // would otherwise render a visually-blank overlay. Treat it as absent —
    // this is the ONE place title-presence is decided; every fallback below
    // reads this trimmed value, never `fields.title` directly.
    const title = fields.title?.trim() || null;

    // Episode: inherited series logo + `S01E02` badge, else the text label.
    if (isEpisode(fields.mediaType)) {
        const badge = episodeBadge(fields);
        const logoIdentity = await resolveLogoIdentity(sql, mediaId, fields.customLogoUrl);
        if (logoIdentity) {
            return {
                mode: 'logo',
                ...(badge ? { badge } : {}),
                contentHash: computeOverlayContentHash({
                    mode: 'logo',
                    identity: `${logoIdentity}|${fields.updatedAt}`,
                    ...(badge ? { badge } : {}),
                }),
            };
        }
        const label = episodeLabel({ ...fields, title });
        if (!label) return { mode: 'none' };
        return {
            mode: 'text',
            text: label,
            contentHash: computeOverlayContentHash({ mode: 'text', text: label }),
        };
    }

    // Movie / series: prefer the logo (no badge), else fall back to title text.
    const logoIdentity = await resolveLogoIdentity(sql, mediaId, fields.customLogoUrl);
    if (logoIdentity) {
        return {
            mode: 'logo',
            contentHash: computeOverlayContentHash({
                mode: 'logo',
                identity: `${logoIdentity}|${fields.updatedAt}`,
            }),
        };
    }

    if (title) {
        return {
            mode: 'text',
            text: title,
            contentHash: computeOverlayContentHash({ mode: 'text', text: title }),
        };
    }
    return { mode: 'none' };
}
