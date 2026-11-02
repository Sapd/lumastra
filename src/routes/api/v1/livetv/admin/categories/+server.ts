// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET  /api/v1/livetv/admin/categories — list categories
 * POST /api/v1/livetv/admin/categories — create category
 * Auth scope: livetv:admin
 *
 * Retired: delegateToAdmin shim — now mounted directly via def.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/categories/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
