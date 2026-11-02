// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/series/{id}/ordering/sync — sync episode orderings from provider (SPA, admin).
// Delegates to the new def; surface:'internal' uses the session-based principal.
import { mount } from '$lib/server/api/mount.js';
import { syncDef } from '$lib/server/api/defs/catalog/series/ordering.js';

export const { POST } = mount(syncDef, { surface: 'internal' });
