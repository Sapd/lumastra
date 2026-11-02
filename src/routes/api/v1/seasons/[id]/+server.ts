// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/seasons/{id} — flat season deep-link (§7.3).
// The def resolves the id form itself (internal UUID, composite key, or
// ?externalId=provider:id:type) via the shared mediaIdResolver.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/series/seasons.js';

export const { GET } = mount(def, { surface: 'v1' });
