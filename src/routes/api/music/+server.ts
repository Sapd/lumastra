// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music — music home sections (SDUI, internal surface).
// Returns { sections } bare object; errors are problem+json incl. 503 DB-down.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/home.js';

export const { GET } = mount(def, { surface: 'internal' });
