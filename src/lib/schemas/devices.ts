// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { DeviceCapabilitiesSchema } from './device-commands.js';
export const DeviceSchema = z.object({
    deviceSessionId: z.string().meta({ description: 'Stable device session identifier' }),
    deviceId: z.string().nullable().meta({ description: 'Client-generated device identifier' }),
    deviceName: z.string().nullable(),
    isCustomName: z.boolean().meta({
        description: 'True when the name was set by the user, not reported by the client',
    }),
    clientId: z.string().optional(),
    approvedByDeviceName: z
        .string()
        .optional()
        .describe(
            'Device that approved this dependent sign-in; revoking it also revokes this session.',
        ),
    createdAt: z.string().meta({ description: 'ISO-8601 creation timestamp' }),
    lastUsedAt: z.string().nullable().meta({ description: 'ISO-8601 last used timestamp' }),
    isOnline: z.boolean().optional(),
    deviceType: z.enum(['tv', 'mobile', 'web', 'unknown']).optional(),
    supportsWatchTogether: z.boolean().optional(),
    features: z
        .array(z.string())
        .optional()
        .meta({
            description:
                'UI features the device announced on its last heartbeat, e.g. ["admin_message"]. ' +
                'Absent when offline or when the client announced nothing — treat absent and empty ' +
                'alike: the device cannot be assumed to render a device-targeted admin action.',
        }),
    lastHeartbeat: z.string().optional().meta({ description: 'ISO-8601 last heartbeat timestamp' }),
    capabilities: DeviceCapabilitiesSchema.optional().meta({
        description:
            'Remote control: what the device carries out (from its last heartbeat). Absent when offline.',
    }),
    external: z
        .boolean()
        .optional()
        .meta({
            description:
                'True for a remote-control target that is not a Lumastra device session (a Jellyfin ' +
                'client, `deviceSessionId` starts with `jf:`): ' +
                'there is nothing to rename or revoke here. Absent for a regular device.',
        }),
});

export const DevicesListResponseSchema = z.object({
    items: z.array(DeviceSchema),
    page: z.object({
        limit: z.number().int(),
        offset: z.number().int(),
        hasMore: z.boolean(),
        total: z.number().int().optional(),
    }),
});

export const RevokeAllDevicesResponseSchema = z.object({
    revoked: z.number().int(),
    failedStores: z.array(z.string()),
});
