// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure helpers for the device remote-control clients (Send to TV, Watch
 * Together invite, the devices-page remote): capability checks, error codes,
 * media-type mapping and position extrapolation.
 *
 * Design: repo-root docs/superpowers/specs/2026-10-16-device-remote-control-design.md.
 */

import * as m from '$lib/paraglide/messages';
import type {
    DeviceCapabilities,
    DeviceCommand,
    DeviceCommandStatus,
    MediaPlayKind,
} from '$lib/schemas/device-commands';

/** Whether the device announced it handles `type` (static, from its heartbeat). */
export function deviceSupports(
    capabilities: DeviceCapabilities | null | undefined,
    type: string,
): boolean {
    const commands = capabilities?.commands;
    return !!commands && Object.prototype.hasOwnProperty.call(commands, type);
}

/** Whether the device announced any remote-control command at all. */
export function deviceHasCommands(capabilities: DeviceCapabilities | null | undefined): boolean {
    const commands = capabilities?.commands;
    return !!commands && Object.keys(commands).length > 0;
}

/**
 * The `kind` of a `media.play` command for a loose media-type string (any
 * case, either the storage or the public vocabulary), or null when the type
 * cannot be sent to a device.
 */
export function mediaPlayKind(mediaType: string | null | undefined): MediaPlayKind | null {
    switch ((mediaType ?? '').toLowerCase()) {
        case 'movie':
            return 'movie';
        case 'episode':
            return 'episode';
        case 'series':
        case 'tv':
            return 'series';
        case 'track':
        case 'audio':
            return 'track';
        case 'album':
            return 'album';
        case 'playlist':
            return 'playlist';
        case 'artist':
            return 'artist';
        case 'audiobook':
            return 'audiobook';
        default:
            return null;
    }
}

export type CommandFailure =
    | 'device_unreachable'
    | 'device_unsupported'
    | 'stale_target'
    | 'simple_mode_locked'
    | 'rate_limited'
    | 'other';

const FAILURE_CODES: ReadonlySet<string> = new Set([
    'device_unreachable',
    'device_unsupported',
    'stale_target',
    'simple_mode_locked',
    'rate_limited',
]);

function findFailureCode(value: unknown, depth = 0): CommandFailure | null {
    if (typeof value === 'string') {
        if (FAILURE_CODES.has(value)) return value as CommandFailure;
        // Some routes JSON.stringify a detail object into `details`.
        if (depth === 0 && value.startsWith('{')) {
            try {
                return findFailureCode(JSON.parse(value), depth + 1);
            } catch {
                return null;
            }
        }
        return null;
    }
    if (value && typeof value === 'object' && depth < 3) {
        const record = value as Record<string, unknown>;
        for (const key of ['details', 'code', 'error']) {
            const found = findFailureCode(record[key], depth + 1);
            if (found) return found;
        }
    }
    return null;
}

/** Map a failed API result (problem+json `details`) to a stable failure code. */
export function commandFailureOf(result: {
    code?: string | undefined;
    details?: unknown;
    status?: number | undefined;
}): CommandFailure {
    const found = findFailureCode(result.details) ?? findFailureCode(result.code);
    if (found) return found;
    if (result.status === 429) return 'rate_limited';
    return 'other';
}

/** The calm sentence for a failed command, naming the device. */
export function commandFailureMessage(failure: CommandFailure, device: string): string {
    switch (failure) {
        case 'device_unreachable':
            return m.device_command_unreachable({ device });
        case 'device_unsupported':
            return m.device_command_unsupported({ device });
        case 'stale_target':
            return m.device_command_stale();
        case 'simple_mode_locked':
            return m.device_command_locked({ device });
        case 'rate_limited':
            return m.device_command_rate_limited();
        default:
            return m.device_command_failed();
    }
}

/** Statuses after which the device has acted (or the command is dead). */
export const SETTLED_COMMAND_STATUSES: ReadonlySet<DeviceCommandStatus> = new Set([
    'applied',
    'rejected',
    'expired',
    'superseded',
    'cancelled',
    'acknowledged',
]);

export function isSettled(command: Pick<DeviceCommand, 'status'>): boolean {
    return SETTLED_COMMAND_STATUSES.has(command.status);
}

/** True for the settled statuses that mean "it worked". */
export function isSuccessful(command: Pick<DeviceCommand, 'status'>): boolean {
    return command.status === 'applied' || command.status === 'acknowledged';
}

/**
 * The frame payload for `device.command_status` / `device.state`. The stream
 * wraps the object as `{targetUserId, kind, data: {...}}`; tolerate the bare
 * object too.
 */
export function framePayload(data: unknown): Record<string, unknown> | null {
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    const inner = record.data;
    if (inner && typeof inner === 'object' && 'kind' in record) {
        return inner as Record<string, unknown>;
    }
    return record;
}

/** Longest stretch a position is extrapolated before a fresh report is due. */
const MAX_EXTRAPOLATION_SECONDS = 30;

/**
 * The position to show now: the reported one plus the time since it was
 * observed while the device plays; frozen while paused.
 */
export function extrapolatePosition(
    nowPlaying: {
        positionSeconds?: number | undefined;
        durationMs?: number | undefined;
        paused: boolean;
        rate?: number | undefined;
        observedAt?: string | undefined;
    },
    nowMs: number,
): number | null {
    if (nowPlaying.positionSeconds === undefined) return null;
    let position = nowPlaying.positionSeconds;
    if (!nowPlaying.paused && nowPlaying.observedAt) {
        const observed = Date.parse(nowPlaying.observedAt);
        if (Number.isFinite(observed)) {
            const elapsed = Math.min(
                Math.max((nowMs - observed) / 1000, 0),
                MAX_EXTRAPOLATION_SECONDS,
            );
            position += elapsed * (nowPlaying.rate ?? 1);
        }
    }
    if (nowPlaying.durationMs !== undefined && nowPlaying.durationMs > 0) {
        position = Math.min(position, nowPlaying.durationMs / 1000);
    }
    return position;
}
