// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Proprietary licensing module entry point.
 *
 * The AGPL core's entitlements registry loads this lazily and build-safely via
 * `import.meta.glob` (see `src/lib/server/licensing/entitlements.ts`). In the
 * public AGPL build this file is excluded from the source tree, so the glob
 * matches nothing and the core falls back to its safe defaults. In the official
 * build it registers the license verifier as the entitlements provider and
 * starts the auto-enrol/refresh loop.
 */

import { registerEntitlementsProvider } from '$lib/server/licensing/entitlements.js';
import { registerAiAssistantProvider } from '$lib/server/ai/assistant-provider.js';
import { registerJellyfinCompatRevocationProvider } from '$lib/server/auth/jellyfin-compat-revocation.js';
import { registerJellyfinResponseObserver } from '$lib/server/compat/jellyfin-response-observer.js';
import { registerJellyfinReportBuilder } from '$lib/server/compat/jellyfin-report-provider.js';
import { buildGithubReport } from '$lib/server/proprietary/jellyfin-compat/github-report.js';
import { getEntitlements, getStatus } from './license.service.js';
import { getLicenseRefreshState, startLicenseRefreshLoop } from './license-refresh.js';
import { runAssistant, resolveUser } from '../assistant-service.js';
import { revokeSessionsForUser } from '../jellyfin-compat/auth.js';
import { observeJellyfinResponse } from '../jellyfin-compat/contract/runtime-hook.js';
import { startSilentStartSweeper } from '../jellyfin-compat/silent-start.js';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { isIsolationWorker } from '$lib/server/tasks/isolation/isolation-context.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('ProprietaryInit');

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
    // Wire the proprietary AI assistant into the AGPL-core registry so the
    // plugin `ctx.ai` bridge can reach it WITHOUT the core importing this tree
    // (license boundary). Loaded via the same sanctioned optional-load path as
    // entitlements. The registry contract is intentionally structural
    // (input/deps typed `unknown` in AGPL core, which never sees the proprietary
    // `RunAssistantInput`/`UserContext`), so adapt `runAssistant` at this
    // boundary — the bridge always calls it with the correct concrete shapes.
    registerAiAssistantProvider({
        runAssistant: (input, deps) =>
            runAssistant(
                input as Parameters<typeof runAssistant>[0],
                deps as Parameters<typeof runAssistant>[1],
            ),
        resolveUser,
    });
    // Wire the proprietary /j (Jellyfin-compat) session store into the
    // AGPL-core credential-revocation fan-out (credential-revocation.service.ts)
    // so disabling / resetting the password of / deleting a user also tears
    // down their live /j Valkey sessions — see jellyfin-compat-revocation.ts
    // for why this indirection exists (license boundary).
    registerJellyfinCompatRevocationProvider({ revokeSessionsForUser });
    // Opt-in /j response-contract validator (JELLYFIN_CONTRACT_VALIDATE), called
    // by the AGPL-core jellyfinResponseObserverHandle in hooks.server.ts.
    registerJellyfinResponseObserver(observeJellyfinResponse);
    // Redacted GitHub report for /j diagnostics (admin endpoint in the AGPL core
    // resolves the builder through this registry).
    registerJellyfinReportBuilder(buildGithubReport);
    startLicenseRefreshLoop();
    // Jellyfin-compat silent-start detector sweeper. Lives here (not in
    // hooks.server.ts) so the AGPL hook never imports proprietary code. The
    // timer is unref()ed, so it never blocks process exit and needs no shutdown
    // hook. Stream-proxy-only nodes skip it; elsewhere the sweep claim is atomic.
    if (!config.STREAM_PROXY_MODE) {
        startSilentStartSweeper(async () => getDb());
        // /j/socket (Jellyfin remote control): claims the WebSocket upgrade
        // through the AGPL dispatcher hooks.server.ts installs. Imported
        // lazily so this module's graph stays small.
        void import('../jellyfin-compat/remote-control/register.js')
            .then(({ registerJellyfinRemoteControl }) => registerJellyfinRemoteControl())
            .catch((err: unknown) => {
                logger.warn('Jellyfin remote control not registered', { error: String(err) });
            });
    }
}
