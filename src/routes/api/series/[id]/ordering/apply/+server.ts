// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/series/{id}/ordering/apply — apply episode ordering to episodes (SPA, admin).
// Delegates to the new def; surface:'internal' uses the session-based principal.
import { mount } from '$lib/server/api/mount.js';
import { applyDef } from '$lib/server/api/defs/catalog/series/ordering.js';

export const { POST } = mount(applyDef, { surface: 'internal' });
