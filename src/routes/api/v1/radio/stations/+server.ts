// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/POST /api/v1/radio/stations — radio station admin CRUD (providers:admin)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/radio/stations/index.ts, which delegates to the
// internal admin handlers. Stays hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/radio/stations/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
