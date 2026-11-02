// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Re-export types for consumers
export type { BrowseItem, GenreRow } from '$lib/server/utils/browse-transforms';

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/browse/index.js';
export const { GET } = mount(def, { surface: 'internal' });
