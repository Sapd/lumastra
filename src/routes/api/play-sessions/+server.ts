// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/api/play-sessions/+server.ts
import { mount } from '$lib/server/api/mount.js';
import { def as startDef } from '$lib/server/api/defs/play-sessions/index.js';

export const { POST } = mount(startDef, { surface: 'internal' });

import { def as listDef } from '$lib/server/api/defs/play-sessions/list.js';
export const { GET } = mount(listDef, { surface: 'internal' });
