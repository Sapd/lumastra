// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET, DELETE /api/v1/admin/segment-delivery-failures
 * Mounted from: src/lib/server/api/defs/admin/segment-delivery-failures/index.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/segment-delivery-failures/index.js';

export const { GET, DELETE } = mount(def, { surface: 'v1' });
