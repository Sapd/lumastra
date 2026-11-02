// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/music/progress — kick-cooldown heartbeat (internal surface).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/progress/index.js';
export const { POST } = mount(def, { surface: 'internal' });
