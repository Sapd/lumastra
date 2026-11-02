// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET    /api/v1/access/groups/{id}
 * PATCH  /api/v1/access/groups/{id}
 * DELETE /api/v1/access/groups/{id}
 * Auth scope: access:admin
 *
 * Mounted directly from the def — no delegation required.
 * Params: {id} matches the def's GroupIdParams.id.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/access/groups/[id]/index.js';

export const { GET, PATCH, DELETE } = mount(def, { surface: 'v1' });
