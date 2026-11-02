// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { jellyfinImportWatchlistDef } from '$lib/server/api/defs/integrations/jellyfin/import-watchlist.js';

export const { POST } = mount(jellyfinImportWatchlistDef, { surface: 'internal' });
