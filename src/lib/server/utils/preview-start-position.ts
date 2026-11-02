// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Server-side default for a preview's start position.
 *
 * WHY THIS EXISTS: the smart start-position heuristic used to live only in the
 * web client, so any client that did not implement it (tvOS) got the raw
 * `startPositionSeconds ?? 0` default and every unwatched movie preview opened
 * on the distributor logo reel. Rather than port the heuristic into Swift — a
 * second copy that would inevitably drift — the server now fills it in when the
 * client omits the field.
 *
 * CONTRACT:
 *  - Caller supplied a value (including an explicit 0)  → honoured verbatim.
 *    Trailers and Live TV rely on being able to pin 0.
 *  - Caller omitted the field                           → runtime-proportional
 *    position from `$lib/shared/preview-position`, the SAME module the web
 *    client uses.
 *
 * Resolution is deterministic in the media UUID, so repeat requests for the
 * same item produce the same seek and stay coalescable by the preview cache's
 * seek bucketing (see findReusablePreview / buildPreviewKey).
 *
 * @module server/utils/preview-start-position
 */

import type postgres from 'postgres';
import {
    calculateSmartPreviewPosition,
    PREVIEW_FALLBACK_START_SECONDS,
} from '$lib/shared/preview-position.js';
import { Logger } from './logger.js';

const logger = Logger.for('PreviewStartPosition');

/**
 * Resolve the start position for a preview session.
 *
 * @param sql        - postgres client
 * @param internalId - internal media UUID the preview will play
 * @param provided   - `startPositionSeconds` from the request body, if any
 * @returns seconds to seek to
 */
export async function resolvePreviewStartPosition(
    sql: postgres.Sql | null,
    internalId: string | undefined,
    provided: number | undefined,
): Promise<number> {
    // An explicit value always wins — including 0, which trailers and Live TV
    // depend on. Only a genuinely absent field triggers the heuristic.
    if (typeof provided === 'number') return provided;

    if (!sql || !internalId) return PREVIEW_FALLBACK_START_SECONDS;

    try {
        // Single PK lookup. Runtime lives on media_items directly, so this does
        // not need the provider_metadata lateral. Access is already gated by the
        // caller (isMediaAccessible) before this runs.
        const [row] = await sql<{ runtime_seconds: number | null }[]>`
            SELECT runtime_seconds
            FROM media_items
            WHERE id = ${internalId}::uuid
            LIMIT 1
        `;

        const runtimeSeconds = row?.runtime_seconds ?? 0;
        return calculateSmartPreviewPosition({
            runtimeMinutes: runtimeSeconds > 0 ? runtimeSeconds / 60 : undefined,
            itemKey: internalId,
        });
    } catch (err) {
        // Never fail a preview over the start offset — fall back to the blind
        // post-logo constant.
        logger.warn('Failed to load runtime; using fallback', {
            internalId,
            error: err instanceof Error ? err.message : String(err),
        });
        return PREVIEW_FALLBACK_START_SECONDS;
    }
}
