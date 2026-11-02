// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Navigate and wait for client handlers. The shared auth fixture recovers only
 * observed ERR_NETWORK_CHANGED script aborts followed by Kit's error page.
 * Do not reload arbitrary 500s here: an application failure must remain red.
 */
import type { Page, Response } from '@playwright/test';
import { expectHydrated, HYDRATION_TIMEOUT_MS } from './hydration';

export async function gotoHydrated(
    page: Page,
    url: string,
    timeout: number = HYDRATION_TIMEOUT_MS,
): Promise<Response | null> {
    const response = await page.goto(url);
    await expectHydrated(page, timeout);
    return response;
}
