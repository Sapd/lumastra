// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/sections/mood-shelf — mounts the SAME def as the internal
// /api/music/sections/mood-shelf route.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/sections/mood-shelf.js';

export const { GET } = mount(def, { surface: 'v1' });
