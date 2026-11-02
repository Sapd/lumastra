// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/media/{id}/similar — AI-powered similar content (SPA surface).
// Delegates to the new def; surface:'internal' uses the session-based principal.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/media-id-similar.js';

export const { GET } = mount(def, { surface: 'internal' });
