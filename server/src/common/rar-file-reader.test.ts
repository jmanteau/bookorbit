import { mkdtemp, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { buildRar5StoreArchive } from '../../test/helpers/rar5-store.fixture';
import { extractRarEntry, isUnrarError, listRarEntries } from './rar-file-reader';

async function leftoverTempDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('bookorbit-rar-')).sort();
}

describe('rar-file-reader', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rar-reader-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeArchive(entries: { name: string; data: Buffer }[]): Promise<string> {
    const path = join(root, 'book.cbr');
    await writeFile(path, buildRar5StoreArchive(entries));
    return path;
  }

  describe('listRarEntries', () => {
    it('lists the entries the filter accepts and skips directories', async () => {
      const path = await writeArchive([
        { name: 'ch1', data: Buffer.alloc(0) },
        { name: 'ch1/1.jpg', data: Buffer.from([1]) },
        { name: 'notes.txt', data: Buffer.from('hi') },
        { name: '2.jpg', data: Buffer.from([2]) },
      ]);

      await expect(listRarEntries(path, (h) => h.name.endsWith('.jpg'))).resolves.toEqual(['ch1/1.jpg', '2.jpg']);
    });

    it('rejects for a file that is not a RAR archive', async () => {
      const path = join(root, 'junk.cbr');
      await writeFile(path, Buffer.from('this is definitely not a rar archive, just text'));

      await expect(listRarEntries(path, () => true)).rejects.toSatisfy(isUnrarError);
    });
  });

  describe('extractRarEntry', () => {
    it('extracts the named entry byte-identical', async () => {
      const big = Buffer.alloc(300 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) % 251;
      const path = await writeArchive([
        { name: 'small.jpg', data: Buffer.from([1, 2, 3]) },
        { name: 'big.jpg', data: big },
        { name: 'other.jpg', data: Buffer.from([9, 9]) },
      ]);

      const result = await extractRarEntry(path, ['big.jpg']);
      expect(result?.equals(big)).toBe(true);
      await expect(extractRarEntry(path, ['small.jpg'])).resolves.toEqual(Buffer.from([1, 2, 3]));
    });

    it('extracts the entry a predicate selects', async () => {
      const path = await writeArchive([
        { name: 'a.jpg', data: Buffer.from([1]) },
        { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') },
      ]);

      await expect(extractRarEntry(path, (h) => h.name.toLowerCase() === 'comicinfo.xml')).resolves.toEqual(Buffer.from('<ComicInfo/>'));
    });

    it('returns null when the requested name is absent', async () => {
      const path = await writeArchive([{ name: 'a.jpg', data: Buffer.from([1]) }]);

      await expect(extractRarEntry(path, ['missing.jpg'])).resolves.toBeNull();
    });

    it('leaves no temp directory behind after success', async () => {
      const path = await writeArchive([{ name: 'a.jpg', data: Buffer.from([1]) }]);
      const before = await leftoverTempDirs();

      await extractRarEntry(path, ['a.jpg']);
      await extractRarEntry(path, ['missing.jpg']);

      expect(await leftoverTempDirs()).toEqual(before);
    });

    it('leaves no temp directory behind after a failure', async () => {
      const path = join(root, 'junk.cbr');
      await writeFile(path, Buffer.from('this is definitely not a rar archive, just text'));
      const before = await leftoverTempDirs();

      await expect(extractRarEntry(path, ['a.jpg'])).rejects.toThrow();

      expect(await leftoverTempDirs()).toEqual(before);
    });

    it('keeps a hostile entry name inside the temp directory', async () => {
      const path = await writeArchive([{ name: '../../escape.jpg', data: Buffer.from([6, 6, 6]) }]);
      const escapeTargets = [join(tmpdir(), 'escape.jpg'), join(dirname(tmpdir()), 'escape.jpg')];

      await expect(extractRarEntry(path, ['../../escape.jpg'])).resolves.toEqual(Buffer.from([6, 6, 6]));

      for (const target of escapeTargets) {
        await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });

    it('rejects for a file that is not a RAR archive', async () => {
      const path = join(root, 'junk.cbr');
      await writeFile(path, Buffer.from('this is definitely not a rar archive, just text'));

      await expect(extractRarEntry(path, ['a.jpg'])).rejects.toSatisfy(isUnrarError);
    });
  });
});
