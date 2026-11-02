// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Watch-Together SSE connection utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    buildStreamUrl,
    parseSSEEvent,
    calculateReconnectDelay,
    createSSEConnection,
} from './sse-connection';

vi.mock('$app/environment', () => ({
    browser: true,
}));

describe('parseSSEEvent', () => {
    it('parses valid JSON', () => {
        const event = { type: 'sync', currentTime: 42 };
        const result = parseSSEEvent(JSON.stringify(event));
        expect(result).toEqual(event);
    });

    it('returns null for invalid JSON', () => {
        const result = parseSSEEvent('not json');
        expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
        const result = parseSSEEvent('');
        expect(result).toBeNull();
    });

    it('returns null for malformed JSON object', () => {
        const result = parseSSEEvent('{type: "sync"}');
        expect(result).toBeNull();
    });
});

describe('buildStreamUrl', () => {
    beforeEach(() => {
        vi.stubGlobal('window', {
            location: { origin: 'http://localhost' },
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('appends query params to base URL', () => {
        const result = buildStreamUrl('/api/stream', {
            clientId: 'abc123',
            user: 'denis',
        });
        expect(result).toContain('/api/stream');
        expect(result).toContain('clientId=abc123');
        expect(result).toContain('user=denis');
    });

    it('handles URL with existing query params by replacing', () => {
        const result = buildStreamUrl('/api/stream?old=1', {
            clientId: 'abc',
        });
        expect(result).toContain('/api/stream');
        expect(result).toContain('clientId=abc');
    });

    it('handles empty params object', () => {
        const result = buildStreamUrl('/api/stream', {});
        expect(result).toBe('/api/stream');
    });
});

describe('calculateReconnectDelay', () => {
    const BASE_DELAY = 1000;
    const MAX_DELAY = 30000;

    it('returns base delay on first attempt', () => {
        expect(calculateReconnectDelay(1)).toBe(BASE_DELAY);
    });

    it('doubles delay on each subsequent attempt', () => {
        expect(calculateReconnectDelay(2)).toBe(2000);
        expect(calculateReconnectDelay(3)).toBe(4000);
        expect(calculateReconnectDelay(4)).toBe(8000);
    });

    it('caps delay at maxReconnectDelay', () => {
        // 2^15 = 32768, so attempt 16 would be 1000 * 32768 = way over max
        expect(calculateReconnectDelay(16)).toBeLessThanOrEqual(MAX_DELAY);
    });

    it('never returns zero or negative', () => {
        expect(calculateReconnectDelay(1)).toBeGreaterThan(0);
        expect(calculateReconnectDelay(100)).toBeGreaterThan(0);
    });
});

/**
 * [M27] createSSEConnection — onerror -> backoff/reconnect/giveup lifecycle.
 *
 * Stubs the global `EventSource` so `connect()`'s `new EventSource(url)`
 * calls resolve to a controllable fake instance whose `onerror`/`onopen`
 * handlers we can invoke directly, combined with fake timers to drive the
 * reconnect-delay `setTimeout` scheduling deterministically.
 */
class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    readonly CONNECTING = FakeEventSource.CONNECTING;
    readonly OPEN = FakeEventSource.OPEN;
    readonly CLOSED = FakeEventSource.CLOSED;

    url: string;
    readyState: number = FakeEventSource.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }

    close(): void {
        this.readyState = FakeEventSource.CLOSED;
    }

    /** Test helper: simulate the connection successfully opening. */
    simulateOpen(): void {
        this.readyState = FakeEventSource.OPEN;
        this.onopen?.();
    }

    /** Test helper: simulate a connection error event. */
    simulateError(): void {
        this.onerror?.(new Event('error'));
    }

    /** Test helper: deliver a live frame with its server-assigned replay id. */
    simulateMessage(data: string, lastEventId: string): void {
        this.onmessage?.({ data, lastEventId } as MessageEvent<string>);
    }

    static instances: FakeEventSource[] = [];
    static reset(): void {
        FakeEventSource.instances = [];
    }
}

describe('[M27] createSSEConnection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeEventSource.reset();
        vi.stubGlobal('EventSource', FakeEventSource);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('onerror schedules a backoff reconnect and calls onError/onReconnecting', () => {
        const onError = vi.fn();
        const onReconnecting = vi.fn();
        const connection = createSSEConnection({
            initialReconnectDelay: 1000,
            maxReconnectDelay: 30000,
            maxReconnectAttempts: 10,
            onError,
            onReconnecting,
        });

        connection.connect('/api/watch-together/stream');
        expect(FakeEventSource.instances).toHaveLength(1);

        FakeEventSource.instances[0].simulateError();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onReconnecting).toHaveBeenCalledWith(1, 10);
        // No reconnect yet — still waiting on the backoff timer.
        expect(FakeEventSource.instances).toHaveLength(1);
    });

    it('reconnects (creates a new EventSource) after the calculated backoff delay elapses', () => {
        const connection = createSSEConnection({
            initialReconnectDelay: 1000,
            maxReconnectDelay: 30000,
            maxReconnectAttempts: 10,
        });

        connection.connect('/api/watch-together/stream');
        FakeEventSource.instances[0].simulateError();
        expect(FakeEventSource.instances).toHaveLength(1);

        // First backoff delay = calculateReconnectDelay(1) = 1000ms
        vi.advanceTimersByTime(999);
        expect(FakeEventSource.instances).toHaveLength(1); // not yet

        vi.advanceTimersByTime(1);
        expect(FakeEventSource.instances).toHaveLength(2); // reconnected
        expect(FakeEventSource.instances[1].url).toBe('/api/watch-together/stream');
    });

    it('carries the latest live event id into a manual reconnect URL', () => {
        vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
        const connection = createSSEConnection({ initialReconnectDelay: 1000 });

        connection.connect('/api/watch-together/events?clientId=c1');
        FakeEventSource.instances[0].simulateMessage('{"type":"all_ready"}', '42');
        FakeEventSource.instances[0].simulateError();
        vi.advanceTimersByTime(1000);

        expect(FakeEventSource.instances[1].url).toBe(
            '/api/watch-together/events?clientId=c1&lastEventId=42',
        );
    });

    it('backs off exponentially across consecutive errors', () => {
        const connection = createSSEConnection({
            initialReconnectDelay: 1000,
            maxReconnectDelay: 30000,
            maxReconnectAttempts: 10,
        });

        connection.connect('/api/watch-together/stream');

        // Attempt 1: error -> reconnect after 1000ms
        FakeEventSource.instances[0].simulateError();
        vi.advanceTimersByTime(1000);
        expect(FakeEventSource.instances).toHaveLength(2);

        // Attempt 2: error again -> reconnect after 2000ms (exponential backoff)
        FakeEventSource.instances[1].simulateError();
        vi.advanceTimersByTime(1999);
        expect(FakeEventSource.instances).toHaveLength(2); // not yet
        vi.advanceTimersByTime(1);
        expect(FakeEventSource.instances).toHaveLength(3);
    });

    it('calls onMaxReconnectsExceeded and disconnects once the attempt cap is reached, without scheduling further reconnects', () => {
        const onMaxReconnectsExceeded = vi.fn();
        const onClose = vi.fn();
        const connection = createSSEConnection({
            initialReconnectDelay: 10,
            maxReconnectDelay: 100,
            maxReconnectAttempts: 2,
            onMaxReconnectsExceeded,
            onClose,
        });

        connection.connect('/api/watch-together/stream');

        // Attempt 1 -> reconnect
        FakeEventSource.instances[0].simulateError();
        expect(onMaxReconnectsExceeded).not.toHaveBeenCalled();
        vi.advanceTimersByTime(10);
        expect(FakeEventSource.instances).toHaveLength(2);

        // Attempt 2 hits the cap (maxReconnectAttempts = 2) -> give up, disconnect.
        FakeEventSource.instances[1].simulateError();
        expect(onMaxReconnectsExceeded).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(connection.isConnected()).toBe(false);

        // No further reconnect should ever be scheduled after giving up.
        vi.advanceTimersByTime(100_000);
        expect(FakeEventSource.instances).toHaveLength(2);
    });

    it('does not reconnect after a manual disconnect, even if a stale error fires afterward', () => {
        const connection = createSSEConnection({
            initialReconnectDelay: 1000,
            maxReconnectDelay: 30000,
            maxReconnectAttempts: 10,
        });

        connection.connect('/api/watch-together/stream');
        const firstInstance = FakeEventSource.instances[0];

        connection.disconnect();
        expect(connection.isConnected()).toBe(false);

        // A stale error on the now-closed (but still referenced) EventSource
        // must not trigger a reconnect — the manual-disconnect flag guards it.
        firstInstance.simulateError();
        vi.advanceTimersByTime(100_000);

        expect(FakeEventSource.instances).toHaveLength(1); // no reconnect created
    });

    it('closes the erroring EventSource so native auto-reconnect cannot race the manual backoff', () => {
        const connection = createSSEConnection({
            initialReconnectDelay: 1000,
            maxReconnectDelay: 30000,
            maxReconnectAttempts: 10,
        });

        connection.connect('/api/watch-together/stream');
        const first = FakeEventSource.instances[0];
        first.simulateError();

        // The erroring source must be closed immediately — otherwise the
        // browser's native EventSource retry runs in parallel with our manual
        // reconnect layer, re-firing onerror and inflating the attempt counter.
        expect(first.readyState).toBe(FakeEventSource.CLOSED);
    });

    it('ignores duplicate error events while a reconnect is already scheduled', () => {
        const onReconnecting = vi.fn();
        const connection = createSSEConnection({
            initialReconnectDelay: 1000,
            maxReconnectDelay: 30000,
            maxReconnectAttempts: 10,
            onReconnecting,
        });

        connection.connect('/api/watch-together/stream');
        const first = FakeEventSource.instances[0];

        // Burst of error events for the same failure (native retries used to
        // deliver several onerror per real attempt).
        first.simulateError();
        first.simulateError();
        first.simulateError();

        // Only ONE reconnect attempt counted and one timer armed.
        expect(connection.getState().reconnectAttempts).toBe(1);
        expect(onReconnecting).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1000);
        expect(FakeEventSource.instances).toHaveLength(2); // exactly one reconnect

        // Nothing else pending.
        vi.advanceTimersByTime(100_000);
        expect(FakeEventSource.instances).toHaveLength(2);
    });

    it('resets the reconnect attempt counter on successful open', () => {
        const onReconnecting = vi.fn();
        const connection = createSSEConnection({
            initialReconnectDelay: 1000,
            maxReconnectDelay: 30000,
            maxReconnectAttempts: 10,
            onReconnecting,
        });

        connection.connect('/api/watch-together/stream');
        FakeEventSource.instances[0].simulateError();
        expect(connection.getState().reconnectAttempts).toBe(1);

        vi.advanceTimersByTime(1000);
        FakeEventSource.instances[1].simulateOpen();

        expect(connection.getState().reconnectAttempts).toBe(0);
    });
});
