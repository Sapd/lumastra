// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Proprietary licensing module entry point.
 *
 * The AGPL core's entitlements registry loads this lazily and build-safely via
 * `import.meta.glob` (see `src/lib/server/licensing/entitlements.ts`). It
 * registers the licence verifier as the entitlements provider and starts the
 * licence refresh loop. It is being removed: Lumastra has no paid parts, and
 * the registrations that used to live here besides licensing (AI assistant,
 * /j revocation, response observer, report builder, silent-start sweeper, /j
 * remote control) moved to `$lib/server/boot/compat-init.ts`, which every
 * process now loads itself. This file only asks it to run, idempotently, so a
 * process that reaches the licence module first still gets them.
 */

import { registerEntitlementsProvider } from '$lib/server/licensing/entitlements.js';
import { ensureCompatLoaded } from '$lib/server/boot/compat-init.js';
import { isIsolationWorker } from '$lib/server/tasks/isolation/isolation-context.js';
import { getEntitlements, getStatus } from './license.service.js';
import { getLicenseRefreshState, startLicenseRefreshLoop } from './license-refresh.js';

let initialised = false;

export function initProprietaryLicensing(): void {
    // Main-process only: the refresh loop writes LICENSE_KEY (a sealed secret),
    // which a plugin-isolation worker cannot do — it holds no master key (B1).
    if (isIsolationWorker()) return;
    if (initialised) return;
    initialised = true;

    registerEntitlementsProvider({
        getEntitlements,
        getStatus,
        getServerContact: getLicenseRefreshState,
    });
    // Starts the push relay token enrolment loop first (it makes the licence
    // loop below leave the relay token alone), then the /j and assistant wiring.
    void ensureCompatLoaded();
    startLicenseRefreshLoop();
}
