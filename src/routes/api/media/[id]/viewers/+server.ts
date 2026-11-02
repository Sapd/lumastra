// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/media/{id}/viewers — who watched this item, social feature (SPA surface).
// Delegates to the new def; surface:'internal' uses the session-based principal.
// Feature-flagged on FEATURE_SOCIAL within the def handler.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/media-id-viewers.js';

export const { GET } = mount(def, { surface: 'internal' });
