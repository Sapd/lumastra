// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/sections/smart-mixes — mounts the SAME def as the internal
// /api/music/sections/smart-mixes route.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/sections/smart-mixes.js';

export const { GET } = mount(def, { surface: 'v1' });
