// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/admin/debug-report — the instance debug report (Bearer surface).
 *
 * Hand-mounted, not generated: the cookie mirror at /api/admin/debug-report imports
 * the same def, so gen-api-routes skips it on both surfaces. Keep the two in step.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/debug-report/index.js';

export const { GET } = mount(def, { surface: 'v1' });
