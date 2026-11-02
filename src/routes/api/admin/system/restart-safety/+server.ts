// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/system/restart-safety
 *
 * Cookie/forward-auth mirror of the `/api/v1/admin/system/restart-safety`
 * Bearer-only surface (see mount.ts's surface split). The admin browser UI
 * cannot authenticate against `/api/v1` at all, so the health page calls this
 * mirror instead — same `def`, mounted on the `internal` surface.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/system/restart-safety.js';

export const { GET } = mount(def, { surface: 'internal' });
