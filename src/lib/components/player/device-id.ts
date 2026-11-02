// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { browser } from '$app/environment';
import { safeRandomUUID } from '$lib/utils/safe-uuid';

// ============================================================================
// Device ID Management
// ============================================================================

const DEVICE_ID_KEY = 'dashboard_device_id';

/**
 * Get or generate a unique device ID for this browser
 * Stored in localStorage so it persists across sessions but is unique per browser
 * This ID is sent to the server for Jellyfin token management
 */
export function getDeviceId(): string {
    if (!browser) {
        return 'dashboard-server';
    }

    // Try to get existing device ID from localStorage
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);

    if (!deviceId) {
        deviceId = 'dashboard-' + safeRandomUUID();
        localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }

    return deviceId;
}
