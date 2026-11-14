// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When this install may call lumastra.org, beyond the admin switch.
 *
 * Two calls go to lumastra.org: the push relay token (`push/relay-token-enrol.ts`)
 * and the release list of the update check (`lumastra-update-check` task). Both
 * use this one rule:
 *
 *   `LICENSE_SERVER_CONTACT_ENABLED` is on, AND the operator answered the contact
 *   question (setup wizard, admin save or environment), OR setup completed more
 *   than a day ago.
 *
 * So a new install that is never asked makes no lumastra.org call until a day
 * after setup. Until then the update check reads GitHub. This module covers the
 * answer; the switch itself is read by each caller when the request is made.
 *
 * @module services/lumastra-org-consent
 */

import type postgres from 'postgres';
import { getConfigState, isEnvOverridden } from '$lib/server/config/index.js';
import { isFirstRunSetupOlderThan } from '$lib/server/database/queries/onboarding.queries.js';

/** Stored key of the "contact lumastra.org" switch (the name is historical). */
export const CONTACT_SWITCH_KEY = 'LICENSE_SERVER_CONTACT_ENABLED';

/** An install without a stored answer to the contact question waits this long after setup. */
export const CONTACT_SETUP_FALLBACK_MS = 24 * 60 * 60 * 1000;

/** The operator answered the contact question (environment, wizard or admin save). */
export function contactQuestionAnswered(): boolean {
    return (
        isEnvOverridden(CONTACT_SWITCH_KEY) ||
        getConfigState()?.jsonOverrides.has(CONTACT_SWITCH_KEY) === true
    );
}

/**
 * True when the operator answered the contact question, or setup completed at
 * least a day ago. Rejects when the database cannot say; callers treat that as
 * "not yet".
 */
export async function setupAllowsLumastraOrgContact(sql: postgres.Sql): Promise<boolean> {
    if (contactQuestionAnswered()) return true;
    return isFirstRunSetupOlderThan(sql, CONTACT_SETUP_FALLBACK_MS);
}
