// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET    /api/admin/playback-quality?days=<N>
 * DELETE /api/admin/playback-quality
 * Mounted from: src/lib/server/api/defs/admin/playback-quality/index.ts
 *
 * NOTE: The original route applied withAdminHeavyRateLimit (Valkey-based).
 * Rate limiting for mounted defs must be handled at the infra layer when that
 * capability is added. The def implements auth:admin providing baseline protection.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/playback-quality/index.js';

const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = mount(def, {
    surface: 'internal',
});
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD };
