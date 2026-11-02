// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Work refused by shutdown, or interrupted by a kill we issued during cleanup. */
export class ShutdownInterruptedError extends Error {
    readonly status = 503;

    constructor() {
        super('Playback work interrupted by shutdown');
        this.name = 'ShutdownInterruptedError';
    }
}
