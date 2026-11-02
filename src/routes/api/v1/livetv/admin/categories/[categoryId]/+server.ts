// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET    /api/v1/livetv/admin/categories/{categoryId} — get category
 * PUT    /api/v1/livetv/admin/categories/{categoryId} — update visibility/name
 * DELETE /api/v1/livetv/admin/categories/{categoryId} — delete empty category
 * Auth scope: livetv:admin
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/categories/[id]/index.js';

export const { GET, PUT, DELETE } = mount(def, { surface: 'v1' });
