// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page } from '@playwright/test';

/**
 * Fail fast, with the reason, when the e2e server does not have a feature a spec
 * is about. Some home widgets exist only when the server is configured for them
 * (`features.calendar` needs Sonarr or Radarr, `features.requests` needs
 * FEATURE_REQUEST_MODAL plus a Seerr URL and key). Without this a spec on such a
 * widget waits out its whole timeout and reports "element not found", which
 * reads like a rendering bug. This is a failure, never a skip: a skipped spec
 * would be a false green.
 */
export async function expectServerFeature(
    page: Page,
    feature: string,
    howToEnable: string,
): Promise<void> {
    const response = await page.request.get('/api/server');
    expect(response.ok(), 'GET /api/server').toBe(true);
    const body = (await response.json()) as {
        capabilities?: { features: Record<string, unknown> };
    };
    expect(
        body.capabilities?.features[feature],
        `the e2e server must have capabilities.features.${feature} on: ${howToEnable}`,
    ).toBe(true);
}
