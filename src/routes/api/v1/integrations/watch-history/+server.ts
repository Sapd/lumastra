// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/integrations/watch-history — one user's watch history for recommenders
// (admin integration service token only)
//
// Hand-mounted def. Definition + OpenAPI docs live in
// $lib/server/api/defs/integrations/watch-history.ts. Hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/integrations/watch-history.js';

export const { GET } = mount(def, { surface: 'v1' });
