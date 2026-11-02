// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AGPL-core registry for remote-control targets that are not Lumastra device
 * sessions: today the Jellyfin clients behind the proprietary `/j` layer.
 *
 * The device API (`GET /devices`, `POST /devices/{id}/commands`,
 * `GET /devices/{id}/state`) stays the single surface a Lumastra remote talks
 * to. A target of this kind lists next to the real devices under an id with a
 * provider prefix (`jf:<remote session id>`), so it can never collide with a
 * device session id (a UUID). A command for such an id is handed to the
 * provider instead of the Lumastra event stream.
 *
 * Same shape as `auth/jellyfin-compat-revocation.ts`: the core never imports
 * the proprietary tree (license boundary). The provider registers itself in
 * `jellyfin-compat/remote-control/register.ts`, which `proprietary/licensing/init.ts`
 * imports lazily (not on stream-proxy-only nodes). Without it (an AGPL-only
 * build, or a stream-proxy node) the getters answer "nothing" and the device
 * API behaves as before. A provider whose feature is switched off answers
 * `owns() === false` and lists nothing.
 */

import type {
    DeviceCommand,
    DeviceCommandRequest,
    DeviceState,
} from '$lib/schemas/device-commands.js';
import { Logger } from '$lib/server/utils/logger.js';
import type {
    CommandSender,
    Result,
    SendChecks,
} from '$lib/server/services/device-commands.service.js';
import type { ResolvedDeviceSession } from '$lib/server/services/user-devices.service.js';

const logger = Logger.for('ExternalRemoteTargets');

/** The account asking; targets of other accounts are never listed or reachable. */
export interface ExternalTargetUser {
    userId: string;
    username: string;
}

export interface ExternalRemoteTargetProvider {
    /** Cheap, synchronous: is `id` one of this provider's, and is the provider on? */
    owns(id: string): boolean;
    /** The user's own targets, shaped like entries of `GET /devices`. */
    list(user: ExternalTargetUser): Promise<ResolvedDeviceSession[]>;
    /** The target's state, or null for an unknown or foreign target. */
    state(id: string, user: ExternalTargetUser): Promise<DeviceState | null>;
    /**
     * Carries out a command. `not_found` for an unknown or foreign target,
     * `device_unsupported` / `device_unreachable` / `rate_limited` / … like the
     * Lumastra device path. The command comes back already final
     * (`applied`): there is no per-command acknowledgement, so it is neither
     * stored nor pollable (`GET`/`DELETE /devices/{id}/commands/{commandId}`
     * answer 404). `checks` (Live TV permission, simple-mode lock) run after the
     * target is known to be the caller's and can carry out the type, before
     * anything is delivered.
     */
    send(input: {
        id: string;
        user: ExternalTargetUser;
        request: DeviceCommandRequest;
        sender: CommandSender;
        checks?: SendChecks;
    }): Promise<Result<DeviceCommand>>;
}

let provider: ExternalRemoteTargetProvider | null = null;

/** Called by the proprietary module (`register.ts`) to wire itself in. */
export function registerExternalRemoteTargetProvider(p: ExternalRemoteTargetProvider): void {
    provider = p;
}

/** The registered provider, or null in AGPL-only builds. */
export function getExternalRemoteTargetProvider(): ExternalRemoteTargetProvider | null {
    return provider;
}

/** The provider that owns `id`, or null (a plain Lumastra device session id). */
export function externalProviderFor(id: string): ExternalRemoteTargetProvider | null {
    return provider?.owns(id) ? provider : null;
}

/**
 * The user's external targets for the device list. A provider failure never
 * breaks the list of real devices.
 */
export async function listExternalRemoteDevices(
    user: ExternalTargetUser,
): Promise<ResolvedDeviceSession[]> {
    if (!provider) return [];
    try {
        return await provider.list(user);
    } catch (err) {
        logger.warn('External remote targets could not be listed', { error: String(err) });
        return [];
    }
}

/** Test seam. */
export function __resetExternalRemoteTargetProviderForTests(): void {
    provider = null;
}
