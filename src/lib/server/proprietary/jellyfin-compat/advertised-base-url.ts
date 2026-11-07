// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { base } from '$app/paths';
import { config } from '$lib/server/config';
import { normalizePublicBaseUrl } from '$lib/shared/public-base-url.js';

/**
 * The app URL `/j` advertises as `LocalAddress` (`/j`, `/j/System/Info`,
 * `/j/System/Info/Public`): the configured `PUBLIC_BASE_URL`, else the request
 * origin plus the install's base path. The fallback keeps the base path, as
 * `PUBLIC_BASE_URL` does, so a sub-path install without one still advertises
 * its app root, not the host root.
 */
export function advertisedBaseUrl(requestUrl: URL): string {
    return normalizePublicBaseUrl(config.PUBLIC_BASE_URL) || `${requestUrl.origin}${base}`;
}
