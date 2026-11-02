// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Minimal fMP4 box builders for tests: just enough structure (moov/trak/mdia/mdhd
// in an init, moof/traf/tfdt/trun + mdat in a fragment) for timing parsers.
// No media payload.

export function box(type: string, ...payload: Buffer[]): Buffer {
    const body = Buffer.concat(payload);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + body.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, body]);
}

function fullBoxHeader(version: number, flags: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt8(version, 0);
    b.writeUIntBE(flags, 1, 3);
    return b;
}

/** Init segment with one track whose mdhd carries `timescale`. */
export function buildInit(timescale: number, mdhdVersion: 0 | 1 = 0): Buffer {
    const mdhdBody =
        mdhdVersion === 0
            ? (() => {
                  const b = Buffer.alloc(20);
                  b.writeUInt32BE(timescale, 8); // creation(4) modification(4) timescale
                  return b;
              })()
            : (() => {
                  const b = Buffer.alloc(32);
                  b.writeUInt32BE(timescale, 16); // creation(8) modification(8) timescale
                  return b;
              })();
    const mdhd = box('mdhd', fullBoxHeader(mdhdVersion, 0), mdhdBody);
    return Buffer.concat([
        box('ftyp', Buffer.from('iso6', 'latin1'), Buffer.alloc(4)),
        box(
            'moov',
            box('mvhd', fullBoxHeader(0, 0), Buffer.alloc(96)),
            box('trak', box('mdia', mdhd)),
        ),
    ]);
}

/**
 * One fragment: tfdt = `decodeTime` (in timescale units), first trun sample
 * composition offset `firstCto` (omit for no CTS flag), plus a small mdat.
 */
export function buildFragment(opts: {
    decodeTime: number;
    firstCto?: number;
    tfdtVersion?: 0 | 1;
    trunVersion?: 0 | 1;
    sequence?: number;
    payload?: Buffer;
    /** Bytes of a `free` box inside traf, before tfdt (a long GOP's large moof). */
    trafPadding?: number;
}): Buffer {
    const tfdtVersion = opts.tfdtVersion ?? 1;
    const tfdtBody = Buffer.alloc(tfdtVersion === 1 ? 8 : 4);
    // A negative decode time is written the way FFmpeg writes it: two's complement.
    if (tfdtVersion === 1) tfdtBody.writeBigUInt64BE(BigInt.asUintN(64, BigInt(opts.decodeTime)));
    else tfdtBody.writeUInt32BE(opts.decodeTime);
    const tfdt = box('tfdt', fullBoxHeader(tfdtVersion, 0), tfdtBody);

    // trun: data-offset (0x1) + sample-duration (0x100) + sample-size (0x200)
    // [+ sample-composition-time-offset (0x800)].
    const withCto = opts.firstCto !== undefined;
    const flags = 0x1 | 0x100 | 0x200 | (withCto ? 0x800 : 0);
    const perSample = withCto ? 12 : 8;
    const trunBody = Buffer.alloc(4 + 4 + perSample);
    trunBody.writeUInt32BE(1, 0); // sample_count
    trunBody.writeInt32BE(0, 4); // data_offset
    trunBody.writeUInt32BE(1000, 8); // duration
    trunBody.writeUInt32BE(4, 12); // size
    if (withCto) trunBody.writeInt32BE(opts.firstCto!, 16);
    const trun = box('trun', fullBoxHeader(opts.trunVersion ?? 1, flags), trunBody);

    const mfhdBody = Buffer.alloc(4);
    mfhdBody.writeUInt32BE(opts.sequence ?? 1);
    const moof = box(
        'moof',
        box('mfhd', fullBoxHeader(0, 0), mfhdBody),
        box(
            'traf',
            box('tfhd', fullBoxHeader(0, 0x020000), Buffer.alloc(4)),
            ...(opts.trafPadding ? [box('free', Buffer.alloc(opts.trafPadding))] : []),
            tfdt,
            trun,
        ),
    );
    return Buffer.concat([moof, box('mdat', opts.payload ?? Buffer.from([1, 2, 3, 4]))]);
}
