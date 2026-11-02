// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/series/{id}/ordering/preview — preview an episode ordering (SPA surface).
// Delegates to the new def; surface:'internal' uses the session-based principal.
import { mount } from '$lib/server/api/mount.js';
import { previewDef } from '$lib/server/api/defs/catalog/series/ordering.js';

export const { GET } = mount(previewDef, { surface: 'internal' });
