// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Mounts the SAME shared def as the internal route, on the v1 surface. It used to
// re-export the internal handlers, so this endpoint ran with ctx.surface ===
// 'internal' and emitted /api/... URLs from an /api/v1 path.
//
// GET only — DELETE (end session) is deliberately not exposed on the public API.
// The internal route still mounts { GET, DELETE }; the sole in-repo DELETE
// caller uses the internal path (src/lib/api/watch-together.ts:83).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-together/[code]/index.js';

export const { GET } = mount(def, { surface: 'v1' });
