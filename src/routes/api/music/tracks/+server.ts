// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/tracks — flat track browse (internal surface).
// Mounts the SAME shared def as /api/v1/music/tracks, so both surfaces run
// identical auth/validation/handler logic.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/tracks.js';

export const { GET } = mount(def, { surface: 'internal' });
