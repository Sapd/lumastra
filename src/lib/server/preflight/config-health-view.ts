// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin-banner view of the config doctor report.
 *
 * The doctor itself is deliberately untouched: `npm run doctor`, the
 * standalone preflight and the container boot STEP 0 keep reporting every
 * issue. What changes is what the *admin banner* is asked to carry.
 *
 * `embedding.no-provider` moved to the attention bell as
 * `optional-integration:embeddings`, where an operator can acknowledge it
 * durably (constant `'missing'` fingerprint) and un-hide it via Health →
 * "Show acknowledged". Leaving it here too would mean an undismissable banner
 * duplicating an ackable nudge.
 *
 * Nothing else is filtered by code. Errors are undismissable by design, and
 * the security warning `forward-auth.trust-any` must never become permanently
 * suppressible.
 *
 * Separately, ALL `info`-severity issues are dropped here regardless of code.
 * `info` means "worth a line in `npm run doctor`, not worth an admin banner" —
 * e.g. `transport.session-cookie-secure-info` (ORIGIN/PROTOCOL_HEADER unset:
 * expected, the session cookie stays Secure unless the request shows plain HTTP).
 * The doctor CLI and the container boot log still see every `info` issue via
 * the unfiltered `DoctorReport`; only this admin-banner view hides them.
 */

import type { DoctorReport, DoctorIssue } from './config-doctor.js';

/** Codes the banner does not render because another surface owns them. */
const BANNER_EXCLUDED_CODES = new Set(['embedding.no-provider']);

/** A doctor issue that is allowed onto the banner: never `info`. */
export type BannerIssue = DoctorIssue & { severity: 'error' | 'warning' };

export interface ConfigHealthView {
    ok: boolean;
    errorCount: number;
    warningCount: number;
    issues: BannerIssue[];
}

export function toConfigHealthView(report: DoctorReport): ConfigHealthView {
    // Only ever exclude WARNING-severity issues by code: the
    // `&& i.severity === 'warning'` guard makes it structurally impossible for
    // an error-severity code to be dropped here, even if one is later added to
    // BANNER_EXCLUDED_CODES by mistake. That's what keeps ok/errorCount —
    // derived below from the UNFILTERED report — provably consistent with
    // `issues`: a banner that ever hid an error would show a red
    // "Configuration error" header with no line explaining it, and no dismiss
    // button either. `info`-severity issues are dropped unconditionally (see
    // module doc) — never a factor in ok/errorCount/warningCount anyway.
    const issues = report.issues.filter(
        (i): i is BannerIssue =>
            i.severity !== 'info' &&
            !(BANNER_EXCLUDED_CODES.has(i.code) && i.severity === 'warning'),
    );
    return {
        ok: report.ok,
        errorCount: report.errorCount,
        warningCount: issues.filter((i) => i.severity === 'warning').length,
        issues,
    };
}
