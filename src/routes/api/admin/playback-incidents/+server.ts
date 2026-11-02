// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/playback-incidents
 *
 * Cookie/forward-auth mirror of the `/api/v1/admin/playback-incidents`
 * Bearer-only surface — the admin browser UI cannot authenticate against
 * `/api/v1` at all, same reasoning as `defs/admin/transcode-failures`.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/playback-incidents/index.js';

export const { GET, DELETE } = mount(def, { surface: 'internal' });
