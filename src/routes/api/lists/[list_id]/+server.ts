// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/lists/{list_id} — items for a specific curated list (SPA surface).
// Param name is 'list_id' here; the def handles both 'id' and 'list_id'.
// Auto-generated mount — do not add handler logic here.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/lists/[id].js';

export const { GET } = mount(def, { surface: 'internal' });
