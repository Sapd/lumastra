// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages';

export interface JellyfinAuthOptions {
    /** null deliberately omits the token for Quick Connect authentication. */
    token: string | null;
    deviceName?: string;
    deviceId?: string;
}

export const clientName = 'Lumastra';

// Jellyfin parses a comma-separated, quoted list without an escaping mechanism.
// Preserve the existing device-name normalization so token identity stays stable.
function sanitizeIdentity(value: string, maxLength?: number): string {
    return Array.from(value)
        .filter((c) => c !== '"' && c !== '\\' && c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
        .join('')
        .slice(0, maxLength);
}

/**
 * The standard header works on Jellyfin 10.8+ and 12.x. Do not add legacy
 * X-Emby-* headers or put credentials in URLs: 12.x disables legacy auth.
 * Explicit tokens prevent user validation from falling back to the admin key.
 */
export function buildJellyfinAuthHeaders(options: JellyfinAuthOptions): { Authorization: string } {
    const parts = [
        `Client="${clientName}"`,
        `Device="${sanitizeIdentity(options.deviceName || 'Lumastra Server', 100)}"`,
        `DeviceId="${sanitizeIdentity(options.deviceId || 'lumastra-server')}"`,
        'Version="1.0.0"',
    ];
    if (options.token !== null) {
        // Reject malformed credentials instead of changing them or letting them
        // inject auth parameters. Never include the credential in the error.
        if (
            !options.token ||
            sanitizeIdentity(options.token) !== options.token ||
            options.token.includes(',')
        ) {
            throw new Error('Invalid Jellyfin token');
        }
        parts.push(`Token="${options.token}"`);
    }
    return { Authorization: `MediaBrowser ${parts.join(', ')}` };
}

export function jellyfinHttpError(status: number): string {
    if (status === 401) {
        return m.jellyfin_auth_rejected();
    }
    return `Jellyfin returned HTTP ${status}`;
}
