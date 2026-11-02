// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/PATCH/PUT /api/v1/providers — metadata provider configuration (providers:admin)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/providers.ts, which delegates to the internal admin
// handlers. Stays hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/providers.js';

export const { GET, PATCH, PUT } = mount(def, { surface: 'v1' });
