// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// v1 token surface mount: GET/PATCH/DELETE /api/v1/library-groups/{id}
// Auth scope: library:admin
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/library-groups/[id].js';

export const { GET, PATCH, DELETE } = mount(def, { surface: 'v1' });
