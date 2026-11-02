// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/transcode-failures
 *
 * Cookie/forward-auth mirror of the `/api/v1/admin/transcode-failures` Bearer-
 * only surface (see mount.ts's surface split and
 * `$lib/server/tasks/api-auth.ts`'s "session cookie does NOT authorize on
 * /api/v1" note). The admin browser UI cannot authenticate against `/api/v1`
 * at all, so its transcode-failures page (`/admin/system/transcode-failures`)
 * calls this mirror instead — same `def`, mounted on the `internal` surface,
 * exactly like `defs/admin/ffmpeg-jobs` is mounted on both surfaces.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/transcode-failures/index.js';

export const { GET, DELETE } = mount(def, { surface: 'internal' });
