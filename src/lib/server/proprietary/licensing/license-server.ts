// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Licensing server endpoint — HARDCODED on purpose.
 *
 * Deliberately NOT an admin setting and NOT an env var on a production build,
 * for the same reason `LICENSE_ENFORCEMENT_BUILD_DEFAULT` isn't: the bar is
 * "edit + rebuild", not "flip a setting".
 *
 * Pointing this elsewhere cannot work anyway. Keys are verified offline against
 * the baked-in public key and issuer in `./public-key.ts`, so no other server
 * can issue one this build accepts — a configurable URL could only ever break
 * auto-enrolment, never redirect it somewhere useful. As an admin-UI field it
 * did worse than nothing: it advertised the one call to disable, and its help
 * text invited operators to "self-host the licensing server", which is not
 * possible without the private signing key.
 *
 * Endpoint and trust root live side by side here so the two stay coupled, and so
 * the public-repo publish filter has one proprietary file to drop rather than
 * entries to strip out of the shared core `config.ts` / `schema.ts`.
 *
 * `LICENSE_SERVER_URL` in the environment is honoured ONLY on a dev build
 * (`NODE_ENV !== 'production'`), so the licensing server itself can be developed
 * against localhost.
 */

import { dev } from '$lib/server/config';

/** The official licensing server. Changing this requires a rebuild. */
const OFFICIAL_LICENSE_SERVER_URL = 'https://lumastra.org';

/** Base URL of the licensing server, without a trailing slash. */
export const LICENSE_SERVER_URL: string = (
    (dev ? process.env.LICENSE_SERVER_URL?.trim() : '') || OFFICIAL_LICENSE_SERVER_URL
).replace(/\/+$/, '');
