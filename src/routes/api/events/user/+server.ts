// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/api/events/user/+server.ts
//
// DEPRECATED: The canonical per-user SSE channel is now GET /api/v1/events.
//
// This shim remains so that browser clients built before the v1 migration
// continue to work. It re-uses the same def as /api/v1/events, so both
// paths serve identical responses with shared Valkey replay state.
//
// Definition: $lib/server/api/defs/events/index.ts

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/events/index.js';

// Export GET only — this path never had other methods.
export const { GET } = mount(def, { surface: 'v1' });
