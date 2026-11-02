// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import {
    playbackPreferenceWriteOrderSchema,
    type PlaybackPreferenceWriteOrder,
} from '$lib/schemas/user';
import type { UserId } from '$lib/shared/user-id';
import { withTx } from '../with-tx';
import {
    getPlaybackPreferences,
    PLAYBACK_PREF_COLUMNS,
    upsertPlaybackPreferences,
    type PlaybackPreferencesUpsert,
    type PlaybackPreferencesRow,
} from './user-preferences.queries';

/**
 * Browser locks release on unload while keepalive HTTP requests survive. The
 * database must arbitrate edit order too. Each device retains one generation
 * and at most one order per supported field; epochs do not accumulate rows.
 * User identity is supplied by authentication, never by transport metadata.
 */
export async function upsertOrderedPlaybackPreferences(
    sql: postgres.Sql,
    userId: UserId,
    preferences: PlaybackPreferencesUpsert,
    inputOrder: PlaybackPreferenceWriteOrder,
): Promise<PlaybackPreferencesRow | null> {
    const order = playbackPreferenceWriteOrderSchema.parse(inputOrder);
    const fields = Object.keys(preferences).filter(
        (field) => preferences[field as keyof PlaybackPreferencesUpsert] !== undefined,
    );
    for (const field of fields)
        if (!Object.hasOwn(PLAYBACK_PREF_COLUMNS, field) || !Object.hasOwn(order.fields, field))
            throw new Error('Missing preference edit order');
    return withTx(sql, async (tx) => {
        // A blocking per-user lock covers different devices updating the same
        // preference row as well as compare/read/write of its ordering ledgers.
        await tx`SELECT pg_advisory_xact_lock(164270, hashtext(${userId}))`;
        const [device] = await tx<{ epoch_generation: string; epoch_id: string }[]>`
            SELECT epoch_generation, epoch_id FROM user_playback_preference_devices
            WHERE user_id = ${userId} AND device_id = ${order.deviceId}
        `;
        const current = async (): Promise<PlaybackPreferencesRow | null> =>
            (await getPlaybackPreferences.one(tx, { userId })) ??
            upsertPlaybackPreferences(tx, userId, {});
        if (
            device &&
            (Number(device.epoch_generation) > order.epochGeneration ||
                (Number(device.epoch_generation) === order.epochGeneration &&
                    device.epoch_id !== order.epochId))
        )
            return current();
        if (!device || Number(device.epoch_generation) < order.epochGeneration) {
            await tx`
                INSERT INTO user_playback_preference_devices (user_id, device_id, epoch_generation, epoch_id)
                VALUES (${userId}, ${order.deviceId}, ${order.epochGeneration}, ${order.epochId})
                ON CONFLICT (user_id, device_id) DO UPDATE SET epoch_generation = EXCLUDED.epoch_generation, epoch_id = EXCLUDED.epoch_id
            `;
            await tx`DELETE FROM user_playback_preference_orders WHERE user_id = ${userId} AND device_id = ${order.deviceId}`;
        }
        const previous = await tx<{ field: string; edit_clock: string; operation_id: string }[]>`
            SELECT field, edit_clock, operation_id FROM user_playback_preference_orders
            WHERE user_id = ${userId} AND device_id = ${order.deviceId}
        `;
        const accepted: PlaybackPreferencesUpsert = {};
        for (const field of fields) {
            const token = order.fields[field];
            const old = previous.find((entry) => entry.field === field);
            if (
                old &&
                (Number(old.edit_clock) > token.clock ||
                    (Number(old.edit_clock) === token.clock &&
                        old.operation_id >= token.operationId))
            )
                continue;
            (accepted as Record<string, unknown>)[field] =
                preferences[field as keyof PlaybackPreferencesUpsert];
            await tx`
                INSERT INTO user_playback_preference_orders (user_id, device_id, field, edit_clock, operation_id)
                VALUES (${userId}, ${order.deviceId}, ${field}, ${token.clock}, ${token.operationId})
                ON CONFLICT (user_id, device_id, field) DO UPDATE SET edit_clock = EXCLUDED.edit_clock, operation_id = EXCLUDED.operation_id
            `;
        }
        return Object.keys(accepted).length
            ? upsertPlaybackPreferences(tx, userId, accepted)
            : current();
    });
}
