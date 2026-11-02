// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/admin/system-health/invariants
 * Mounted from: src/lib/server/api/defs/admin/system-health/invariants-v1.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/system-health/invariants-v1.js';

export const { GET } = mount(def, { surface: 'v1' });
