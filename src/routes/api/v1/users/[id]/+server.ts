// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// v1 token surface mount: GET /api/v1/users/{id}  PATCH /api/v1/users/{id}
// Auth scope: users:admin
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/users/[id].js';

export const { GET, PATCH } = mount(def, { surface: 'v1' });
