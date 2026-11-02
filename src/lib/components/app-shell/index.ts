// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import SidebarChrome from './SidebarChrome.svelte';
import GlobalChrome from './GlobalChrome.svelte';
import AppInstallHint from '../AppInstallHint.svelte';
import MusicBottomNav from '../music/MusicBottomNav.svelte';
import { registerEagerAppChrome } from './available';

// Catalog layouts import this entry statically. Cold watch imports it only
// after its first frame or an explicit request for chrome.
registerEagerAppChrome(
    Object.freeze({ SidebarChrome, GlobalChrome, AppInstallHint, MusicBottomNav }),
);

export { SidebarChrome, GlobalChrome, AppInstallHint, MusicBottomNav };
