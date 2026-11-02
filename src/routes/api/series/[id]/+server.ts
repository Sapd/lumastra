// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/series/{id} — canonical series detail (SPA surface).
// Delegates to the shared v1 def; surface:'internal' skips bearer auth and
// uses the session-based principal established by hooks.server.ts.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/series-id.js';

export const { GET } = mount(def, { surface: 'internal' });
