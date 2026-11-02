// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/[id]/commands/index.ts
 *   POST /devices/{id}/commands — send a command to one of your devices
 *   GET  /devices/{id}/commands — the device's own inbox (catch-up, scheduled)
 *
 * Design: docs/superpowers/specs/2026-10-16-device-remote-control-design.md.
 * Vocabulary: `$lib/schemas/device-commands.ts`.
 *
 * Auth: feature:DEVICE_AUTH → user, plus: POST needs ownership of `{id}` or a
 * household grant from its owner (foreign, ungranted or unknown devices answer
 * 404), GET needs `{id}` to be the calling
 * device itself.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    DeviceCommandRequestSchema,
    DeviceCommandSchema,
    type DeviceCommandRequest,
} from '$lib/schemas/device-commands.js';
import {
    beginIdempotentSend,
    listDeviceInbox,
    sendDeviceCommand,
    type IdempotencyClaim,
} from '$lib/server/services/device-commands.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { toUserId } from '$lib/shared/user-id.js';
import { deviceCommandChecks } from '$lib/server/services/device-command-checks.js';
import { externalProviderFor } from '$lib/server/services/external-remote-targets.js';
import {
    commandSenderFor,
    deviceCommandProblem,
    isCallingDevice,
    unknownDevice,
    verifyDeviceControlAccess,
} from '../../device-access.js';

const logger = Logger.for('DeviceCommandsDef');

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const InboxResponseSchema = z.object({
    items: z.array(DeviceCommandSchema),
});

const SentResponseSchema = z.object({
    command: DeviceCommandSchema,
    replayed: z.boolean().describe('true: an Idempotency-Key repeat, nothing new was sent'),
});

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Devices'],
            summary: 'Send a command to a device',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Remote control of one of your own devices, or of a device whose owner granted you control (`/devices/grants`): start something (`media.play`, ' +
                '`livetv.tune`, `party.join`), control playback (`playback.*`, `queue.*`), or show ' +
                'a message (`ui.message`). Whether the command waits for the device (`queued`) or ' +
                'only applies now (`live`) is a property of its type. `expect` makes it apply only ' +
                'to what the device still plays (409 `stale_target` otherwise); `notBefore` ' +
                'schedules it. Optional `Idempotency-Key` header: a repeat within 24 h returns the ' +
                'first command. Problems carry `details`: `device_unsupported` (the device does not ' +
                'announce the type), `device_unreachable` (a live command and the device is not ' +
                'connected), `stale_target`, `simple_mode_locked`. Follow the command with ' +
                '`GET /devices/{id}/commands/{commandId}` or the `device.command_status` event. ' +
                'A Jellyfin client (`deviceSessionId` starts with `jf:`, `external: true` in ' +
                '`GET /devices`) has no acknowledgement: its command is final on this response ' +
                "(`status: applied` once handed to the client's open socket), is not stored, and " +
                '`GET`/`DELETE /devices/{id}/commands/{commandId}` answer 404 for it.',
            body: DeviceCommandRequestSchema,
            responses: {
                202: { schema: SentResponseSchema, description: 'Command accepted' },
                401: 'Authentication required',
                403: 'Not allowed (details simple_mode_locked) or Live TV permission missing',
                404: 'Device (or channel, party) not found',
                409: 'details device_unsupported, device_unreachable or stale_target',
                422: 'Validation failed',
                429: 'Too many commands',
                503: 'Cache service unavailable',
            },
        },
        GET: {
            tags: ['Devices'],
            summary: "A device's command inbox",
            stability: 'beta',
            auth: 'bearer',
            description:
                'For the device itself (`{id}` must be the calling device): every command it has ' +
                'not finished, oldest first, including scheduled ones (`notBefore` in the future). ' +
                'Read it on (re)connect to the event stream; live commands arrive as ' +
                '`device.command` events. Report what you did with ' +
                '`POST /devices/{id}/commands/{commandId}/result`.',
            responses: {
                200: { schema: InboxResponseSchema, description: 'Pending commands' },
                401: 'Authentication required',
                403: 'Not the calling device',
                503: 'Cache service unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'DEVICE_AUTH', then: { kind: 'user' } },
    request: {
        params: z.object({ id: z.string().min(1).max(128) }),
        body: DeviceCommandRequestSchema,
    },
    handlers: {
        GET: async (event) => {
            const id = event.params.id;
            if (!isCallingDevice(event, id)) {
                return ApiProblem.forbidden('Only the device itself reads its inbox');
            }
            const result = await listDeviceInbox(id!);
            if (!result.ok) return deviceCommandProblem(result.error);
            return json({ items: result.value }, { headers: { 'Cache-Control': 'no-store' } });
        },

        POST: async (event, ctx) => {
            const id = event.params.id!;
            const user = event.locals.user!;

            const idempotencyKey = event.request.headers.get('idempotency-key') ?? undefined;
            if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
                return ApiProblem.validationFailed([
                    { field: 'Idempotency-Key', message: 'Up to 128 letters, digits and _ . : -' },
                ]);
            }

            // A remote target that is not a Lumastra device session (a Jellyfin
            // client, id `jf:…`): the provider owns ownership, delivery and answer.
            // It is final on POST (no stored command, nothing to poll or cancel).
            const external = externalProviderFor(id);
            if (external) {
                const request = ctx.input!.body as DeviceCommandRequest;
                const sender = await commandSenderFor(event);
                let claim: IdempotencyClaim | null = null;
                if (idempotencyKey) {
                    const begun = await beginIdempotentSend({
                        userId: sender.userId,
                        key: idempotencyKey,
                        deviceSessionId: id,
                        request,
                    });
                    if (!begun.ok) return deviceCommandProblem(begun.error);
                    if ('replay' in begun.value) return json(begun.value.replay, { status: 200 });
                    claim = begun.value.claim;
                }
                try {
                    const sent = await external.send({
                        id,
                        user: { userId: String(user.userId), username: user.username },
                        request,
                        sender,
                        checks: deviceCommandChecks({
                            sql: getDb(),
                            userId: user.userId,
                            hasLiveTvPermission: Boolean(user.hasLiveTvPermission),
                            locals: event.locals,
                        }),
                    });
                    if (!sent.ok) {
                        await claim?.release();
                        return deviceCommandProblem(sent.error);
                    }
                    await claim?.commit(sent.value);
                    return json({ command: sent.value, replayed: false }, { status: 202 });
                } catch (err) {
                    await claim?.release();
                    logger.warn('External remote target failed', { error: String(err) });
                    return ApiProblem.dependencyUnavailable('Remote target unavailable');
                }
            }

            const owned = await verifyDeviceControlAccess(id, String(user.userId));
            if (owned instanceof Response) return owned;
            if (!owned) return unknownDevice();

            const request = ctx.input!.body as DeviceCommandRequest;
            const result = await sendDeviceCommand({
                deviceSessionId: id,
                ownerUserId: owned.ownerUserId,
                request,
                sender: await commandSenderFor(event),
                ...(idempotencyKey ? { idempotencyKey } : {}),
                checks: deviceCommandChecks({
                    sql: getDb(),
                    userId: user.userId,
                    ownerUserId: toUserId(owned.ownerUserId),
                    hasLiveTvPermission: Boolean(user.hasLiveTvPermission),
                    locals: event.locals,
                }),
            });
            if (!result.ok) return deviceCommandProblem(result.error);
            return json(result.value, { status: result.value.replayed ? 200 : 202 });
        },
    },
});
