// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Page, TestInfo } from '@playwright/test';
import {
    observeNetworkChanges,
    withoutNetworkChangeErrors,
    networkQuarantineReason,
    isNetworkChangeModuleError,
    retryNetworkStartup,
} from './helpers/network-changes';

function harness(errorPage = true, hydrated = true, customError = false) {
    const page = Object.assign(new EventEmitter(), {
        reload: vi.fn(async () => {}),
        locator: vi.fn((selector: string) => ({
            count: vi.fn(async () =>
                selector.includes('error-container') ? (customError ? 1 : 0) : hydrated ? 1 : 0,
            ),
        })),
        getByRole: vi.fn(() => ({
            waitFor: vi.fn(async () => {
                if (!errorPage) throw new Error('No Kit error page');
            }),
        })),
    });
    const info = {
        annotations: [] as { type: string; description?: string }[],
        attach: vi.fn(async () => {}),
    };
    const finish = observeNetworkChanges(page as unknown as Page, info as unknown as TestInfo);
    const fail = (error: string, resourceType = 'script'): void => {
        page.emit('requestfailed', {
            resourceType: () => resourceType,
            url: () => 'http://localhost:5173/client.js?private=value',
            failure: () => ({ errorText: error }),
        });
    };
    return { page, info, finish, fail };
}

describe('host network-change recovery', () => {
    it('recovers a failed script plus error page and records the environmental reload', async () => {
        const { page, info, finish, fail } = harness();
        fail('net::ERR_NETWORK_CHANGED');
        await vi.waitFor(() => expect(page.reload).toHaveBeenCalledTimes(1));
        await finish();
        expect(info.annotations).toEqual([
            { type: 'environmental-reload', description: expect.stringContaining('1/2') },
        ]);
        expect(JSON.stringify(info.attach.mock.calls)).not.toContain('private=value');
    });

    it('coalesces a burst and stops after two reloads even if the host keeps changing', async () => {
        const { page, info, finish, fail } = harness();
        page.reload.mockImplementation(async () => {
            fail('net::ERR_NETWORK_CHANGED');
        });
        for (let i = 0; i < 20; i++) fail('net::ERR_NETWORK_CHANGED');
        await vi.waitFor(() => expect(page.reload).toHaveBeenCalledTimes(2));
        fail('net::ERR_NETWORK_CHANGED');
        await finish();
        expect(page.reload).toHaveBeenCalledTimes(2);
        expect(info.annotations).toHaveLength(2);
    });

    it('does not reload without the error page, for other errors, or for API requests', async () => {
        const noErrorPage = harness(false);
        noErrorPage.fail('net::ERR_NETWORK_CHANGED');
        await new Promise((resolve) => setTimeout(resolve, 0));
        await noErrorPage.finish();
        expect(noErrorPage.page.reload).not.toHaveBeenCalled();
        const ordinary = harness();
        ordinary.fail('net::ERR_CONNECTION_REFUSED');
        ordinary.fail('net::ERR_NETWORK_CHANGED', 'fetch');
        await ordinary.finish();
        expect(ordinary.page.reload).not.toHaveBeenCalled();
    });

    it('retains a real module HTTP 500 as diagnostic evidence without reloading', async () => {
        const { page, info, finish } = harness();
        page.emit('response', {
            request: () => ({ resourceType: () => 'script' }),
            status: () => 500,
            headers: () => ({ 'content-type': 'text/html' }),
            url: () => 'http://localhost:5173/broken.js',
            text: async () => 'Real compile failure',
        });
        await finish();
        expect(page.reload).not.toHaveBeenCalled();
        expect(info.attach).toHaveBeenCalled();
        expect(JSON.stringify(info.attach.mock.calls)).toContain('Real compile failure');
    });

    it('recovers aborted startup that leaves unhydrated SSR instead of an error page', async () => {
        const { page, finish, fail } = harness(false, false);
        fail('net::ERR_NETWORK_CHANGED');
        await vi.waitFor(() => expect(page.reload).toHaveBeenCalledTimes(1));
        await finish();
    });

    it('filters only recorded module errors after recovery and preserves ordinary exceptions', async () => {
        const { page, finish, fail } = harness();
        const aborted =
            'Failed to fetch dynamically imported module: http://localhost:5173/parent.js';
        fail('net::ERR_NETWORK_CHANGED');
        page.emit('pageerror', new Error(aborted));
        await vi.waitFor(() => expect(page.reload).toHaveBeenCalledTimes(1));
        await finish();
        expect(
            withoutNetworkChangeErrors(page as unknown as Page, [aborted, 'Real runtime bug']),
        ).toEqual(['Real runtime bug']);
    });

    it('keeps uncorrelated errors and never recovers a concurrent module HTTP failure', async () => {
        const aborted =
            'Failed to fetch dynamically imported module: http://localhost:5173/client.js';
        const unrecovered = harness(false);
        const uncorrelated = aborted.replace('client.js', 'parent.js');
        unrecovered.page.emit('pageerror', new Error(uncorrelated));
        await unrecovered.finish();
        expect(
            withoutNetworkChangeErrors(unrecovered.page as unknown as Page, [uncorrelated]),
        ).toEqual([uncorrelated]);

        const mixed = harness();
        mixed.fail('net::ERR_NETWORK_CHANGED');
        mixed.page.emit('pageerror', new Error(aborted));
        mixed.page.emit('response', {
            request: () => ({ resourceType: () => 'script' }),
            status: () => 500,
            headers: () => ({ 'content-type': 'text/html' }),
            url: () => 'http://localhost:5173/broken.js',
            text: async () => 'Real compile failure',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await mixed.finish();
        expect(mixed.page.reload).not.toHaveBeenCalled();
        expect(withoutNetworkChangeErrors(mixed.page as unknown as Page, [aborted])).toEqual([
            aborted,
        ]);
    });

    it('keeps another network failure even if its import message matches a recovered one', async () => {
        const { page, finish, fail } = harness();
        const aborted =
            'Failed to fetch dynamically imported module: http://localhost:5173/client.js';
        fail('net::ERR_NETWORK_CHANGED');
        page.emit('pageerror', new Error(aborted));
        await vi.waitFor(() => expect(page.reload).toHaveBeenCalledTimes(1));
        fail('net::ERR_CONNECTION_REFUSED');
        await finish();
        expect(withoutNetworkChangeErrors(page as unknown as Page, [aborted, aborted])).toEqual([
            aborted,
            aborted,
        ]);
    });

    it('quarantines only exhausted transport recovery, never HTTP or runtime failures', async () => {
        const makeExhausted = async () => {
            const h = harness();
            h.page.reload.mockImplementation(async () => {
                h.fail('net::ERR_NETWORK_CHANGED');
            });
            h.fail('net::ERR_NETWORK_CHANGED');
            await vi.waitFor(() => expect(h.page.reload).toHaveBeenCalledTimes(2));
            return h;
        };
        const exhausted = await makeExhausted();
        expect(networkQuarantineReason(exhausted.page as unknown as Page)).toContain(
            'two recovery reloads exhausted',
        );
        exhausted.page.emit('pageerror', new Error('Real runtime exception'));
        expect(networkQuarantineReason(exhausted.page as unknown as Page)).toBeUndefined();
        await exhausted.finish();
        const http = await makeExhausted();
        http.page.emit('response', {
            request: () => ({ resourceType: () => 'script' }),
            status: () => 500,
            headers: () => ({ 'content-type': 'text/html' }),
            url: () => 'http://localhost:5173/broken.js',
            text: async () => 'Compile failure',
        });
        expect(networkQuarantineReason(http.page as unknown as Page)).toBeUndefined();
        await http.finish();
        expect(networkQuarantineReason(harness().page as unknown as Page)).toBeUndefined();
    });

    it('excludes pure transport module errors without requiring a page reload', async () => {
        const { page, finish, fail } = harness(false);
        const direct =
            'Failed to fetch dynamically imported module: http://localhost:5173/client.js';
        fail('net::ERR_NETWORK_CHANGED');
        page.emit('pageerror', new Error(direct));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await finish();
        expect(page.reload).not.toHaveBeenCalled();
        expect(withoutNetworkChangeErrors(page as unknown as Page, [direct, 'Real bug'])).toEqual([
            'Real bug',
        ]);
    });

    it('recovers the app custom 500 screen even when the prior layout hydrated', async () => {
        const h = harness(false, true, true);
        h.fail('net::ERR_NETWORK_CHANGED');
        await vi.waitFor(() => expect(h.page.reload).toHaveBeenCalledTimes(1));
        await h.finish();
    });

    it('lazy backend startup shares the two-reload limit and rejects ordinary errors', async () => {
        const h = harness(false);
        expect(await retryNetworkStartup(h.page as unknown as Page)).toBe(false);
        expect(h.page.reload).not.toHaveBeenCalled();
        h.fail('net::ERR_NETWORK_CHANGED');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const page = h.page as unknown as Page;
        expect(isNetworkChangeModuleError(page, new Error('Real backend bug'))).toBe(false);
        expect(
            isNetworkChangeModuleError(
                page,
                new Error(
                    'Failed to fetch dynamically imported module: http://localhost/backend.js',
                ),
            ),
        ).toBe(true);
        expect(await retryNetworkStartup(page)).toBe(true);
        expect(await retryNetworkStartup(page)).toBe(true);
        expect(await retryNetworkStartup(page)).toBe(false);
        expect(h.page.reload).toHaveBeenCalledTimes(2);
        await h.finish();
    });

    it('allows a declared synthetic fetch outage but never exempts a module HTTP error', async () => {
        const h = harness();
        h.page.reload.mockImplementation(async () => {
            h.fail('net::ERR_NETWORK_CHANGED');
        });
        h.fail('net::ERR_NETWORK_CHANGED');
        await vi.waitFor(() => expect(h.page.reload).toHaveBeenCalledTimes(2));
        const response = (resourceType: string) => ({
            request: () => ({ resourceType: () => resourceType }),
            status: () => 503,
            headers: () => ({ 'content-type': 'application/json', 'x-e2e-expected-status': '503' }),
            url: () => 'http://localhost:5173/mock-outage',
            text: async () => 'Expected fixture outage',
        });
        h.page.emit('response', response('fetch'));
        expect(networkQuarantineReason(h.page as unknown as Page)).toBeDefined();
        h.page.emit('response', response('script'));
        expect(networkQuarantineReason(h.page as unknown as Page)).toBeUndefined();
        await h.finish();
    });

    it('never retries mixed connection failures through automatic or explicit startup recovery', async () => {
        const h = harness();
        h.fail('net::ERR_NETWORK_CHANGED');
        h.fail('net::ERR_CONNECTION_REFUSED');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(h.page.reload).not.toHaveBeenCalled();
        expect(await retryNetworkStartup(h.page as unknown as Page)).toBe(false);
        await h.finish();
    });
});
