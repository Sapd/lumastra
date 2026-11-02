// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/music/text-search?q=<query>
 *
 * Text-to-Sound semantic search — internal BFF surface.
 * The contract-level implementation lives in the def; this file is a thin mount.
 *
 * Response: { items, page } via paginate() + problem+json errors incl. 503 on
 * dependency-down.  Gating: feature 'textToSound' must be on, then any authed user.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/text-search.js';

export const { GET } = mount(def, { surface: 'internal' });
