// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Proprietary module-gate helpers for the Enterprise/Pro feature route trees.
 *
 * These thin wrappers sit in the PROPRIETARY tree and call the AGPL licensing
 * shim {@link isModuleLicensed} (`$lib/server/licensing/feature-gate`). The call
 * direction is proprietary → AGPL, which the open-core boundary explicitly
 * permits (see `scripts/check-license-boundary.mjs`).
 *
 * Why a shared helper: every proprietary feature load function must AND its
 * existing `config.FEATURE_*` flag with the relevant license module so the
 * Enterprise/Pro tier cannot run unlicensed when `LICENSE_ENFORCEMENT_ENABLED`
 * is true with no key. Centralising the throw keeps the gate identical across
 * ~30 route/api files and mirrors the existing AI-assistant gate pattern in
 * `src/routes/+layout.server.ts`.
 *
 * FAIL-OPEN / FAIL-TO-FREE semantics are inherited from `isModuleLicensed`:
 *  - Enforcement OFF (default)        → licensed (UNLIMITED) → gate passes.
 *  - Enforcement ON, valid license    → module present       → gate passes.
 *  - Enforcement ON, no/invalid/error → module ABSENT (free) → gate blocks.
 * The gate therefore FAILS CLOSED for the paid module (no module → blocked)
 * while never throwing itself, exactly as the spec requires.
 */

import { error, redirect } from '@sveltejs/kit';
import { isModuleLicensed } from '$lib/server/licensing/feature-gate.js';
import type { LicenseModule } from '$lib/server/licensing/entitlements.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';

/**
 * Throw a 404 when the given commercial module is not licensed.
 *
 * Use in surfaces that should be completely dark when unlicensed (public
 * showcase, certificate verification, learner pages reached by deep link) —
 * matching how those routes already 404 when their `FEATURE_*` master switch is
 * off, so an unlicensed install reveals nothing about the feature's existence.
 */
export async function requireModuleOr404(m: LicenseModule, message = 'Not Found'): Promise<void> {
    if (!(await isModuleLicensed(m))) {
        error(404, message);
    }
}

/**
 * Throw a 302 redirect to `to` when the given commercial module is not licensed.
 *
 * Use in authenticated app/admin surfaces that already redirect (rather than
 * 404) when their `FEATURE_*` flag is off — e.g. `/learn` → `/`, admin pages →
 * `/admin`. Keeps the unlicensed UX identical to the feature-disabled UX.
 */
export async function requireModuleOrRedirect(m: LicenseModule, to: string): Promise<void> {
    if (!(await isModuleLicensed(m))) {
        redirect(302, to);
    }
}

/**
 * For `+server.ts` API handlers (which RETURN responses rather than throw):
 * resolve to a 404 `Response` when the module is unlicensed, or `null` when it
 * is licensed (so the caller proceeds). Mirrors the `notFound` shape these
 * routes already return for a disabled `FEATURE_*` flag (no existence leak).
 *
 * Usage:
 * ```ts
 * const gate = await moduleGateResponse('assessment', endpoint);
 * if (gate) return gate;
 * ```
 */
export async function moduleGateResponse(
    m: LicenseModule,
    endpoint?: string,
): Promise<Response | null> {
    if (!(await isModuleLicensed(m))) {
        return ApiResponses.notFound('Not Found', endpoint);
    }
    return null;
}
