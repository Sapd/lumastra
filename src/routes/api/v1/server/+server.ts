// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/server/index.js';
export const { GET } = mount(def, { surface: 'v1' });
// SvelteKit serves HEAD through GET and strips the response body.
