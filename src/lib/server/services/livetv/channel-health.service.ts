// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-feed Live TV health: consecutive playback failures with the last typed reason.
 *
 * Written by the failure-event drain (applyFailureEventToHealth), by app-side start
 * failures and successes, and cleared by the admin reset. Every writer here is
 * non-throwing: health is a signal, never a reason to fail a start or the drain.
 *
 * Design: docs/superpowers/specs/2026-10-20-livetv-failure-taxonomy-design.md
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { localsIsAdmin, type AdminDecisionLocals } from '$lib/server/auth/locals-admin.js';
import {
    isFeedUuid,
    listForChannels,
    listOfflineStationIds,
    recordFailure,
    recordSuccess,
    type LiveTvChannelHealthRow,
} from '$lib/server/database/queries/livetv-channel-health.queries.js';
import {
    isLiveTvFailureReason,
    type LiveTvFailureReason,
} from '../../../../shared/livetv-failure-reason.js';

const logger = Logger.for('LiveTV:Health');

/** Consecutive failures from which a feed counts as offline. */
export const LIVETV_OFFLINE_AFTER_FAILURES = 3;

/** After this long a failing feed counts as retestable again (and reappears in the lineup). */
export const LIVETV_OFFLINE_WINDOW_HOURS = 6;

export type LiveTvHealthState = 'ok' | 'failing' | 'offline';

export interface LiveTvHealthView {
    state: LiveTvHealthState;
    consecutiveFailures: number;
    lastReason?: string;
    lastFailureAt?: string;
    lastSuccessAt?: string;
}

export function healthState(
    row: Pick<LiveTvChannelHealthRow, 'consecutive_failures'> | undefined | null,
): LiveTvHealthState {
    const failures = row?.consecutive_failures ?? 0;
    if (failures >= LIVETV_OFFLINE_AFTER_FAILURES) return 'offline';
    return failures > 0 ? 'failing' : 'ok';
}

export function toHealthView(row: LiveTvChannelHealthRow | undefined | null): LiveTvHealthView {
    return {
        state: healthState(row),
        consecutiveFailures: row?.consecutive_failures ?? 0,
        ...(row?.last_reason ? { lastReason: row.last_reason } : {}),
        ...(row?.last_failure_at ? { lastFailureAt: row.last_failure_at.toISOString() } : {}),
        ...(row?.last_success_at ? { lastSuccessAt: row.last_success_at.toISOString() } : {}),
    };
}

/** Health views by feed id for the admin lists; a feed without a row is `ok`. */
export async function healthViewsFor(
    sql: postgres.Sql,
    channelIds: string[],
): Promise<Map<string, LiveTvHealthView>> {
    const rows = await listForChannels(sql, channelIds);
    const views = new Map<string, LiveTvHealthView>();
    for (const row of rows) views.set(row.channel_id, toHealthView(row));
    return views;
}

export const EMPTY_HEALTH_VIEW: LiveTvHealthView = { state: 'ok', consecutiveFailures: 0 };

/** The part of a failure event health needs. */
export interface HealthFailureEvent {
    channelId: string;
    feedId?: string | null;
    reason?: string | null;
    /** `exhausted` summarises per-feed events already counted; it never adds a failure. */
    outcome?: string | null;
    /** Which FFmpeg process failed; only `ingest` (the provider feed) can mark a feed unhealthy. */
    source?: string | null;
    /** Index into the join's `streamUrls`; above 0 without a `feedId` is a backup URL. */
    streamUrlIndex?: number | null;
    occurredAt: string | Date;
}

/** Reasons that blame us or our own other viewers, never the provider feed. */
const NON_FEED_REASONS: ReadonlySet<string> = new Set([
    'encoder_failed',
    'provider_connection_limit',
]);

/**
 * Count one failure event against its feed (`feedId`, else the channel). Events without a
 * typed reason (older proxy, plain FFmpeg crash rows) carry no health signal, and neither do
 * egress failures (our own encoders), encoder_failed, provider_connection_limit (our own other
 * viewers hold the slots), or a backup URL's failure that names no feed (it must never be billed
 * to the primary).
 */
export async function applyFailureEventToHealth(
    sql: postgres.Sql,
    event: HealthFailureEvent,
): Promise<void> {
    if (!event.reason || event.outcome === 'exhausted') return;
    if (event.source !== undefined && event.source !== null && event.source !== 'ingest') return;
    if (NON_FEED_REASONS.has(event.reason)) return;
    if (!event.feedId && (event.streamUrlIndex ?? 0) > 0) return;
    const target = event.feedId ?? event.channelId;
    if (!isFeedUuid(target)) return;
    const at = event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt);
    try {
        await recordFailure(
            sql,
            target,
            event.reason,
            Number.isNaN(at.getTime()) ? new Date() : at,
        );
        invalidateHiddenStationsCache();
    } catch (error) {
        logger.warn('Could not record Live TV feed failure', {
            channelId: target,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export interface StartFailureInput {
    reason: LiveTvFailureReason;
    /** Per-feed failures, when the start failed on several feeds. */
    feeds?: Array<{ feedId?: string; reason: LiveTvFailureReason }>;
}

/** A start that failed before the proxy could classify it (blocked URLs, no URL). */
export async function recordStartFailure(
    sql: postgres.Sql | null | undefined,
    channelId: string,
    failure: StartFailureInput,
): Promise<void> {
    if (!sql) return;
    const targets =
        failure.feeds && failure.feeds.length > 0
            ? failure.feeds.map((f) => ({ id: f.feedId ?? channelId, reason: f.reason }))
            : [{ id: channelId, reason: failure.reason }];
    for (const target of targets) {
        if (!isLiveTvFailureReason(target.reason)) continue;
        await applyFailureEventToHealth(sql, {
            channelId: target.id,
            reason: target.reason,
            occurredAt: new Date(),
        });
    }
}

/** An accepted start: the proxy admitted the viewer and the channel was not terminal. */
export async function recordStartSuccess(
    sql: postgres.Sql | null | undefined,
    channelId: string,
): Promise<void> {
    if (!sql) return;
    try {
        await recordSuccess(sql, channelId);
        invalidateHiddenStationsCache();
    } catch (error) {
        logger.warn('Could not record Live TV feed success', {
            channelId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** Adds `health` to every item (a feed without a row is `ok`). Never throws: no health is `ok`. */
export async function withHealth<T extends { id: string }>(
    sql: postgres.Sql,
    items: T[],
): Promise<Array<T & { health: LiveTvHealthView }>> {
    let views = new Map<string, LiveTvHealthView>();
    try {
        views = await healthViewsFor(
            sql,
            items.map((i) => i.id),
        );
    } catch (error) {
        logger.warn('Could not read Live TV feed health', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
    return items.map((item) => ({ ...item, health: views.get(item.id) ?? EMPTY_HEALTH_VIEW }));
}

/** How long the hidden-station set is reused before it is read again. */
const HIDDEN_STATIONS_TTL_MS = 30_000;

let hiddenStations: { key: string; at: number; ids: Set<string> } | null = null;
/** Bumped by invalidation so a read already in flight cannot store a stale set. */
let hiddenStationsGeneration = 0;

/** Drops the cached hidden-station set (health writes, resets, lineup changes). */
export function invalidateHiddenStationsCache(): void {
    hiddenStationsGeneration++;
    hiddenStations = null;
}

async function loadHiddenStations(
    sql: postgres.Sql,
    threshold: number,
    now: number,
): Promise<Set<string>> {
    const key = `${threshold}:${LIVETV_OFFLINE_WINDOW_HOURS}`;
    if (
        hiddenStations &&
        hiddenStations.key === key &&
        now - hiddenStations.at < HIDDEN_STATIONS_TTL_MS
    ) {
        return hiddenStations.ids;
    }
    const generation = hiddenStationsGeneration;
    const ids = new Set(await listOfflineStationIds(sql, threshold, LIVETV_OFFLINE_WINDOW_HOURS));
    if (generation === hiddenStationsGeneration) hiddenStations = { key, at: now, ids };
    return ids;
}

/**
 * Drops the feeds of every station whose feeds all failed LIVETV_HIDE_OFFLINE_AFTER_FAILURES
 * times in a row with the last failure inside the last 6 hours. Off at 0, and administrators
 * always see everything. A health read that fails shows the full lineup: hiding is an
 * optimisation for viewers, never a reason to blank the lineup.
 *
 * The set of hidden stations is read once per ~30 s (and after any health write or lineup
 * change) and filtered here, so a 12k-channel lineup is never shipped to SQL per request.
 */
export async function hideOfflineStations<T extends { id: string; backupGroupId?: string }>(
    channels: T[],
    locals: AdminDecisionLocals | null | undefined,
): Promise<T[]> {
    const threshold = config.LIVETV_HIDE_OFFLINE_AFTER_FAILURES;
    if (!(threshold > 0) || channels.length === 0 || localsIsAdmin(locals)) return channels;
    const sql = getDb();
    if (!sql) return channels;
    try {
        const hidden = await loadHiddenStations(sql, threshold, Date.now());
        if (hidden.size === 0) return channels;
        return channels.filter((c) => !hidden.has(c.backupGroupId ?? c.id));
    } catch (error) {
        logger.warn('Could not apply the hide-offline setting', {
            error: error instanceof Error ? error.message : String(error),
        });
        return channels;
    }
}
