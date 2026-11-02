// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Reroute } from '@sveltejs/kit';
import { reroutePathname } from '$lib/routing/reroute-pathname.js';

export const reroute: Reroute = ({ url }) => reroutePathname(url);
