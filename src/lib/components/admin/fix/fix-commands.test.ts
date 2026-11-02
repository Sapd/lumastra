// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * These strings are meant to be pasted into a root shell, so the properties
 * worth pinning are the ones that would be dangerous or useless if they drifted:
 * a path with a space must survive quoting, an unknown uid must suppress the
 * command entirely rather than emit a guess, and `chmod` must use the capital
 * `X` that spares regular files the execute bit.
 */

import { describe, it, expect } from 'vitest';
import {
    quotePath,
    buildChownCommand,
    buildChmodCommand,
    buildComposeUserFragment,
    buildInspectCommand,
    formatMode,
} from './fix-commands.js';

const base = {
    processUid: 1000,
    processGid: 1000,
    ownerUid: 1001,
    ownerGid: 1002,
    path: '/srv/media/movies',
};

describe('quotePath', () => {
    it('leaves an ordinary path unquoted', () => {
        expect(quotePath('/srv/media/movies')).toBe('/srv/media/movies');
    });

    it('quotes a path containing a space', () => {
        expect(quotePath('/srv/My Media/movies')).toBe("'/srv/My Media/movies'");
    });

    it('escapes an embedded single quote without breaking out of the quoting', () => {
        // A naive implementation emits '/srv/den's' — which the shell reads as
        // two words and a dangling quote.
        expect(quotePath("/srv/den's")).toBe("'/srv/den'\\''s'");
    });
});

describe('buildChownCommand', () => {
    it('uses the real process uid and gid', () => {
        expect(buildChownCommand(base)).toBe('sudo chown -R -- 1000:1000 /srv/media/movies');
    });

    it('returns null when the process uid is unknown rather than guessing', () => {
        expect(buildChownCommand({ ...base, processUid: null })).toBeNull();
        expect(buildChownCommand({ ...base, processGid: null })).toBeNull();
    });

    it('quotes a path with a space', () => {
        expect(buildChownCommand({ ...base, path: '/srv/My Media' })).toBe(
            "sudo chown -R -- 1000:1000 '/srv/My Media'",
        );
    });
});

describe('buildChmodCommand', () => {
    it('uses a capital X so only directories gain the traverse bit', () => {
        const cmd = buildChmodCommand(base);
        expect(cmd).toBe('sudo chmod -R -- a+rX /srv/media/movies');
        expect(cmd).not.toContain('a+rx');
    });
});

describe('buildComposeUserFragment', () => {
    it("uses the FOLDER's owner, not the process uid", () => {
        expect(buildComposeUserFragment(base)).toContain('user: "1001:1002"');
    });

    it('returns null when the folder could not be stat-ed', () => {
        expect(buildComposeUserFragment({ ...base, ownerUid: null })).toBeNull();
    });

    it('emits a valid compose fragment shape', () => {
        expect(buildComposeUserFragment(base, 'lumastra')).toBe(
            'services:\n    lumastra:\n        user: "1001:1002"',
        );
    });
});

describe('buildInspectCommand', () => {
    it('lists the directory itself, not its contents', () => {
        expect(buildInspectCommand('/srv/media')).toBe('ls -ld -- /srv/media');
    });
});

describe('formatMode', () => {
    it('renders stat mode bits as 4-digit octal', () => {
        // 0o40755 — a directory with rwxr-xr-x. The file-type bits must be gone.
        expect(formatMode(0o40755)).toBe('0755');
        expect(formatMode(0o40700)).toBe('0700');
    });

    it('pads a mode with no leading digit', () => {
        expect(formatMode(0o40044)).toBe('0044');
    });
});

describe('paths that look like options', () => {
    it('a leading dash cannot become a flag', () => {
        expect(buildInspectCommand('-rf')).toBe('ls -ld -- -rf');
        expect(buildChmodCommand({ ...base, path: '-x' })).toBe('sudo chmod -R -- a+rX -x');
    });
});
