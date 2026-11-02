// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type-specific checks for a device command, run with the sender's request
 * context before the command is queued (see `device-commands.service.ts`).
 *
 * Everything here is an early, honest answer for the sender: the device acts
 * with the same account's credentials and checks access again when it fetches
 * the item or the stream.
 */

import { userAllowsLiveTv } from '$lib/server/auth/livetv-user-policy.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { resolveStation } from '$lib/server/services/livetv/station.service.js';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import {
    canStreamLiveTvChannel,
    type LiveTvAccessLocals,
} from '$lib/server/services/livetv/channel-access.js';
import {
    getSessionWithParticipant,
    getSession,
} from '$lib/server/services/watch-together.service.js';
import { getSimpleMode } from '$lib/server/services/livetv/simple-mode.service.js';
import type { DeviceCommandRequest } from '$lib/schemas/device-commands.js';
import type {
    DeviceCommandError,
    SendChecks,
} from '$lib/server/services/device-commands.service.js';
import type { UserId } from '$lib/shared/user-id.js';

/** Commands that leave Live TV simple mode (a locked setup refuses them). */
const LEAVES_SIMPLE_MODE = new Set(['media.play', 'party.join']);

export interface CommandCheckContext {
    sql: postgres.Sql | null;
    /** The sender. */
    userId: UserId;
    /** The device's owner when the sender is a granted helper; defaults to the sender. */
    ownerUserId?: UserId;
    hasLiveTvPermission: boolean;
    locals: LiveTvAccessLocals;
}

export function deviceCommandChecks(ctx: CommandCheckContext): SendChecks {
    return {
        async check(request: DeviceCommandRequest): Promise<DeviceCommandError | null> {
            const type = request.type;

            // A granted helper tunes the owner's TV. The helper's own Live TV
            // permission does not matter: the TV joins the stream with the
            // owner's credentials. Check the owner's switch before queuing, as well
            // as enforcing it at stream join. Here the channel must be one a non-admin
            // viewer may stream (the stricter rule, whoever the owner is).
            const helper = ctx.ownerUserId !== undefined && ctx.ownerUserId !== ctx.userId;
            if (type.startsWith('livetv.')) {
                if (!config.FEATURE_LIVETV || (!helper && !ctx.hasLiveTvPermission)) {
                    return { kind: 'feature_unavailable', message: '' };
                }
            }
            if (type.startsWith('livetv.') && helper) {
                try {
                    const owner = ctx.sql ? await getUserById(ctx.sql, ctx.ownerUserId!) : null;
                    if (!owner || !(await userAllowsLiveTv(owner.username)))
                        return { kind: 'feature_unavailable', message: '' };
                } catch {
                    return { kind: 'feature_unavailable', message: '' };
                }
            }
            if (type === 'livetv.tune') {
                let station;
                try {
                    station = await resolveStation(
                        String(request.args?.['stationId'] ?? '').toLowerCase(),
                    );
                } catch {
                    return { kind: 'unavailable', message: 'Live TV database unavailable' };
                }
                if (
                    !station ||
                    !(await canStreamLiveTvChannel(helper ? {} : ctx.locals, station.shownFeedId))
                ) {
                    return { kind: 'not_found', message: 'Unknown channel' };
                }
            }

            if (type === 'party.join') {
                const code = String(request.args?.['code'] ?? '');
                // The TV joins as its owner, so the OWNER must be in the party: a
                // helper cannot pull the owner's device into a party the owner
                // never joined.
                const joiner = helper ? ctx.ownerUserId! : ctx.userId;
                const membership = await getSessionWithParticipant(code, String(joiner));
                if (!membership) {
                    if (!(await getSession(code))) {
                        return { kind: 'not_found', message: 'Watch Together party not found' };
                    }
                    return {
                        kind: 'forbidden',
                        message: helper
                            ? 'The device owner is not in this Watch Together party'
                            : 'You are not in this Watch Together party',
                    };
                }
            }

            if (LEAVES_SIMPLE_MODE.has(type) && config.FEATURE_LIVETV) {
                // Fails closed: a locked setup must not be left during a DB blip.
                if (!ctx.sql) return { kind: 'unavailable', message: 'Database is unavailable' };
                let simple: Awaited<ReturnType<typeof getSimpleMode>>;
                try {
                    simple = await getSimpleMode(ctx.sql, ctx.ownerUserId ?? ctx.userId);
                } catch {
                    return { kind: 'unavailable', message: 'Could not read the simple-mode setup' };
                }
                if (simple.enabled && simple.locked) {
                    return {
                        kind: 'simple_mode_locked',
                        message: 'Live TV simple mode is locked on this account',
                    };
                }
            }
            return null;
        },
    };
}
