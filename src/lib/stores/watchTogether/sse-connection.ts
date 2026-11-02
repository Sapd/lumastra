// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SSE Connection Manager
 *
 * Handles Server-Sent Events (SSE) connection lifecycle with exponential backoff.
 * Extracted from watchTogether.ts for better separation of concerns.
 */

import { browser } from '$app/environment';

/** Configuration for SSE connection */
export interface SSEConnectionConfig {
    /** Maximum reconnect attempts before giving up */
    maxReconnectAttempts?: number;
    /** Maximum delay between reconnects (ms) */
    maxReconnectDelay?: number;
    /** Initial reconnect delay (ms) */
    initialReconnectDelay?: number;
    /** Called when connection opens */
    onOpen?: () => void;
    /** Called immediately before each EventSource request is created */
    onConnecting?: (timing: { wallTime: number; monotonicTime: number }) => void;
    /** Called when message received */
    onMessage?: (data: string) => void;
    /** Called when connection error occurs */
    onError?: (error: Event) => void;
    /** Called when max reconnect attempts exceeded */
    onMaxReconnectsExceeded?: () => void;
    /** Called before each reconnect attempt */
    onReconnecting?: (attempt: number, maxAttempts: number) => void;
    /** Called when connection is closed */
    onClose?: () => void;
}

/** SSE connection state */
export interface SSEConnectionState {
    isConnected: boolean;
    isConnecting: boolean;
    reconnectAttempts: number;
    lastError: Event | null;
}

/** Default configuration values */
const DEFAULT_CONFIG: Required<
    Pick<
        SSEConnectionConfig,
        'maxReconnectAttempts' | 'maxReconnectDelay' | 'initialReconnectDelay'
    >
> = {
    maxReconnectAttempts: 10,
    maxReconnectDelay: 30000,
    initialReconnectDelay: 1000,
};

/**
 * Calculate reconnect delay with exponential backoff.
 * Exported as a pure function for unit testing.
 */
export function calculateReconnectDelay(
    attempt: number,
    initialDelay = DEFAULT_CONFIG.initialReconnectDelay,
    maxDelay = DEFAULT_CONFIG.maxReconnectDelay,
): number {
    const delay = initialDelay * Math.pow(2, attempt - 1);
    return Math.min(delay, maxDelay);
}

/**
 * Create an SSE connection manager
 */
export function createSSEConnection(config: SSEConnectionConfig = {}) {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };

    let eventSource: EventSource | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let currentUrl: string | null = null;
    let isManuallyDisconnected = false;
    // Last SSE `id:` seen — sent as ?lastEventId on reconnects so the server
    // replays events missed while disconnected (native EventSource only sends
    // the Last-Event-ID header on ITS OWN retries, not on our manual ones)
    let lastEventId: string | null = null;

    /** Append the replay cursor to the (base) URL for a reconnect attempt. */
    function urlWithReplayCursor(url: string): string {
        if (!lastEventId) return url;
        const u = new URL(url, window.location.origin);
        u.searchParams.set('lastEventId', lastEventId);
        return u.pathname + u.search;
    }

    /**
     * Get current connection state
     */
    function getState(): SSEConnectionState {
        return {
            isConnected: eventSource?.readyState === EventSource.OPEN,
            isConnecting: eventSource?.readyState === EventSource.CONNECTING,
            reconnectAttempts,
            lastError: null,
        };
    }

    /**
     * Connect to SSE endpoint
     */
    function connect(url: string): void {
        if (!browser) return;

        // Reset manual disconnect flag
        isManuallyDisconnected = false;
        currentUrl = url;

        // Close existing connection
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        // Clear any pending reconnect
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        // Create new EventSource (with the replay cursor on reconnects; the
        // base URL in currentUrl stays cursor-free so params don't stack)
        config.onConnecting?.({ wallTime: Date.now(), monotonicTime: performance.now() });
        eventSource = new EventSource(urlWithReplayCursor(url));

        eventSource.onopen = () => {
            reconnectAttempts = 0;
            config.onOpen?.();
        };

        eventSource.onmessage = (event: MessageEvent<string>) => {
            if (event.lastEventId) {
                lastEventId = event.lastEventId;
            }
            config.onMessage?.(event.data);
        };

        eventSource.onerror = (error) => {
            config.onError?.(error);

            // Don't reconnect if manually disconnected
            if (isManuallyDisconnected) return;

            // Close the erroring source so the browser's NATIVE auto-reconnect
            // doesn't race our manual backoff layer. Without this, every native
            // retry failure re-fires onerror, inflating the attempt counter
            // several times per real attempt and spawning parallel connections.
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }

            // A reconnect is already scheduled — don't stack another
            if (reconnectTimer) return;

            // Attempt reconnection
            reconnectAttempts++;

            if (reconnectAttempts >= mergedConfig.maxReconnectAttempts) {
                config.onMaxReconnectsExceeded?.();
                disconnect();
                return;
            }

            const delay = calculateReconnectDelay(
                reconnectAttempts,
                mergedConfig.initialReconnectDelay,
                mergedConfig.maxReconnectDelay,
            );

            config.onReconnecting?.(reconnectAttempts, mergedConfig.maxReconnectAttempts);

            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (!isManuallyDisconnected && currentUrl) {
                    connect(currentUrl);
                }
            }, delay);
        };
    }

    /**
     * Disconnect from SSE endpoint
     */
    function disconnect(): void {
        isManuallyDisconnected = true;
        currentUrl = null;
        lastEventId = null; // fresh session = fresh replay ring

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        reconnectAttempts = 0;
        config.onClose?.();
    }

    /**
     * Check if connected
     */
    function isConnected(): boolean {
        return eventSource?.readyState === EventSource.OPEN;
    }

    /**
     * Reset reconnect counter (call after successful operation)
     */
    function resetReconnectAttempts(): void {
        reconnectAttempts = 0;
    }

    /**
     * Get current URL
     */
    function getUrl(): string | null {
        return currentUrl;
    }

    return {
        connect,
        disconnect,
        isConnected,
        getState,
        resetReconnectAttempts,
        getUrl,
    };
}

/**
 * Type for SSE connection manager instance
 */
export type SSEConnection = ReturnType<typeof createSSEConnection>;

/**
 * Build SSE stream URL with query parameters
 */
export function buildStreamUrl(baseUrl: string, params: Record<string, string>): string {
    const url = new URL(baseUrl, window.location.origin);
    Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
    });
    return url.pathname + url.search;
}

/**
 * Parse SSE event data safely
 */
export function parseSSEEvent<T>(data: string): T | null {
    try {
        return JSON.parse(data) as T;
    } catch (error) {
        console.error('[SSE] Failed to parse event data:', error);
        return null;
    }
}
