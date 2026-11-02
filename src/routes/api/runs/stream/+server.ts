// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Internal forward-auth/cookie facade for the shared `runs/stream` SSE def.
// Additive B1 facade — the same def also backs /api/v1/runs/stream (token surface).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/runs/stream.js';

export const { GET } = mount(def, { surface: 'internal' });
