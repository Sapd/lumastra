// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/admin/providers/reconnect
 * Mounted from: src/lib/server/api/defs/admin/providers/reconnect.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/providers/reconnect.js';

export const { POST } = mount(def, { surface: 'v1' });
