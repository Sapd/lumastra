// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/downloads
 *
 * Cookie/forward-auth surface only (the admin browser UI cannot authenticate
 * against /api/v1). Mounted from defs/admin/downloads/index.ts.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/downloads/index.js';

export const { GET } = mount(def, { surface: 'internal' });
