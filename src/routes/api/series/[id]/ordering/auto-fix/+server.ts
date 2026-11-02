// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/series/{id}/ordering/auto-fix — detect + resolve a TVDB-vs-TMDB
// season-structure mismatch via episode groups (SPA, admin).
import { mount } from '$lib/server/api/mount.js';
import { autoFixDef } from '$lib/server/api/defs/catalog/series/ordering.js';

export const { POST } = mount(autoFixDef, { surface: 'internal' });
