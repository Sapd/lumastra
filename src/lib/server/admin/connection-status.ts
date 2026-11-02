// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The external services on Settings → Connections, each with the config
 * section that holds its settings and whether it is set up. One place answers
 * "is Sonarr connected, and where do I set it up" — the plugins page, the
 * metadata page and the setup checklist link here.
 */

import { config } from '$lib/server/config.js';

export interface ConnectionService {
    /** Config section id — also the `?category=` / `?section=` value. */
    section: string;
    name: string;
    /** Host settings that must all be non-empty for "set up". */
    keys: readonly string[];
}

export const CONNECTION_SERVICES: readonly ConnectionService[] = [
    { section: 'conn-jellyfin', name: 'Jellyfin', keys: ['JELLYFINURL', 'JELLYFINAPIKEY'] },
    { section: 'conn-audiobookshelf', name: 'Audiobookshelf', keys: ['AUDIOURL', 'AUDIOAPIKEY'] },
    { section: 'conn-kavita', name: 'Kavita', keys: ['KAVITAURL', 'KAVITAAPIKEY'] },
    { section: 'conn-sonarr', name: 'Sonarr', keys: ['SONARRURL', 'SONARRAPIKEY'] },
    { section: 'conn-radarr', name: 'Radarr', keys: ['RADARRURL', 'RADARRAPIKEY'] },
    { section: 'requests', name: 'Seerr', keys: ['SEERRURL', 'SEERRAPIKEY'] },
    { section: 'conn-trakt', name: 'Trakt', keys: ['TRAKT_CLIENT_ID', 'TRAKT_CLIENT_SECRET'] },
    { section: 'conn-mal', name: 'MyAnimeList', keys: ['MAL_CLIENT_ID', 'MAL_CLIENT_SECRET'] },
];

export const CONNECTIONS_PAGE = '/admin/settings/connections';

/** Deep link that opens a service's section and highlights one of its settings. */
export function connectionHref(section: string, highlight?: string): string {
    return highlight
        ? `${CONNECTIONS_PAGE}?section=${section}&highlight=${highlight}`
        : `${CONNECTIONS_PAGE}?category=${section}`;
}

function isSet(value: unknown): boolean {
    return typeof value === 'string' ? value.trim() !== '' : value != null && value !== false;
}

export interface ConnectionStatus {
    section: string;
    name: string;
    configured: boolean;
}

export function connectionStatuses(): ConnectionStatus[] {
    const values = config as unknown as Record<string, unknown>;
    return CONNECTION_SERVICES.map((s) => ({
        section: s.section,
        name: s.name,
        configured: s.keys.every((k) => isSet(values[k])),
    }));
}
