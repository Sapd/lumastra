// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// SPA surface mount: GET /api/admin/service-tokens/:id  DELETE /api/admin/service-tokens/:id
// Auth: admin session (internal surface); scopes enforced by def (tokens:admin).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/service-tokens/[id].js';

export const { GET, DELETE } = mount(def, { surface: 'internal' });
