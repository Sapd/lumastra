// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/livetv/admin/categories/{categoryId}/channel-count — channel count for category
 * Auth scope: livetv:admin
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/categories/[id]/channel-count.js';

export const { GET } = mount(def, { surface: 'v1' });
