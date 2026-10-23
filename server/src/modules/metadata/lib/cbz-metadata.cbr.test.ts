import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildRar5StoreArchive } from '../../../../test/helpers/rar5-store.fixture';
import { extractCbrMetadata } from './cbz-metadata';

describe('extractCbrMetadata', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cbz-metadata-cbr-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeArchive(entries: { name: string; data: Buffer }[]): Promise<string> {
    const path = join(root, 'book.cbr');
    await writeFile(path, buildRar5StoreArchive(entries));
    return path;
  }

  it('parses the embedded ComicInfo.xml', async () => {
    const xml = '<?xml version="1.0"?><ComicInfo><Series>Saga</Series><Number>3</Number><Title>Chapter Three</Title></ComicInfo>';
    const path = await writeArchive([
      { name: '1.jpg', data: Buffer.from([1]) },
      { name: 'comicinfo.XML', data: Buffer.from(xml) },
    ]);

    const result = await extractCbrMetadata(path);

    expect(result?.seriesName).toBe('Saga');
    expect(result?.seriesIndex).toBe('3');
    expect(result?.title).toBe('Chapter Three');
  });

  it('returns null when the archive has no ComicInfo.xml', async () => {
    const path = await writeArchive([{ name: '1.jpg', data: Buffer.from([1]) }]);

    await expect(extractCbrMetadata(path)).resolves.toBeNull();
  });

  it('returns null for a corrupt file', async () => {
    const path = join(root, 'corrupt.cbr');
    await writeFile(path, Buffer.from('not a rar archive at all'));

    await expect(extractCbrMetadata(path)).resolves.toBeNull();
  });
});
