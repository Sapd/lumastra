// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it } from 'vitest';
import { getContractDigest } from '../contract/digest';
import { validateAgainstSchema } from '../contract/validate';
import {
    capabilitiesFromDto,
    filterGeneralCommands,
    filterMediaTypes,
    generalCommandFromBody,
    generalCommandItemIds,
    messageCommandFromBody,
    outboundMessage,
    parseBaseItemKind,
    parseBool,
    parseGeneralCommandType,
    parseInboundMessage,
    parseItemIds,
    parseOptionalInt,
    parsePlayCommand,
    parsePlaystateCommand,
    parseSessionsStartInterval,
    toDashedGuid,
} from './protocol';

const CTRL = '0123456789abcdef0123456789abcdef';

function sdkErrors(schema: string, body: unknown): string[] {
    return validateAgainstSchema(getContractDigest(), schema, body, {
        clientName: 'Jellyfin Android TV',
    })
        .filter((v) => v.severity === 'error')
        .map((v) => `${v.pointer} ${v.property} ${v.kind}`);
}

describe('enum parsing (ASP.NET binds enums case-insensitively)', () => {
    it('canonicalizes known values and rejects unknown ones', () => {
        expect(parsePlaystateCommand('pause')).toBe('Pause');
        expect(parsePlaystateCommand('PLAYPAUSE')).toBe('PlayPause');
        expect(parsePlaystateCommand('Explode')).toBeNull();
        expect(parsePlaystateCommand(undefined)).toBeNull();
        expect(parsePlayCommand('playnext')).toBe('PlayNext');
        expect(parsePlayCommand('')).toBeNull();
        expect(parseGeneralCommandType('displaymessage')).toBe('DisplayMessage');
        expect(parseGeneralCommandType('RebootServer')).toBeNull();
        expect(parseBaseItemKind('movie')).toBe('Movie');
        expect(parseBaseItemKind('Spaceship')).toBeNull();
    });

    it('filters capability lists to SDK-decodable values', () => {
        expect(filterMediaTypes(['Video,Audio', 'audio', 'Hologram'])).toEqual(['Video', 'Audio']);
        expect(filterGeneralCommands('Play,PlayState,Teleport,SetVolume')).toEqual([
            'Play',
            'PlayState',
            'SetVolume',
        ]);
        expect(filterGeneralCommands(undefined)).toEqual([]);
    });

    it('reads a ClientCapabilitiesDto body', () => {
        expect(
            capabilitiesFromDto({
                PlayableMediaTypes: ['Video', 'Nope'],
                SupportedCommands: ['DisplayMessage', 'Nope'],
                SupportsMediaControl: true,
                DeviceProfile: { Name: 'x' },
            }),
        ).toEqual({
            playableMediaTypes: ['Video'],
            supportedCommands: ['DisplayMessage'],
            supportsMediaControl: true,
        });
        expect(capabilitiesFromDto(null).supportsMediaControl).toBe(false);
        // A string "true" is not a JSON boolean.
        expect(capabilitiesFromDto({ SupportsMediaControl: 'true' }).supportsMediaControl).toBe(
            false,
        );
    });

    it('parses booleans and integers like the model binder', () => {
        expect(parseBool('True', false)).toBe(true);
        expect(parseBool('0', true)).toBe(false);
        expect(parseBool(null, true)).toBe(true);
        expect(parseBool('maybe', false)).toBe(false);
        expect(parseOptionalInt(null)).toBeUndefined();
        expect(parseOptionalInt('42')).toBe(42);
        expect(parseOptionalInt('-1')).toBe(-1);
        expect(parseOptionalInt('4.5')).toBeNull();
        expect(parseOptionalInt('abc')).toBeNull();
        expect(parseOptionalInt('99999999999999999999')).toBeNull();
    });
});

describe('parseItemIds', () => {
    it('accepts dashed and 32-hex ids, comma-delimited or repeated', () => {
        expect(
            parseItemIds([
                '11111111-2222-3333-4444-555555555555,AAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE',
                'ffffffffffffffffffffffffffffffff',
            ]),
        ).toEqual([
            '11111111222233334444555555555555',
            'aaaaaaaabbbbccccddddeeeeeeeeeeee',
            'ffffffffffffffffffffffffffffffff',
        ]);
    });

    it('rejects the whole list when one id is not a Guid', () => {
        expect(parseItemIds(['11111111222233334444555555555555,not-a-guid'])).toBeNull();
    });

    it('rejects more than 500 ids', () => {
        const ids = (n: number): string[] =>
            Array.from({ length: n }, (_, i) => i.toString(16).padStart(32, '0'));
        expect(parseItemIds(ids(500))).toHaveLength(500);
        expect(parseItemIds([ids(501).join(',')])).toBeNull();
    });

    it('converts to the dashed storage form', () => {
        expect(toDashedGuid('11111111222233334444555555555555')).toBe(
            '11111111-2222-3333-4444-555555555555',
        );
    });
});

describe('GeneralCommand / MessageCommand bodies', () => {
    it('forces ControllingUserId and stringifies argument scalars', () => {
        const cmd = generalCommandFromBody(
            {
                Name: 'setvolume',
                ControllingUserId: 'attacker',
                Arguments: { Volume: 40, Muted: false, Drop: null, Nested: { a: 1 } },
            },
            CTRL,
        );
        expect(cmd).toEqual({
            Name: 'SetVolume',
            ControllingUserId: CTRL,
            Arguments: { Volume: '40', Muted: 'false' },
        });
    });

    it('rejects a missing or unknown Name', () => {
        expect(generalCommandFromBody({ Arguments: {} }, CTRL)).toBeNull();
        expect(generalCommandFromBody({ Name: 'FormatDisk' }, CTRL)).toBeNull();
        expect(generalCommandFromBody('GoHome', CTRL)).toBeNull();
    });

    it('reads ItemId/ItemIds only from item-carrying GeneralCommands', () => {
        const id = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
        const cmd = (Name: string, Arguments: Record<string, string>) =>
            generalCommandFromBody({ Name, Arguments }, CTRL)!;
        expect(generalCommandItemIds(cmd('DisplayContent', { ItemId: id }))).toEqual([id]);
        expect(generalCommandItemIds(cmd('PlayNext', { itemIds: `${id},${id}` }))).toEqual([
            id,
            id,
        ]);
        expect(generalCommandItemIds(cmd('SendString', { ItemId: id }))).toEqual([]);
        expect(generalCommandItemIds(cmd('DisplayContent', { ItemId: 'x' }))).toBeNull();
    });

    it('bounds ItemId/ItemIds by 500 ids, not by the 4 KB value cap', () => {
        const ids = (n: number): string =>
            Array.from(
                { length: n },
                (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
            ).join(',');
        const q400 = generalCommandFromBody(
            { Name: 'SetShuffleQueue', Arguments: { ItemIds: ids(400) } },
            CTRL,
        );
        expect(q400).not.toBeNull();
        expect(generalCommandItemIds(q400!)).toHaveLength(400);
        expect(
            generalCommandFromBody({ Name: 'PlayNext', Arguments: { itemids: ids(500) } }, CTRL),
        ).not.toBeNull();
        expect(
            generalCommandFromBody(
                { Name: 'SetShuffleQueue', Arguments: { ItemIds: ids(501) } },
                CTRL,
            ),
        ).toBeNull();
        // Padding cannot slip a huge value through the id key.
        expect(
            generalCommandFromBody(
                { Name: 'Play', Arguments: { ItemId: ' '.repeat(40_000) } },
                CTRL,
            ),
        ).toBeNull();
    });

    it('caps GeneralCommand Arguments at 32 entries of 4 KB each', () => {
        const args = (n: number): Record<string, string> =>
            Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
        expect(
            generalCommandFromBody({ Name: 'GoHome', Arguments: args(32) }, CTRL),
        ).not.toBeNull();
        expect(generalCommandFromBody({ Name: 'GoHome', Arguments: args(33) }, CTRL)).toBeNull();
        expect(
            generalCommandFromBody(
                { Name: 'SendString', Arguments: { String: 'x'.repeat(4096) } },
                CTRL,
            ),
        ).not.toBeNull();
        expect(
            generalCommandFromBody(
                { Name: 'SendString', Arguments: { String: 'x'.repeat(4097) } },
                CTRL,
            ),
        ).toBeNull();
        // Multi-byte characters count in UTF-8 bytes.
        expect(
            generalCommandFromBody(
                { Name: 'SendString', Arguments: { String: 'é'.repeat(2049) } },
                CTRL,
            ),
        ).toBeNull();
    });

    it('turns a MessageCommand into DisplayMessage with Jellyfin’s default header', () => {
        expect(messageCommandFromBody({ Text: 'Dinner!', TimeoutMs: 5000 }, CTRL)).toEqual({
            Name: 'DisplayMessage',
            ControllingUserId: CTRL,
            Arguments: { Header: 'Message from Server', Text: 'Dinner!', TimeoutMs: '5000' },
        });
        expect(messageCommandFromBody({ Header: 'Hi', Text: 'x' }, CTRL)?.Arguments.Header).toBe(
            'Hi',
        );
        expect(messageCommandFromBody({ Text: '' }, CTRL)).toBeNull();
        expect(messageCommandFromBody({ Text: 'x'.repeat(4096) }, CTRL)).not.toBeNull();
        expect(messageCommandFromBody({ Text: 'x'.repeat(4097) }, CTRL)).toBeNull();
        expect(messageCommandFromBody({ Text: 'x', Header: 'h'.repeat(4097) }, CTRL)).toBeNull();
        expect(messageCommandFromBody({}, CTRL)).toBeNull();
    });
});

describe('outbound messages satisfy the jellyfin-sdk-kotlin contract', () => {
    it('Play', () => {
        const msg = outboundMessage('Play', {
            ItemIds: ['11111111222233334444555555555555'],
            StartPositionTicks: 0,
            PlayCommand: 'PlayNow',
            ControllingUserId: CTRL,
            SubtitleStreamIndex: null,
            AudioStreamIndex: null,
            MediaSourceId: null,
            StartIndex: null,
        });
        expect(msg.MessageId).toMatch(/^[0-9a-f]{32}$/);
        expect(sdkErrors('PlayMessage', msg)).toEqual([]);
    });

    it('Playstate', () => {
        const msg = outboundMessage('Playstate', {
            Command: 'Seek',
            SeekPositionTicks: 600_000_000,
            ControllingUserId: CTRL,
        });
        expect(sdkErrors('PlaystateMessage', msg)).toEqual([]);
    });

    it('GeneralCommand', () => {
        const msg = outboundMessage('GeneralCommand', {
            Name: 'DisplayMessage',
            ControllingUserId: CTRL,
            Arguments: { Header: 'h', Text: 't' },
        });
        expect(sdkErrors('GeneralCommandMessage', msg)).toEqual([]);
    });

    it('ForceKeepAlive and KeepAlive', () => {
        expect(sdkErrors('ForceKeepAliveMessage', outboundMessage('ForceKeepAlive', 60))).toEqual(
            [],
        );
        expect(sdkErrors('OutboundKeepAliveMessage', outboundMessage('KeepAlive'))).toEqual([]);
    });

    it('the validator does catch a missing required field', () => {
        const bad = { MessageType: 'Playstate', MessageId: CTRL, Data: {} };
        expect(sdkErrors('PlaystateMessage', bad).length).toBeGreaterThan(0);
    });
});

describe('inbound messages', () => {
    it('parses MessageType/Data and ignores junk', () => {
        expect(parseInboundMessage('{"MessageType":"KeepAlive"}')).toEqual({
            type: 'KeepAlive',
            data: undefined,
        });
        expect(parseInboundMessage('{"MessageType":"SessionsStart","Data":"0,1500"}')).toEqual({
            type: 'SessionsStart',
            data: '0,1500',
        });
        expect(parseInboundMessage('not json')).toBeNull();
        expect(parseInboundMessage('[1,2]')).toBeNull();
        expect(parseInboundMessage('{"Data":1}')).toBeNull();
    });

    it('clamps the SessionsStart interval', () => {
        expect(parseSessionsStartInterval('0,1500', 2000, 10000)).toBe(2000);
        expect(parseSessionsStartInterval('0,5000', 2000, 10000)).toBe(5000);
        expect(parseSessionsStartInterval(undefined, 2000, 10000)).toBe(10000);
        expect(parseSessionsStartInterval('x,y', 2000, 10000)).toBe(10000);
    });

    it('clamps a huge SessionsStart interval to 60 s (setInterval treats > 2^31-1 as 1 ms)', () => {
        expect(parseSessionsStartInterval('0,9999999999', 2000, 10000)).toBe(60000);
        expect(parseSessionsStartInterval('0,1e308', 2000, 10000)).toBe(60000);
        expect(parseSessionsStartInterval('0,Infinity', 2000, 10000)).toBe(10000);
    });
});
