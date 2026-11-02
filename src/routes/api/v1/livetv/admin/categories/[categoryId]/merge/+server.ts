// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/livetv/admin/categories/{categoryId}/merge — merge into target category
 * Auth scope: livetv:admin
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/categories/[id]/merge.js';

export const { POST } = mount(def, { surface: 'v1' });
