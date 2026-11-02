// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/integrations/upcoming — one user's upcoming episodes, for an
// admin service token bound inside /api/v1/integrations.
//
// Hand-mounted def. Definition + OpenAPI docs live in
// $lib/server/api/defs/integrations/upcoming.ts. Hand-written (not generator-owned) → v1-only,
// like integrations/watch-history: no session-cookie surface has a use for it.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/integrations/upcoming.js';

export const { GET } = mount(def, { surface: 'v1' });
