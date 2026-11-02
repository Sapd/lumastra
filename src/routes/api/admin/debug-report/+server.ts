// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/debug-report
 *
 * Cookie/forward-auth mirror of the `/api/v1/admin/debug-report` Bearer surface
 * (see mount.ts's surface split). The admin "Debug report" page cannot authenticate
 * against `/api/v1` with its cookie, so it calls this mirror instead: the same `def`,
 * mounted on the `internal` surface. The drill-downs stay v1-only.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/debug-report/index.js';

export const { GET } = mount(def, { surface: 'internal' });
