// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/lists/{id} — items for a specific curated list.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/lists/[id].js';

export const { GET } = mount(def, { surface: 'v1' });
