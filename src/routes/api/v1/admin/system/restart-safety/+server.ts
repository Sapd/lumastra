// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/admin/system/restart-safety
 * Mounted from: src/lib/server/api/defs/admin/system/restart-safety.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/system/restart-safety.js';

export const { GET } = mount(def, { surface: 'v1' });
