// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/sections/new-for-you — mounts the SAME def as the internal
// /api/music/sections/new-for-you route.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/sections/new-for-you.js';

export const { GET } = mount(def, { surface: 'v1' });
