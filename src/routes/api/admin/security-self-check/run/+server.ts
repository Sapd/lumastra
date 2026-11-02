// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/security-self-check/run
 * Mounted from: src/lib/server/api/defs/admin/ops/security-self-check-run.ts
 *
 * Rate limit (install-wide, 3/min), single-flight lock and audit row live in
 * the def — they replace the withAdminHeavyRateLimit the pre-mount route had.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/ops/security-self-check-run.js';

const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = mount(def, {
    surface: 'internal',
});
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD };
