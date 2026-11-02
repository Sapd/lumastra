// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// v1 token surface mount: GET /api/v1/users/{id}/images/{role}
//   PUT/DELETE /api/v1/users/{id}/images/avatar
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/users/[id]/images/[role].js';

export const { GET, PUT, DELETE } = mount(def, { surface: 'v1' });
