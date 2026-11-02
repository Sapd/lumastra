// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Shared by setup/Retry and scheduled per-library runs; only in-flight runs dedupe. */
export function libraryIngestKey(taskId: string, libraryPathId: string): string {
    return `library-ingest:${taskId}:${libraryPathId}`;
}
