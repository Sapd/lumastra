// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/api/play-sessions/[id]/beacon/+server.ts
// POST-only mirror of PUT — exists solely because sendBeacon cannot send PUT.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/play-sessions/[id]/beacon.js';

export const { POST } = mount(def, { surface: 'internal' });
