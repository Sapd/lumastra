// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Centralized Operation Mode Helper
 *
 * Single source of truth for checking system capabilities and availability.
 * After Phase 2, Jellyfin is purely optional — all features work without it.
 * These properties are mainly used by:
 * - Background sync jobs (isJellyfinEnabled, isJellyfinAvailable)
 * - Admin UI display (isJellyfinEnhanced, isStandalone, isJellyfinUnreachable)
 * - Live TV gating (canLiveTV)
 */

import { connectionStatus } from './services/connection-status.service.js';
import { features } from './config.js';

export const operationMode = {
    /** Jellyfin feature is enabled — URL + API key are set (static, doesn't change at runtime) */
    get isJellyfinEnabled(): boolean {
        return features.jellyfin;
    },

    /** Jellyfin is configured AND reachable right now */
    get isJellyfinAvailable(): boolean {
        return connectionStatus.isJellyfinAvailable();
    },

    /** Core DB services healthy but Jellyfin down */
    get isDegraded(): boolean {
        return connectionStatus.isDegradedMode();
    },

    /** Live TV feature is enabled in config */
    get isLiveTVEnabled(): boolean {
        return features.liveTV;
    },

    /** Whether live TV features should be shown */
    get canLiveTV(): boolean {
        return this.isLiveTVEnabled;
    },

    /** Full feature set — Jellyfin is enabled AND currently reachable */
    get isJellyfinEnhanced(): boolean {
        return this.isJellyfinEnabled && this.isJellyfinAvailable;
    },

    /** Discovery-only mode — no media server configured at all */
    get isStandalone(): boolean {
        return !this.isJellyfinEnabled;
    },

    /** Jellyfin is configured but currently unreachable. */
    get isJellyfinUnreachable(): boolean {
        return this.isJellyfinEnabled && !this.isJellyfinAvailable;
    },
} as const;
