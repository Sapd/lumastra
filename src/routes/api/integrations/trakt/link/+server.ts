// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { traktLinkDef } from '$lib/server/api/defs/integrations/trakt/link.js';

export const { DELETE } = mount(traktLinkDef, { surface: 'internal' });
