// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/diagnostics/[id]/github-report
 *
 * Cookie/forward-auth mirror — see the sibling `../../+server.ts` doc
 * comment for why this mirror exists.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/diagnostics/[id]/github-report.js';

export const { GET } = mount(def, { surface: 'internal' });
