// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/PUT/DELETE /api/series/{id}/ordering — episode ordering management (SPA surface).
// Delegates to the new def; surface:'internal' uses the session-based principal.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/series/ordering.js';

export const { GET, PUT, DELETE } = mount(def, { surface: 'internal' });
