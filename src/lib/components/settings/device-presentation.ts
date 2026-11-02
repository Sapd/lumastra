// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a signed-in device is presented on /settings/sessions.
 *
 * Kept out of the component so the rules are testable: the list used to show a
 * phone icon for every Apple TV, a raw OAuth client id ("stellar-tvos") as the
 * only hint of what an entry was, and four identical "Apple TV" rows with
 * nothing to say which three were leftovers from earlier sign-ins.
 */

import * as m from '$lib/paraglide/messages';
import type { UserDeviceInfo } from '$lib/schemas/api-user-responses';

export type DeviceKind = 'tv' | 'mobile' | 'web' | 'integration' | 'unknown';

/**
 * What kind of device a session belongs to. The heartbeat / stored device type
 * wins; without one, the OAuth client id is the only clue.
 */
export function deviceKind(s: Pick<UserDeviceInfo, 'deviceType' | 'clientId'>): DeviceKind {
    if (s.deviceType === 'tv' || s.deviceType === 'mobile' || s.deviceType === 'web') {
        return s.deviceType;
    }
    const client = (s.clientId ?? '').toLowerCase();
    if (/tvos|android-?tv|\btv\b/.test(client)) return 'tv';
    if (/ios|android|mobile/.test(client)) return 'mobile';
    if (/rpc|discord|bot|cli|script/.test(client)) return 'integration';
    if (/web|browser/.test(client)) return 'web';
    return 'unknown';
}

/** Readable app name for the first-party / well-known OAuth client ids. */
export function clientLabel(clientId: string | undefined): string {
    switch ((clientId ?? '').toLowerCase()) {
        case '':
            return '';
        case 'lumastra-ios':
            return m.settings_devices_client_ios();
        case 'lumastra-tvos':
        case 'stellar-tvos':
            return m.settings_devices_client_tvos();
        case 'lumastra-discord-rpc':
            return m.settings_devices_client_discord();
        default:
            return clientId ?? '';
    }
}

/**
 * Sessions that are an older sign-in of a device that also has a newer one.
 *
 * Re-signing in on a TV that lost its token leaves the old session alive until
 * it expires, so the list grows one identical row per sign-in. Grouping key is
 * the device id; sessions from clients that never report one fall back to
 * client + name, which is what makes them look identical to a person anyway.
 */
export function olderSessionIds(
    sessions: Pick<
        UserDeviceInfo,
        'deviceSessionId' | 'deviceId' | 'clientId' | 'deviceName' | 'lastUsedAt' | 'createdAt'
    >[],
): Set<string> {
    // Ties (two sign-ins of one device share its last-seen time) go to the
    // session that was issued later.
    const newest = new Map<string, { id: string; at: number; created: number }>();
    const keyOf = (s: (typeof sessions)[number]): string =>
        s.deviceId ? `d:${s.deviceId}` : `c:${s.clientId ?? ''}|${s.deviceName ?? ''}`;
    const atOf = (s: (typeof sessions)[number]): number => {
        const t = Date.parse(s.lastUsedAt ?? s.createdAt);
        return Number.isFinite(t) ? t : 0;
    };
    for (const s of sessions) {
        const key = keyOf(s);
        const at = atOf(s);
        const created = Date.parse(s.createdAt) || 0;
        const cur = newest.get(key);
        if (!cur || at > cur.at || (at === cur.at && created > cur.created)) {
            newest.set(key, { id: s.deviceSessionId, at, created });
        }
    }
    const older = new Set<string>();
    for (const s of sessions) {
        if (newest.get(keyOf(s))?.id !== s.deviceSessionId) older.add(s.deviceSessionId);
    }
    return older;
}
