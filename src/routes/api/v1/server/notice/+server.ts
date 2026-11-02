// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/server/notice
//
// Read path for the in-effect maintenance notice — the state behind the
// `event: admin` / `maintenance_notice` frame on GET /api/v1/events.
//
// Definition: $lib/server/api/defs/server/notice/index.ts

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/server/notice/index.js';

export const { GET } = mount(def, { surface: 'v1' });
