// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/jellyfin-compat/unknown-routes
 *
 * Cookie/forward-auth mirror of the admin def (internal surface).
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/jellyfin-compat/unknown-routes/index.js';

export const { GET } = mount(def, { surface: 'internal' });
