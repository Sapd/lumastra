// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/series/{id}/watch-marker — the caller's series watch marker
// (episode + position + forward-only relation to ?from). The def resolves the
// id form itself (internal UUID, composite key, or ?externalId=provider:id:type).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/series/watch-marker.js';

export const { GET } = mount(def, { surface: 'v1' });
