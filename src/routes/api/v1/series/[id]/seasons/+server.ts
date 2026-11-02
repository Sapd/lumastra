// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/series/{id}/seasons — redesigned season-collection traversal
// ({ items, page } of canonical Season nodes). The def resolves the id form
// itself (internal UUID, composite key, or ?externalId=provider:id:type) via the
// shared mediaIdResolver, so the route stays a thin mount() with problem+json
// errors end-to-end.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/series/seasons.js';

export const { GET } = mount(def, { surface: 'v1' });
