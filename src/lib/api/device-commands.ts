// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device remote-control API client (internal, session-auth surface — NOT
 * /api/v1, which a browser cannot authenticate against).
 *
 * Design: repo-root docs/superpowers/specs/2026-10-16-device-remote-control-design.md.
 */

import { z } from 'zod';
import { apiDelete, apiGet, apiPost } from './client.js';
import {
    DeviceCapabilitiesSchema,
    DeviceCommandSchema,
    DeviceStateSchema,
    type DeviceCommandRequest,
} from '$lib/schemas/device-commands';

const SendCommandResponseSchema = z.object({
    command: DeviceCommandSchema,
    replayed: z.boolean().optional(),
});

const base = (deviceSessionId: string): string =>
    `/api/user/devices/${encodeURIComponent(deviceSessionId)}`;

/** POST /api/user/devices/{id}/commands → 202 `{command, replayed}`. */
export function sendDeviceCommand(deviceSessionId: string, request: DeviceCommandRequest) {
    return apiPost(`${base(deviceSessionId)}/commands`, SendCommandResponseSchema, request);
}

/** GET /api/user/devices/{id}/commands/{commandId}. */
export function getDeviceCommand(deviceSessionId: string, commandId: string) {
    return apiGet(
        `${base(deviceSessionId)}/commands/${encodeURIComponent(commandId)}`,
        DeviceCommandSchema,
    );
}

/** GET /api/user/devices/{id}/state. */
export function getDeviceState(deviceSessionId: string) {
    return apiGet(`${base(deviceSessionId)}/state`, DeviceStateSchema);
}

// --- Household grant: helpers who may control my devices -------------------

export const DeviceGrantSchema = z.object({
    username: z.string(),
    createdAt: z.string(),
});
export type DeviceGrant = z.infer<typeof DeviceGrantSchema>;

const GrantListSchema = z.object({ items: z.array(DeviceGrantSchema) });

export const ControllableDeviceSchema = z.object({
    deviceSessionId: z.string(),
    deviceName: z.string().nullable(),
    deviceType: z.enum(['tv', 'mobile', 'web', 'unknown']).optional(),
    isOnline: z.boolean(),
    lastHeartbeat: z.string().optional(),
    capabilities: DeviceCapabilitiesSchema.optional(),
    ownerUsername: z.string(),
});
export type ControllableDevice = z.infer<typeof ControllableDeviceSchema>;

const ControllableListSchema = z.object({ items: z.array(ControllableDeviceSchema) });

/** GET /api/user/devices/grants: the people allowed to control my devices. */
export function listDeviceGrants() {
    return apiGet('/api/user/devices/grants', GrantListSchema);
}

/** POST /api/user/devices/grants `{username}`: allow another user. */
export function addDeviceGrant(username: string) {
    return apiPost('/api/user/devices/grants', DeviceGrantSchema, { username });
}

/** DELETE /api/user/devices/grants/{username}: stop allowing a user. */
export function removeDeviceGrant(username: string) {
    return apiDelete(`/api/user/devices/grants/${encodeURIComponent(username)}`, z.null());
}

/** GET /api/user/devices/controllable: devices of users who allowed me. */
export function listControllableDevices() {
    return apiGet('/api/user/devices/controllable', ControllableListSchema);
}
