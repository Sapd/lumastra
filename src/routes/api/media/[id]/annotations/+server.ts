// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET  /api/media/{id}/annotations — list annotations for a media item (SPA surface).
// POST /api/media/{id}/annotations — create annotation (SPA surface).
// Delegates to the new def; surface:'internal' uses the session-based principal.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/media-id-annotations.js';

export const { GET, POST } = mount(def, { surface: 'internal' });
