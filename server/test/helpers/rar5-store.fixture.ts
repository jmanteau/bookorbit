import { crc32 } from 'zlib';

/**
 * Builds a real RAR5 archive with stored (uncompressed) entries, so tests can exercise the actual
 * unrar decoder without a proprietary `rar` binary or a checked-in fixture.
 */
export function buildRar5StoreArchive(entries: { name: string; data: Buffer }[]): Buffer {
  const signature = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
  const mainHeader = block(Buffer.concat([vint(1), vint(0), vint(0)]));
  const fileBlocks = entries.flatMap(({ name, data }) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const dataCrc = Buffer.alloc(4);
    dataCrc.writeUInt32LE(crc32(data));
    const header = Buffer.concat([
      vint(2), // file header
      vint(0x0002), // data area present
      vint(data.length),
      vint(0x0004), // data CRC32 present
      vint(data.length),
      vint(0o644),
      dataCrc,
      vint(0), // RAR5 algorithm, not solid, method 0 (store)
      vint(1), // host OS: Unix
      vint(nameBytes.length),
      nameBytes,
    ]);
    return [block(header), data];
  });
  const endHeader = block(Buffer.concat([vint(5), vint(0), vint(0)]));
  return Buffer.concat([signature, mainHeader, ...fileBlocks, endHeader]);
}

function block(body: Buffer): Buffer {
  const sized = Buffer.concat([vint(body.length), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(sized));
  return Buffer.concat([crc, sized]);
}

function vint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}
