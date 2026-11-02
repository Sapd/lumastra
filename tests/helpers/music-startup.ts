// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { test, type Page } from '@playwright/test';
import { expectHydrated } from './hydration';
import {
    isNetworkChangeModuleError,
    networkQuarantineReason,
    retryNetworkStartup,
} from './network-changes';

/** The dev store is exposed before its lazy audio backend has initialized. */
export async function initializeMusicStore(page: Page): Promise<void> {
    while (true) {
        try {
            await page.evaluate(async () => {
                const store = (
                    window as Window & { __musicPlayerStore?: { init: () => Promise<void> } }
                ).__musicPlayerStore;
                if (!store) throw new Error('The dev music store is missing after hydration');
                await store.init();
            });
            return;
        } catch (error) {
            if (!isNetworkChangeModuleError(page, error)) throw error;
            if (await retryNetworkStartup(page)) {
                await expectHydrated(page);
                continue;
            }
            const reason = networkQuarantineReason(page);
            if (process.env.PLAYWRIGHT_ENVIRONMENT_QUARANTINE === '1' && reason) {
                test.info().annotations.push({
                    type: 'environment-quarantine',
                    description: reason,
                });
                test.skip(true, reason);
            }
            throw error;
        }
    }
}
