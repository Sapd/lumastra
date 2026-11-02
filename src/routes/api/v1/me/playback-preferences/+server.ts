// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/me/playback-preferences — retrieve preferences
// PATCH /api/v1/me/playback-preferences — partial update (presence-preserving)

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/user/playback-preferences.js';

export const { GET, PATCH } = mount(def, { surface: 'v1' });
