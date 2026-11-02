// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/music/recommendations — public/native (Bearer token) surface. Mounts the
// SAME shared def as the internal /api/music/recommendations route.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/recommendations.js';

export const { POST } = mount(def, { surface: 'v1' });
