// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// withJellyfinAuth also checks the legacy path userId. DatePlayed is optional;
// as on the current route, watch-event time is assigned by the server.
export { POST, DELETE } from '../../../../UserPlayedItems/[itemId]/+server';
