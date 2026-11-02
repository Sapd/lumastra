// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/media/{id}/context — composite detail-panel aggregate (SPA surface).
// Fans out to internal route handlers for each section concurrently.
// Delegates to the new def; surface:'internal' uses the session-based principal.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/media-id-context.js';

export const { GET } = mount(def, { surface: 'internal' });
