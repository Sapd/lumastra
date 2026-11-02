#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SW_PATH = join(process.cwd(), 'static', 'sw.js');

try {
    // Read the service worker file
    const swContent = readFileSync(SW_PATH, 'utf8');

    // Release version from env: APP_VERSION (git describe, set by CI as a Docker build-arg);
    // GITHUB_TAG kept as a transitional fallback. Empty locally -> dev suffix branch below.
    const releaseVersion = process.env.APP_VERSION || process.env.GITHUB_TAG;
    let newVersion;
    let updateMessage;

    if (releaseVersion) {
        // CI/Production: use the release version (remove 'v' prefix if present)
        newVersion = releaseVersion.replace(/^v/, '');
        updateMessage = `🚀 Service Worker version set to release: ${newVersion}`;
    } else {
        // Local development: Keep base version, ensure single -dev suffix
        const versionMatch = swContent.match(/const CACHE_NAME\s*=\s*'media-dashboard-v(.+?)';/);

        if (!versionMatch) {
            // Service worker might be disabled - just skip versioning
            console.log('ℹ️  Service worker versioning skipped (SW disabled)');
            process.exit(0);
        }

        const currentVersion = versionMatch[1];

        // Strip any existing -dev suffixes to get the base version
        const baseVersion = currentVersion.replace(/(-dev)+$/, '');

        // Add single -dev suffix for local development
        newVersion = baseVersion + '-dev';

        if (currentVersion === newVersion) {
            // Already has correct dev version, no change needed
            console.log(`ℹ️  Service Worker version unchanged: v${newVersion}`);
            process.exit(0);
        }

        updateMessage = `🚀 Service Worker version updated: v${currentVersion} → v${newVersion}`;
    }

    // Replace the version
    const updatedContent = swContent.replace(
        /(const CACHE_NAME\s*=\s*'media-dashboard-v)(.+?)';/,
        `$1${newVersion}';`,
    );

    // Write the updated file
    writeFileSync(SW_PATH, updatedContent, 'utf8');

    console.log(updateMessage);
} catch (error) {
    console.error('❌ Failed to update service worker version:', error.message);
    process.exit(1);
}
