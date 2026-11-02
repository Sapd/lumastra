// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// v1 token surface mount: GET /api/v1/library-paths  POST /api/v1/library-paths
// Auth scope: library:admin
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/library-paths/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
