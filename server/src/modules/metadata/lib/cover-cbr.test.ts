import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildRar5StoreArchive } from '../../../../test/helpers/rar5-store.fixture';
import { extractCbrCover } from './cover-cbr';

describe('extractCbrCover', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cover-cbr-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeArchive(entries: { name: string; data: Buffer }[], dir = root, file = 'book.cbr'): Promise<string> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, file);
    await writeFile(path, buildRar5StoreArchive(entries));
    return path;
  }

  it('picks naturally-sorted first visible image and extracts only that file', async () => {
    const path = await writeArchive([
      { name: '10.jpg', data: Buffer.from([10, 10]) },
      { name: '2.jpg', data: Buffer.from([7, 7, 7]) },
      { name: '.hidden.jpg', data: Buffer.from([1]) },
    ]);

    await expect(extractCbrCover(path)).resolves.toEqual(Buffer.from([7, 7, 7]));
  });

  it('returns null when archive has no visible image files', async () => {
    const path = await writeArchive([{ name: 'notes.txt', data: Buffer.from('hi') }]);

    await expect(extractCbrCover(path)).resolves.toBeNull();
  });

  it('returns null for a corrupt file', async () => {
    const path = join(root, 'corrupt.cbr');
    await writeFile(path, Buffer.from('not a rar archive at all'));

    await expect(extractCbrCover(path)).resolves.toBeNull();
  });

  it('returns null for a missing file', async () => {
    await expect(extractCbrCover(join(root, 'missing.cbr'))).resolves.toBeNull();
  });

  it('reads from a path with spaces and unicode', async () => {
    const path = await writeArchive([{ name: '1.jpg', data: Buffer.from([4, 2]) }], join(root, 'Série Ünï'), 'Tome 01 - été.cbr');

    await expect(extractCbrCover(path)).resolves.toEqual(Buffer.from([4, 2]));
  });
});
