// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/keywords — keyword discovery endpoint.
// Collapses: for-you/keywords (?mode=you-like), for-you/explore-keywords (?mode=explore),
//            browse/keywords (?mode=curated)
// Auto-generated mount — do not add handler logic here.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/recommendations/keywords.js';

export const { GET } = mount(def, { surface: 'internal' });
