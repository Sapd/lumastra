// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Legacy `GET /Users/{userId}/Items/Root` (GetRootFolderLegacy): same answer;
// the user comes from the session, never from the path.
export { GET } from '../../../../Items/Root/+server';
