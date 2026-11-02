// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/music/recommendations — next track plus alternatives (internal surface).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/recommendations.js';

export const { POST } = mount(def, { surface: 'internal' });
