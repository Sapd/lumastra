// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createPolicyTable } from './policy.js';
import { ROUTE_POLICY_RULES } from './rules.js';

/** The compiled AGPL route policy table. `(enterprise)` route ids never match it. */
export const routePolicyTable = createPolicyTable(ROUTE_POLICY_RULES);
