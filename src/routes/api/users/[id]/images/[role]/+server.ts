// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Internal surface mount: GET /api/users/{id}/images/{role}
//   PUT/DELETE /api/users/{id}/images/avatar
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/users/[id]/images/[role].js';

export const { GET, PUT, DELETE } = mount(def, { surface: 'internal' });
