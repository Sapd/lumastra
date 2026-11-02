// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// v1 token surface mount: GET /api/v1/service-tokens/{id}  DELETE /api/v1/service-tokens/{id}
// Auth scope: tokens:admin
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/service-tokens/[id].js';

export const { GET, DELETE } = mount(def, { surface: 'v1' });
