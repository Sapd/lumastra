// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together Stores & Utilities
 *
 * Re-exports for watch together functionality.
 */

// Session persistence utilities
export {
    STORAGE_KEY,
    CLIENT_ID_KEY,
    NAVIGATING_KEY,
    getOrCreateClientId,
    claimClientId,
    saveToStorage,
    loadFromStorage,
    clearStorage,
    isNavigatingWithinSession,
    setNavigatingWithinSessionFlag,
    getCurrentClientId,
    hasStoredSession,
    type StoredSession,
} from './session-persistence';

// SSE connection utilities
export {
    createSSEConnection,
    buildStreamUrl,
    parseSSEEvent,
    type SSEConnectionConfig,
    type SSEConnectionState,
    type SSEConnection,
} from './sse-connection';

// Sync logic (pure functions extracted for testability)
export { calculateTimeToSync, isHostDevice, isOwnEvent } from './sync-logic';

// SSE instability warning debounce (pure logic extracted for testability)
export { evaluateReconnect, initialInstabilityState, type InstabilityState } from './instability';
