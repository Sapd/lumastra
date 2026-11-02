// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { config } from '$lib/server/config.js';
import type { ArchiveLimits } from './archive.js';

/** Assemble the extraction/re-verify caps from the non-secret config knobs. */
export function bundleLimitsFromConfig(): ArchiveLimits {
    return {
        maxTotalBytes: config.PLUGIN_INSTALL_MAX_EXTRACTED_BYTES,
        maxEntries: config.PLUGIN_INSTALL_MAX_ENTRIES,
        maxFileBytes: config.PLUGIN_INSTALL_MAX_FILE_BYTES,
    };
}
