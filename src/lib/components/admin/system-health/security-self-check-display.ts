// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Presentation rules for the Health page's security self-check section that
 * must stay total over `SecuritySelfCheckStatusSchema`.
 *
 * Why a module and not a `const` in SecuritySelfCheckPanel.svelte: nothing in
 * this repo type-checks a lookup map written inside a component. `npm run
 * typecheck` runs tsgo, which does not read `.svelte` at all, and `npm run
 * check` (svelte-check-native) was MEASURED on 2026-08-27 not to flag a renamed
 * key in a component-local `Record<Union, …>` either.
 *
 * That mattered here more than anywhere else on the Health page. The panel
 * folds each method's findings into one worst-status dot with
 * `if (SEVERITY[f.status] > SEVERITY[worst]) worst = f.status`, starting from
 * `'pass'`. An unranked status yields `undefined`, every comparison against it
 * is false, and the group keeps the `'pass'` it started with — so a NEW FAILING
 * status would have rendered a green header over a red finding. The failure mode
 * of a missing entry is not a blank label, it is a security surface reporting
 * the opposite of the truth.
 */

import type { SecuritySelfCheckStatus } from '$lib/schemas/security-self-check.js';

/**
 * Rank for "worst status wins", high is worse: fail > error > warn > info >
 * skipped > pass.
 *
 * A `switch` rather than a `Record<SecuritySelfCheckStatus, number>` even here
 * in a `.ts` file: a record catches a status added to the schema, but a `switch`
 * with a declared return type catches that AND a case naming a status that no
 * longer exists. There is no default arm on purpose — adding one would restore
 * exactly the silent-`undefined` behaviour this module exists to remove, just
 * spelled differently.
 */
export function securityStatusSeverity(status: SecuritySelfCheckStatus): number {
    switch (status) {
        case 'fail':
            return 6;
        case 'error':
            return 5;
        case 'warn':
            return 4;
        case 'info':
            return 3;
        case 'skipped':
            return 2;
        case 'pass':
            return 1;
    }
}
