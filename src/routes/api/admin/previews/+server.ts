// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET  /api/admin/previews — admission status + preview cache stats
 * POST /api/admin/previews — toggle `{ disabled: boolean }` (admin override)
 * Mounted from: src/lib/server/api/defs/admin/previews/index.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/previews/index.js';

export const { GET, POST } = mount(def, { surface: 'internal' });
