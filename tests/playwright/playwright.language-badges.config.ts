// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';

// Real browser interaction/layout checks of the shared components, without a DB.
export default defineConfig({
    testDir: '..',
    testMatch: 'language-badges.ui.spec.ts',
    workers: 1,
    reporter: 'list',
    use: { browserName: 'chromium', hasTouch: true, headless: true },
});
