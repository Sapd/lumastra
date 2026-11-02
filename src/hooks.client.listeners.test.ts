// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The global listeners hooks.client.ts installs: uncaught errors and unhandled
 * rejections reach the diagnostics reporter; resource-load errors do not; the
 * admin opt-out also silences the handleError beacon.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NavigationEvent } from '@sveltejs/kit';

const reportJsError = vi.hoisted(() => vi.fn());
const enabled = vi.hoisted(() => ({ value: undefined as boolean | undefined }));
vi.mock('$lib/client-diagnostics/web-reporter', () => ({
    reportJsError,
    isClientDiagnosticsEnabled: () => enabled.value,
}));

const { handleError } = await import('./hooks.client.js');

afterEach(() => {
    reportJsError.mockClear();
    enabled.value = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
});

describe('hooks.client global listeners', () => {
    it('reports an uncaught error with its script URL', () => {
        const error = new Error('boom');
        window.dispatchEvent(
            new ErrorEvent('error', { error, message: 'boom', filename: 'https://x.test/a.js' }),
        );
        expect(reportJsError).toHaveBeenCalledWith('window_error', error, 'https://x.test/a.js');
    });

    it('ignores an error event without an error object (resource load, cross-origin script)', () => {
        window.dispatchEvent(new Event('error'));
        window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
        expect(reportJsError).not.toHaveBeenCalled();
    });

    it('reports an unhandled rejection with its reason', () => {
        const reason = new Error('nobody awaited me');
        const event = new Event('unhandledrejection') as Event & { reason: unknown };
        Object.defineProperty(event, 'reason', { value: reason });
        window.dispatchEvent(event);
        expect(reportJsError).toHaveBeenCalledWith('unhandled_rejection', reason);
    });
});

describe('hooks.client handleError and the admin switch', () => {
    const event = {
        params: {},
        route: { id: null },
        url: new URL('http://localhost/search/inception?q=private'),
    } as unknown as NavigationEvent;

    it('sends no beacon when diagnostics are off, but still returns an errorId', async () => {
        const sendBeacon = vi.fn(() => true);
        vi.stubGlobal('navigator', { sendBeacon });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        enabled.value = false;
        const result = await handleError({
            error: new Error('x'),
            event,
            status: 500,
            message: 'Internal Error',
        });
        expect(result?.errorId).toBeTruthy();
        expect(sendBeacon).not.toHaveBeenCalled();
    });

    it('templates the path of a route-less error instead of sending it raw', async () => {
        const sendBeacon = vi.fn((_url: string, _blob: Blob) => true);
        vi.stubGlobal('navigator', { sendBeacon });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await handleError({ error: new Error('x'), event, status: 404, message: 'Not Found' });
        const payload = JSON.parse(await sendBeacon.mock.calls[0][1].text()) as { url: string };
        expect(payload.url).toBe('/search/:id');
    });
});

describe('failed route module preload', () => {
    it('keeps the import rejected while reloading once, so Kit never receives an undefined node', async () => {
        const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
        const failure = new TypeError('Failed to fetch dynamically imported module: /_app/node.js');
        // Vite returns undefined from its catch when this event is prevented.
        // Kit then reads node.universal on that undefined result.
        const loadNode = async (): Promise<unknown> => {
            return Promise.reject(failure).catch((error: unknown) => {
                const event = new Event('vite:preloadError', { cancelable: true });
                Object.assign(event, { payload: error });
                window.dispatchEvent(event);
                if (!event.defaultPrevented) throw error;
            });
        };
        await expect(loadNode()).rejects.toBe(failure);
        await expect(loadNode()).rejects.toBe(failure);
        expect(reload).toHaveBeenCalledOnce();
    });
});
