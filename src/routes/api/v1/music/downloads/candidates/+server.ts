// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/downloads/candidates — fetch ordering for one smart-downloads lane.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/downloads/candidates.js';

export const { GET } = mount(def, { surface: 'v1' });
