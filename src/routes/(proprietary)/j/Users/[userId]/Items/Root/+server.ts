// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Legacy `GET /Users/{userId}/Items/Root` (GetRootFolderLegacy): same answer;
// the user comes from the session, never from the path.
export { GET } from '../../../../Items/Root/+server';
