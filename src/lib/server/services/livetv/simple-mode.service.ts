// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live TV simple mode: read and update one user's record, with the PIN lock.
 *
 * Who may change what:
 * - the user (or a helper signed in as them): anything, but a LOCKED record
 *   needs the current PIN for every change, including unlocking;
 * - an admin for another user (`asAdmin`): anything, no PIN; `locked: false`
 *   clears the PIN, which is how a forgotten PIN is recovered.
 *
 * The channels are the user's favorites in favorite order. `stationIds` in an
 * update replaces the favorites, so the normal Live TV page shows the same
 * channels starred.
 */

import type postgres from 'postgres';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { toPublicAuthor } from '$lib/server/utils/public-author.js';
import {
    getSimpleModeRow,
    countLineupChannels,
    resolveLineupChannelIds,
    lockSimpleModeRow,
    replaceFavoriteChannels,
    upsertSimpleModeRow,
    type SimpleModeRow,
} from '$lib/server/database/queries/livetv-simple-mode.queries.js';
import {
    getFavoriteChannelIds,
    healNullFavoriteOrder,
    stationIdsOfFeeds,
    resolveStation,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { hashPassword, verifyPassword } from '$lib/server/crypto/password.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { checkRateLimit, refundRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import type { LiveTvSimpleMode, LiveTvSimpleModeUpdate } from '$lib/schemas/livetv-simple-mode.js';
import type { UserId } from '$lib/shared/user-id';

/** Wrong PINs per user before a pause (both endpoints count). */
export const PIN_ATTEMPT_LIMIT = { limit: 5, windowSeconds: 15 * 60 };
/**
 * And per day: the person kept out by the lock has unlimited time at the
 * keyboard, so 5 per 15 minutes alone would let a 4-digit PIN fall in days.
 */
export const PIN_DAILY_LIMIT = { limit: 20, windowSeconds: 24 * 60 * 60 };

export type SimpleModeError =
    | { kind: 'pin_required' }
    | { kind: 'pin_invalid' }
    | { kind: 'rate_limited'; retryAfter: number }
    | { kind: 'invalid'; message: string }
    | { kind: 'unknown_channel' };

export type SimpleModeResult =
    { ok: true; value: LiveTvSimpleMode } | { ok: false; error: SimpleModeError };

const DEFAULTS = {
    enabled: false,
    layout: 'tv',
    textSize: 'large',
    autostart: true,
    locked: false,
} as const;

function toApi(
    row: SimpleModeRow | null,
    channelIds: string[],
    updatedByImages?: ImageSet,
): LiveTvSimpleMode {
    const start = row?.start_channel_id ?? undefined;
    return {
        enabled: row?.enabled ?? DEFAULTS.enabled,
        layout: row?.layout ?? DEFAULTS.layout,
        textSize: row?.text_size ?? DEFAULTS.textSize,
        // A start channel that is no longer one of the channels means "the first".
        startStationId: start && channelIds.includes(start) ? start : undefined,
        autostart: row?.autostart ?? DEFAULTS.autostart,
        locked: row?.locked ?? DEFAULTS.locked,
        updatedAt: row?.updated_at ? row.updated_at.toISOString() : undefined,
        updatedBy: row?.updated_by
            ? toPublicAuthor(
                  { userId: row.updated_by, displayName: row.updated_by_display_name ?? null },
                  'v1',
                  updatedByImages,
              )
            : undefined,
        stationIds: channelIds,
    };
}

export async function getSimpleMode(sql: postgres.Sql, userId: UserId): Promise<LiveTvSimpleMode> {
    const [row, favoriteIds] = await Promise.all([
        getSimpleModeRow(sql, userId),
        getFavoriteChannelIds(sql, userId),
    ]);
    // Saved feeds that are no longer their station's shown feed (or sit in a
    // hidden category) read as the lineup's own channel, so the lineup, the
    // channel numbers and the start channel keep working.
    const channelIds = await stationIdsOfFeeds(
        sql,
        await resolveLineupChannelIds(sql, favoriteIds),
    );
    const start = row?.start_channel_id
        ? ((
              await stationIdsOfFeeds(
                  sql,
                  await resolveLineupChannelIds(sql, [row.start_channel_id]),
              )
          )[0] ?? null)
        : null;
    const updatedByImages = row?.updated_by
        ? (await userImageSets(sql, 'v1', [row.updated_by], { external: false })).get(row.updated_by)
        : undefined;
    return toApi(row ? { ...row, start_channel_id: start } : null, channelIds, updatedByImages);
}

const pinKey = (userId: string): string => `livetv-simple-pin:${userId}`;
const pinDayKey = (userId: string): string => `livetv-simple-pin-day:${userId}`;

function retryAfter(resetAt: number): number {
    return Math.max(1, resetAt - Math.floor(Date.now() / 1000));
}

/**
 * Check a PIN against the user's lock. An attempt is RESERVED (both counters
 * incremented atomically) before the slow scrypt check, so parallel requests
 * cannot all pass a read-only gate: at most the limit are ever evaluated, and
 * every attempt counts. A correct PIN gives its reservation back, so a helper
 * saving several times with the right PIN is never locked out; a refund only
 * happens for a correct PIN, so it cannot be used to enumerate. Once the limit
 * is reached even the right PIN waits for the window. A record without a lock
 * needs no PIN.
 */
export async function verifySimpleModePin(
    sql: postgres.Sql,
    userId: UserId,
    pin: string,
): Promise<{ ok: true; pinHash: string | null } | { ok: false; error: SimpleModeError }> {
    const row = await getSimpleModeRow(sql, userId);
    if (!row?.locked || !row.pin_hash) return { ok: true, pinHash: null };
    const { limit, windowSeconds } = PIN_ATTEMPT_LIMIT;
    const day = PIN_DAILY_LIMIT;
    const gates = [
        await checkRateLimit(pinKey(userId), limit, windowSeconds),
        await checkRateLimit(pinDayKey(userId), day.limit, day.windowSeconds),
    ];
    for (const gate of gates) {
        if (!gate.allowed) {
            return {
                ok: false,
                error: { kind: 'rate_limited', retryAfter: retryAfter(gate.resetAt) },
            };
        }
    }
    if (await verifyPassword(pin, row.pin_hash)) {
        await refundRateLimit(pinKey(userId), windowSeconds, gates[0].resetAt);
        await refundRateLimit(pinDayKey(userId), day.windowSeconds, gates[1].resetAt);
        return { ok: true, pinHash: row.pin_hash };
    }
    return { ok: false, error: { kind: 'pin_invalid' } };
}

export interface UpdateOptions {
    /** Who makes the change (shown as "set up by"). */
    actorUserId: UserId;
    /** An admin changing another user's record: no PIN needed. */
    asAdmin: boolean;
}

export async function updateSimpleMode(
    sql: postgres.Sql,
    userId: UserId,
    update: LiveTvSimpleModeUpdate,
    opts: UpdateOptions,
): Promise<SimpleModeResult> {
    // UUIDs compare as text below; the same id in two cases must not count twice.
    update = {
        ...update,
        stationIds: update.stationIds?.map((id) => id.toLowerCase()),
        startStationId: update.startStationId?.toLowerCase(),
    };
    if (update.startStationId && update.clearStartStation) {
        return {
            ok: false,
            error: { kind: 'invalid', message: 'startStationId and clearStartStation conflict' },
        };
    }

    // PIN check before the transaction (scrypt), against the current row.
    // The transaction re-reads the row; a lock set in between by someone else
    // is caught there.
    const before = await getSimpleModeRow(sql, userId);
    let checkedPinHash: string | null = null;
    if (!opts.asAdmin && before?.locked && before.pin_hash) {
        if (!update.pin) return { ok: false, error: { kind: 'pin_required' } };
        const check = await verifySimpleModePin(sql, userId, update.pin);
        if (!check.ok) return check;
        checkedPinHash = check.pinHash;
    }

    // Hash the new PIN only now that the request is allowed (scrypt is slow, so
    // a request without the PIN must not reach it), and outside the transaction
    // so it does not hold the row lock.
    const newPinHash = update.newPin ? await hashPassword(update.newPin) : null;

    try {
        await withTx(sql, async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await lockSimpleModeRow(tx, userId);
            const row = await getSimpleModeRow(tx, userId);
            // Locked meanwhile, or the PIN changed since it was checked.
            if (!opts.asAdmin && row?.locked && row.pin_hash && row.pin_hash !== checkedPinHash) {
                throw new SimpleModeAbort({ kind: 'pin_required' });
            }

            if (update.stationIds) {
                const unique: string[] = [];
                for (const id of new Set(update.stationIds)) {
                    const station = await resolveStation(tx, id);
                    if (!station) throw new SimpleModeAbort({ kind: 'unknown_channel' });
                    unique.push(station.shownFeedId);
                }
                // Only channels the lineup offers: no hidden or archived ones.
                if ((await countLineupChannels(tx, unique)) !== unique.length) {
                    throw new SimpleModeAbort({ kind: 'unknown_channel' });
                }
                await replaceFavoriteChannels(tx, userId, unique);
            } else {
                await healNullFavoriteOrder(tx, userId);
            }
            const channelIds = await resolveLineupChannelIds(
                tx,
                await getFavoriteChannelIds(tx, userId),
            );

            let startChannelId = row?.start_channel_id ?? null;
            if (update.clearStartStation) startChannelId = null;
            if (update.startStationId) {
                const station = await resolveStation(tx, update.startStationId);
                if (!station || !channelIds.includes(station.shownFeedId)) {
                    throw new SimpleModeAbort({
                        kind: 'invalid',
                        message: 'The start channel must be one of the channels',
                    });
                }
                startChannelId = station.shownFeedId;
            }

            let pinHash = row?.pin_hash ?? null;
            let locked = row?.locked ?? DEFAULTS.locked;
            if (newPinHash && update.locked !== true && !locked) {
                throw new SimpleModeAbort({
                    kind: 'invalid',
                    message: 'A new PIN needs locked: true',
                });
            }
            if (newPinHash) pinHash = newPinHash;
            if (update.locked === false) {
                locked = false;
                pinHash = null;
            } else if (update.locked === true) {
                if (!pinHash) {
                    throw new SimpleModeAbort({
                        kind: 'invalid',
                        message: 'A PIN is needed to lock simple mode',
                    });
                }
                locked = true;
            }

            await upsertSimpleModeRow(tx, userId, {
                enabled: update.enabled ?? row?.enabled ?? DEFAULTS.enabled,
                layout: update.layout ?? row?.layout ?? DEFAULTS.layout,
                textSize: update.textSize ?? row?.text_size ?? DEFAULTS.textSize,
                startChannelId,
                autostart: update.autostart ?? row?.autostart ?? DEFAULTS.autostart,
                locked,
                pinHash: locked ? pinHash : null,
                updatedBy: opts.actorUserId,
            });
        });
    } catch (err) {
        if (err instanceof SimpleModeAbort) return { ok: false, error: err.error };
        const pgErr = err as { code?: string; constraint_name?: string };
        // Only a channel FK means "unknown channel"; anything else is a real error.
        if (pgErr.code === '23503' && /channel/.test(pgErr.constraint_name ?? '')) {
            return { ok: false, error: { kind: 'unknown_channel' } };
        }
        throw err;
    }

    return { ok: true, value: await getSimpleMode(sql, userId) };
}

class SimpleModeAbort extends Error {
    constructor(readonly error: SimpleModeError) {
        super(error.kind);
    }
}
