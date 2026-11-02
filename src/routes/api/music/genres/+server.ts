// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/genres — distinct genre list with counts (internal surface).
// Optional ?q= substring filter applied in-memory over the access-scoped cache.
// Returns { genres } bare object; errors are problem+json incl. 503 DB-down.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/genres.js';

export const { GET } = mount(def, { surface: 'internal' });
