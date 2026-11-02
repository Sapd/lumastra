// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/diagnostics
 *
 * Cookie/forward-auth admin surface for the client diagnostics list + bulk
 * clear. Internal-only — the admin browser UI cannot authenticate against
 * /api/v1 at all, same reasoning as defs/admin/playback-incidents.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/diagnostics/index.js';

export const { GET, DELETE } = mount(def, { surface: 'internal' });
