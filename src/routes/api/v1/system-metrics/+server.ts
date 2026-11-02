// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/system-metrics — system observability (metrics:read)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/system-metrics.ts, which delegates to the internal
// admin read handler. Stays hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/system-metrics.js';

export const { GET } = mount(def, { surface: 'v1' });
