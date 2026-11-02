// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/media/duplicates
 * Mounted from: src/lib/server/api/defs/admin/media/duplicates.js
 *
 * NOTE: The original route applied withAdminHeavyRateLimit (Valkey-based).
 * Rate limiting for mounted defs must be handled at the infra/middleware layer or
 * via mount's rate-limit option when that capability is added. The def itself
 * implements auth:admin which provides baseline protection.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/media/duplicates.js';

const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = mount(def, {
    surface: 'internal',
});
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD };
