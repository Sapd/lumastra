// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/sessions/[id]/commands.ts
 *
 * POST /api/admin/sessions/{playSessionId}/commands — an administrator's
 * remote control of a play session: `ui.message` (show a message) or
 * `playback.stop` (end the stream). Replaces POST /api/admin/sessions/{id}/message.
 *
 * The play session is the admin's handle (the Active Sessions row): web players
 * and Jellyfin clients have no device session to address. A message goes to the
 * device as a command when that device can take one (it then shows "from the
 * administrator", the admin sees `delivered` / `applied`); otherwise it goes out
 * as the per-session admin toast every player already renders — dropped, not
 * queued, exactly as before. `playback.stop` is the existing kill.
 *
 * Auth: admin. Every command is audited.
 * Design: docs/superpowers/specs/2026-10-16-device-remote-control-design.md.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getSessionById } from '$lib/server/database/queries/play-sessions.queries.js';
import { findDeviceSessionIdForDevice } from '$lib/server/database/queries/user-devices.queries.js';
import { broadcastAdminMessage } from '$lib/server/services/play-session-events.service.js';
import { killSessionUnified } from '$lib/server/services/session-kill.service.js';
import { sendDeviceCommand } from '$lib/server/services/device-commands.service.js';
import { getHeartbeat, isDeviceStreamOpen } from '$lib/server/services/device-presence.service.js';
import { DEVICE_COMMANDS, DeviceCommandSchema } from '$lib/schemas/device-commands.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { toUserId } from '$lib/shared/user-id.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { deviceCommandProblem } from '../../../devices/device-access.js';

const AdminSessionCommandSchema = z
    .discriminatedUnion('type', [
        z
            .object({ type: z.literal('ui.message'), args: DEVICE_COMMANDS['ui.message'].args })
            .strict(),
        z.object({ type: z.literal('playback.stop') }).strict(),
    ])
    .meta({
        id: 'AdminSessionCommand',
        description: 'An administrator command for a play session',
    });

const AdminSessionCommandResponseSchema = z.object({
    delivery: z
        .enum(['command', 'toast', 'stopped'])
        .describe(
            '`command`: sent to the device as a device command (follow `command`); `toast`: the ' +
                'per-session admin toast (not tracked); `stopped`: the stream was ended',
        ),
    command: DeviceCommandSchema.optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: z.object({ id: z.string().min(1).max(64) }),
        body: AdminSessionCommandSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sessionId = ctx.input!.params.id;
            const admin = event.locals.user;
            if (!admin?.username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const session = await getSessionById(sql, sessionId);
            if (!session || (session.status !== 'ACTIVE' && session.status !== 'PAUSED')) {
                return ApiProblem.notFound('Session not found or no longer active');
            }

            const body = ctx.input!.body;

            if (body.type === 'playback.stop') {
                const killed = await killSessionUnified(sql, sessionId, admin.username);
                if (!killed) return ApiProblem.notFound('Session not found or already ended');
                auditLog('session.command', sessionId, auditActor(event), {
                    type: body.type,
                    targetUserId: session.user_id,
                    delivery: 'stopped',
                });
                return json(AdminSessionCommandResponseSchema.parse({ delivery: 'stopped' }));
            }

            const { text, severity } = body.args as {
                text: string;
                severity?: 'info' | 'warning' | 'error';
            };
            const audit = (delivery: string, commandId?: string): void =>
                auditLog('session.command', sessionId, auditActor(event), {
                    type: body.type,
                    targetUserId: session.user_id,
                    severity: severity ?? 'info',
                    length: text.length,
                    delivery,
                    ...(commandId ? { commandId } : {}),
                });

            // A device that takes commands gets a tracked one.
            const ownerUserId = toUserId(session.user_id);
            const deviceSessionId = session.device_id
                ? await findDeviceSessionIdForDevice(sql, ownerUserId, session.device_id)
                : null;
            if (deviceSessionId) {
                const [heartbeat, reachable] = await Promise.all([
                    getHeartbeat(deviceSessionId).catch(() => null),
                    isDeviceStreamOpen(deviceSessionId).catch(() => false),
                ]);
                if (reachable && heartbeat?.capabilities?.commands?.['ui.message']) {
                    const sent = await sendDeviceCommand({
                        deviceSessionId,
                        ownerUserId: session.user_id,
                        request: { type: 'ui.message', args: body.args as Record<string, unknown> },
                        sender: {
                            userId: String(admin.userId),
                            username: admin.username,
                            source: 'admin',
                            admin: true,
                        },
                    });
                    if (sent.ok) {
                        audit('command', sent.value.command.id);
                        return json(
                            AdminSessionCommandResponseSchema.parse({
                                delivery: 'command',
                                command: sent.value.command,
                            }),
                            { status: 202 },
                        );
                    }
                    // Only "the device cannot take it right now" falls back to the
                    // toast; a rate limit or an outage must not be bypassed by it.
                    if (
                        sent.error.kind !== 'device_unsupported' &&
                        sent.error.kind !== 'device_unreachable'
                    ) {
                        return deviceCommandProblem(sent.error);
                    }
                }
            }

            const rl = await checkRateLimit(`devcmd:msg:${admin.userId}`, 10, 60);
            if (!rl.allowed) {
                return ApiProblem.rateLimited(
                    Math.max(1, rl.resetAt - Math.floor(Date.now() / 1000)),
                );
            }

            broadcastAdminMessage({
                target: { kind: 'session', session_id: sessionId, userId: session.user_id },
                deviceId: session.device_id,
                severity: severity ?? 'info',
                // A toast has no buttons; the text alone goes out.
                message: text,
                sentBy: admin.username,
            });
            audit('toast');
            return json(AdminSessionCommandResponseSchema.parse({ delivery: 'toast' }), {
                status: 202,
            });
        },
    },
});
