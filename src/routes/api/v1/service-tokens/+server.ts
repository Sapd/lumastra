// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// v1 token surface mount: GET /api/v1/service-tokens  POST /api/v1/service-tokens
// Auth scope: tokens:admin
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/service-tokens/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
