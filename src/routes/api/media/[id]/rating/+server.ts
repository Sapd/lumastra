// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/media/{id}/rating — user rating for a media item (SPA surface).
// GET/PUT/DELETE /api/media/{id}/rating — read, set/update, clear user rating (SPA surface).
// Delegates to the shared v1 def; surface:'internal' uses the session-based principal.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/media-id-rating.js';

export const { GET, PUT, DELETE } = mount(def, { surface: 'internal' });
