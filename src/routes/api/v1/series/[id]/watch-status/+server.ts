// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/series/{id}/watch-status — redesigned per-episode watch-status
// collection ({ items, page } of Episode watch-state nodes + summary). Fast
// DB-only lookup. The def resolves the id form itself (internal UUID, composite
// key, or ?externalId=provider:id:type) via the shared mediaIdResolver.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/series/watch-status.js';

export const { GET } = mount(def, { surface: 'v1' });
