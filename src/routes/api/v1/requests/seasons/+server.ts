// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/requests/seasons — list a series' seasons and whether each can be
// requested (token surface). The internal `/api/request/seasons` mount stays for
// the web season picker; both delegate to the same def.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/requests/seasons.js';

export const { POST } = mount(def, { surface: 'v1' });
