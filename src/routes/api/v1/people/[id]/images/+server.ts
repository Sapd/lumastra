// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// v1 token surface mount: GET /api/v1/people/{id}/images
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/people/[id]/images/index.js';

export const { GET } = mount(def, { surface: 'v1' });
