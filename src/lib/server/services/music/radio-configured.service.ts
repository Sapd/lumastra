// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cached "is radio configured on this server" check.
 *
 * Wraps {@link hasRadioStations} (a global, non-access-scoped EXISTS query) in
 * the unified cache so the root layout can call it on every authed request
 * without hitting the DB each time. Used to gate the Radio navigation item and
 * the /music/radio page: Radio only appears once ≥1 station exists.
 *
 * The 60s TTL means a newly-added first station shows up in the nav within
 * roughly a minute. Cache-layer failures fall through to the underlying query
 * so a Valkey outage never hides a configured radio.
 */

import type postgres from 'postgres';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { hasRadioStations } from '$lib/server/database/queries/music.queries';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('RadioConfigured');

/** Global key — the check is server-wide, not per-user. */
const RADIO_CONFIGURED_KEY = 'all';

/**
 * Returns whether at least one radio station is configured on this server,
 * cached for ~60s. Returns `false` on any error so the nav/page fails closed
 * (hidden) rather than crashing the layout load.
 */
export async function isRadioConfigured(sql: postgres.Sql): Promise<boolean> {
    const cache = cacheManager.for(CACHE_NAMESPACES.musicRadioConfigured);

    try {
        const cached = await cache.get<boolean>(RADIO_CONFIGURED_KEY);
        if (cached !== null) {
            return cached;
        }
    } catch (err) {
        logger.warn('radio-configured cache read failed; falling through', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    let configured: boolean;
    try {
        configured = await hasRadioStations(sql);
    } catch (err) {
        logger.warn('radio-configured query failed; defaulting to false', {
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }

    try {
        await cache.set(RADIO_CONFIGURED_KEY, configured);
    } catch (err) {
        logger.warn('radio-configured cache write failed', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return configured;
}
