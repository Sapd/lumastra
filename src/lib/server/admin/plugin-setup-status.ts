// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a builtin integration / watch sync is actually set up, and where an
 * operator sets it up. These plugins take their connection from HOST settings
 * (Settings → Connections), so the plugin registry cannot answer either question:
 * it reported every integration "Enabled" and every watch sync "Active" even
 * with no URL or key anywhere.
 */

import { config, features } from '$lib/server/config.js';
import { getPageForSection } from '$lib/config/admin-settings-pages.js';
import { connectionHref } from './connection-status.js';
import { isPlaceholderValue } from '$lib/server/utils/config-placeholders.js';

export type SetupStatus = 'ready' | 'not-set-up' | 'off';

export interface PluginSetup {
    status: SetupStatus;
    /** Deep link to the settings that configure it. */
    href: string;
}

interface SetupRule {
    /** Host settings that must all be non-empty. */
    keys: readonly string[];
    /** A feature flag that must be on, when the plugin has one. */
    flag?: string;
    /** Connections section + key the "Set up" link highlights. */
    section: string;
    highlight: string;
}

const RULES: Record<string, SetupRule> = {
    // Integrations
    sonarr: { keys: ['SONARRURL', 'SONARRAPIKEY'], section: 'conn-sonarr', highlight: 'SONARRURL' },
    radarr: { keys: ['RADARRURL', 'RADARRAPIKEY'], section: 'conn-radarr', highlight: 'RADARRURL' },
    jellyseerr: {
        keys: ['SEERRURL', 'SEERRAPIKEY'],
        section: 'requests',
        highlight: 'SEERRURL',
    },
    // Watch syncs
    'jellyfin-watch-sync': {
        keys: ['JELLYFINURL', 'JELLYFINAPIKEY'],
        flag: 'FEATURE_JELLYFIN_SYNC',
        section: 'conn-jellyfin',
        highlight: 'FEATURE_JELLYFIN_SYNC',
    },
    'audiobookshelf-watch-sync': {
        keys: ['AUDIOURL', 'AUDIOAPIKEY'],
        flag: 'FEATURE_AUDIOBOOKS',
        section: 'conn-audiobookshelf',
        highlight: 'FEATURE_AUDIOBOOKS',
    },
    'mal-watch-sync': {
        keys: ['MAL_CLIENT_ID', 'MAL_CLIENT_SECRET'],
        section: 'conn-mal',
        highlight: 'MAL_CLIENT_ID',
    },
    'trakt-watch-sync': {
        keys: ['TRAKT_CLIENT_ID', 'TRAKT_CLIENT_SECRET'],
        section: 'conn-trakt',
        highlight: 'TRAKT_CLIENT_ID',
    },
};

function isSet(value: unknown): boolean {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        // A leftover .env.example sample (your_sonarr_api_key,
        // https://kavita.example.com, …) is not real configuration — the
        // getters for TMDB/MDBList/Voyage/OpenAI/Jellyfin/Sonarr/Radarr/
        // Jellyseerr/Audiobookshelf/Kavita already filter this, but
        // MAL_CLIENT_ID/TRAKT_CLIENT_ID etc. don't ship placeholders in
        // .env.example, so this is defense in depth for any key that does.
        return trimmed !== '' && !isPlaceholderValue(trimmed);
    }
    return value !== undefined && value !== null && value !== false;
}

/** `undefined` for a plugin this module has no rule for (e.g. Discogs). */
export function pluginSetup(pluginId: string): PluginSetup | undefined {
    const rule = RULES[pluginId];
    if (!rule) return undefined;
    const values = config as unknown as Record<string, unknown>;
    const href = connectionHref(rule.section, rule.highlight);
    if (rule.flag && values[rule.flag] !== true) return { status: 'off', href };
    const status: SetupStatus = rule.keys.every((k) => isSet(values[k])) ? 'ready' : 'not-set-up';
    return { status, href };
}

/**
 * Built-in feature plugins an admin setting turns on or off. The registry
 * always lists them, so without this the plugins page called them "Active"
 * while the setting had them off.
 */
const FEATURE_SWITCHES: Record<
    string,
    { enabled: () => boolean; section: string; highlight: string }
> = {
    'holiday-recommendations': {
        enabled: () => features.holidays,
        section: 'advanced-tasks',
        highlight: 'DISABLE_HOLIDAY_RECOMMENDATIONS',
    },
};

/**
 * `{ status: 'off', href }` (a deep link to the switch) for a feature plugin
 * whose setting has it off; `undefined` when it is on or has no switch.
 */
export function featureSwitchOff(pluginId: string): PluginSetup | undefined {
    const sw = FEATURE_SWITCHES[pluginId];
    if (!sw || sw.enabled()) return undefined;
    const page = getPageForSection(sw.section)?.href ?? '/admin/settings';
    return { status: 'off', href: `${page}?section=${sw.section}&highlight=${sw.highlight}` };
}
