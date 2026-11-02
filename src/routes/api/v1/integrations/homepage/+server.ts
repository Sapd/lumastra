// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/integrations/homepage — server summary for gethomepage.dev (admin only)
//
// Hand-mounted def. Definition + OpenAPI docs live in
// $lib/server/api/defs/integrations/homepage.ts. Hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/integrations/homepage.js';

export const { GET } = mount(def, { surface: 'v1' });
