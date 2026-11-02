// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/access/groups — SPA-internal surface mount.
 * Contract: GET → { items, page }; POST → { group } 201; errors → problem+json.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/access/groups/index.js';

export const { GET, POST } = mount(def, { surface: 'internal' });
