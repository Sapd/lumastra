// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// v1 token surface mount: GET /api/v1/users  POST /api/v1/users
// Auth scope: users:admin
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/users/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
