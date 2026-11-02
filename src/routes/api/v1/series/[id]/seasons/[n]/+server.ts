// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/series/{id}/seasons/{n} — single Season node by season number.
// Shares the season-collection def (which branches on the `n` route param and
// returns the matching Season node, or 404). The def resolves the id form itself
// (internal UUID, composite key, or ?externalId=provider:id:type) via the shared
// mediaIdResolver.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/series/seasons.js';

export const { GET } = mount(def, { surface: 'v1' });
