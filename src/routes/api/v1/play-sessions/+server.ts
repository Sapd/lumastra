// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/play-sessions — public/native (Bearer token) surface. Mounts the
// SAME shared def as the internal /api/play-sessions route. OpenAPI docs live in
// the def's `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def as startDef } from '$lib/server/api/defs/play-sessions/index.js';

export const { POST } = mount(startDef, { surface: 'v1' });

import { def as listDef } from '$lib/server/api/defs/play-sessions/list.js';
export const { GET } = mount(listDef, { surface: 'v1' });
