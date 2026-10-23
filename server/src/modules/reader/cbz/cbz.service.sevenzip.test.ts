import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { createSevenZipTempId, getSevenZip } from '../../../common/sevenzip';
import { extractCb7Metadata } from '../../metadata/lib/cbz-metadata';
import { extractCb7Cover } from '../../metadata/lib/cover-cb7';
import { removeExtractedTree } from './cb7-extraction';
import { CbzService, type ComicPageResult } from './cbz.service';

/**
 * CB7 page listing walks a tree the real 7-Zip wrote, so these cases run against the real WASM
 * module: the unit tests stand on a fake filesystem, and this is where the two would disagree.
 */
describe('CbzService CB7 pages against the real 7z module', () => {
  const user = { id: 9, isSuperuser: false, permissions: [] } as any;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'bookorbit-cb7-real-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function buildSevenZip(files: Record<string, string>): Promise<Uint8Array> {
    const sevenZip = await getSevenZip();
    const root = `/${createSevenZipTempId('build')}`;
    sevenZip.FS.mkdir(root);
    for (const [name, contents] of Object.entries(files)) {
      const segments = name.split('/');
      for (let depth = 1; depth < segments.length; depth++) {
        try {
          sevenZip.FS.mkdir(`${root}/${segments.slice(0, depth).join('/')}`);
        } catch {
          // already there
        }
      }
      const fd = sevenZip.FS.open(`${root}/${name}`, 'w+');
      const bytes = new TextEncoder().encode(contents);
      sevenZip.FS.write(fd, bytes, 0, bytes.length);
      sevenZip.FS.close(fd);
    }
    sevenZip.callMain(['a', `${root}/comic.7z`, `${root}/*`, '-y']);
    return sevenZip.FS.readFile(`${root}/comic.7z`);
  }

  /** The page list the flat `e` extraction produced before folders were kept. */
  async function flatPageNames(archive: Uint8Array): Promise<string[]> {
    const sevenZip = await getSevenZip();
    const root = `/${createSevenZipTempId('flat')}`;
    sevenZip.FS.mkdir(root);
    const fd = sevenZip.FS.open(`${root}.7z`, 'w+');
    sevenZip.FS.write(fd, archive, 0, archive.length);
    sevenZip.FS.close(fd);
    sevenZip.callMain(['e', `${root}.7z`, `-o${root}`, '-y']);
    return sevenZip.FS.readdir(root)
      .filter((name) => name !== '.' && name !== '..' && /\.(jpe?g|png)$/i.test(name) && !name.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }

  async function pageTexts(service: CbzService, fileId: number): Promise<string[]> {
    const count = await service.getPageCount(fileId, user);
    const texts: string[] = [];
    for (let index = 0; index < count; index++) {
      const result: ComicPageResult = await service.streamPage(fileId, index, user);
      if (result.notModified) throw new Error('expected page bytes');
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
      texts.push(Buffer.concat(chunks).toString());
    }
    return texts;
  }

  it('keeps the flat page order for an archive whose page names are unique', async () => {
    const files = {
      'Chapter 10/c10.jpg': 'c10.jpg',
      'Chapter 2/c2.jpg': 'c2.jpg',
      'cover.jpg': 'cover.jpg',
      'extras/.thumbs/z1.jpg': 'z1.jpg',
      'extras/credits.png': 'credits.png',
      'extras/._credits.png': 'hidden',
    };
    const archive = await buildSevenZip(files);
    const path = join(workspace, 'unique.cb7');
    await writeFile(path, archive);
    const service = new CbzService({ verifyFileAccess: vi.fn().mockResolvedValue({ format: 'cb7', absolutePath: path }) } as any);

    await expect(pageTexts(service, 31)).resolves.toEqual(await flatPageNames(archive));
  });

  it('serves pages that share a name in different folders, and rereads a rewritten file', async () => {
    const path = join(workspace, 'nested.cb7');
    await writeFile(path, await buildSevenZip({ 'ch2/001.jpg': 'ch2-1', 'ch1/001.jpg': 'ch1-1', 'ch1/002.jpg': 'ch1-2' }));
    const service = new CbzService({ verifyFileAccess: vi.fn().mockResolvedValue({ format: 'cb7', absolutePath: path }) } as any);

    await expect(pageTexts(service, 32)).resolves.toEqual(['ch1-1', 'ch2-1', 'ch1-2']);

    await writeFile(path, await buildSevenZip({ 'ch1/001.jpg': 'rewritten' }));
    await utimes(path, new Date(), new Date(Date.now() + 60_000));

    await expect(pageTexts(service, 32)).resolves.toEqual(['rewritten']);
  });

  describe('reading the archive from the host disk', () => {
    const comicInfo = '<ComicInfo><Title>Mounted</Title></ComicInfo>';

    async function mountpoints(): Promise<string[]> {
      return (await getSevenZip()).FS.readdir('/').filter((name) => name.startsWith('src_'));
    }

    async function writeComic(relativePath: string, bytes: Uint8Array): Promise<string> {
      const path = join(workspace, relativePath);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, bytes);
      return path;
    }

    function serviceFor(path: string): CbzService {
      return new CbzService({ verifyFileAccess: vi.fn().mockResolvedValue({ format: 'cb7', absolutePath: path }) } as any);
    }

    it('leaves the source file untouched and unmounts after the cover, metadata and reader reads', async () => {
      const archive = await buildSevenZip({ '2.jpg': 'two', '1.jpg': 'one', 'ComicInfo.xml': comicInfo });
      const path = await writeComic('Ünïcode dir/Lab #001 - spaces.cb7', archive);
      const before = await readFile(path);

      await expect(extractCb7Cover(path)).resolves.toEqual(Buffer.from('one'));
      expect((await extractCb7Metadata(path))?.title).toBe('Mounted');
      const service = serviceFor(path);
      await expect(pageTexts(service, 41)).resolves.toEqual(['one', 'two']);

      const after = await readFile(path);
      expect(after.equals(before)).toBe(true);
      expect(after.equals(Buffer.from(archive))).toBe(true);
      await expect(mountpoints()).resolves.toEqual([]);
    });

    it('unmounts when the archive is corrupt, and still leaves the file alone', async () => {
      const garbage = Buffer.from('this is not a 7z archive, just some text');
      const path = await writeComic('broken.cb7', garbage);

      await expect(extractCb7Cover(path)).resolves.toBeNull();
      await expect(extractCb7Metadata(path)).resolves.toBeNull();
      await serviceFor(path)
        .getPageCount(42, user)
        .catch(() => undefined);

      expect((await readFile(path)).equals(garbage)).toBe(true);
      await expect(mountpoints()).resolves.toEqual([]);
    });
  });

  describe('cache byte budget', () => {
    const [A, B, C] = [51, 52, 53];
    const ARCHIVE_BYTES = 1000;

    /** One 800 byte page plus a 200 byte non-page file, so the budget has to count every extracted file. */
    async function writeArchive(fileId: number, pageBytes = 800, label = `archive${fileId}-`): Promise<string> {
      const path = join(workspace, `${fileId}.cb7`);
      const page = label + 'x'.repeat(pageBytes - label.length);
      await writeFile(path, await buildSevenZip({ '1.jpg': page, 'notes.txt': 'n'.repeat(ARCHIVE_BYTES - 800) }));
      return path;
    }

    function budgetedService(budgetBytes: number, paths: Record<number, string>): CbzService {
      const service = new CbzService({
        verifyFileAccess: vi.fn((fileId: number) => Promise.resolve({ format: 'cb7', absolutePath: paths[fileId] })),
      } as any);
      (service as any).sevenZipCacheBudgetBytes = budgetBytes;
      return service;
    }

    async function extractedDirs(fileId: number): Promise<string[]> {
      return (await getSevenZip()).FS.readdir('/').filter((name) => name.startsWith(`comic${fileId}_`));
    }

    async function firstPage(service: CbzService, fileId: number): Promise<string> {
      const result = await service.streamPage(fileId, 0, user);
      if (result.notModified) throw new Error('expected page bytes');
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    }

    afterEach(async () => {
      const sevenZip = await getSevenZip();
      for (const name of sevenZip.FS.readdir('/')) {
        if (/^comic5\d_/.test(name)) removeExtractedTree(sevenZip.FS, `/${name}`);
      }
    });

    it('evicts the least recently used extraction once the budget is exceeded, and re-extracts it on demand', async () => {
      const service = budgetedService(2500, { [A]: await writeArchive(A), [B]: await writeArchive(B), [C]: await writeArchive(C) });

      for (const id of [A, B, C]) await service.getPageCount(id, user);

      expect(await extractedDirs(A)).toHaveLength(0);
      expect(await extractedDirs(B)).toHaveLength(1);
      expect(await extractedDirs(C)).toHaveLength(1);

      expect(await firstPage(service, A)).toMatch(/^archive51-x+$/);

      expect(await extractedDirs(A)).toHaveLength(1);
      expect(await extractedDirs(B)).toHaveLength(0);
      expect(await extractedDirs(C)).toHaveLength(1);
    });

    it('counts a cache hit as a use', async () => {
      const service = budgetedService(2500, { [A]: await writeArchive(A), [B]: await writeArchive(B), [C]: await writeArchive(C) });

      await service.getPageCount(A, user);
      await service.getPageCount(B, user);
      await firstPage(service, A);
      await service.getPageCount(C, user);

      expect(await extractedDirs(A)).toHaveLength(1);
      expect(await extractedDirs(B)).toHaveLength(0);
      expect(await extractedDirs(C)).toHaveLength(1);
    });

    it('still serves an archive larger than the budget, keeping it alone', async () => {
      const service = budgetedService(500, { [A]: await writeArchive(A), [B]: await writeArchive(B) });

      await expect(service.getPageCount(A, user)).resolves.toBe(1);
      expect(await extractedDirs(A)).toHaveLength(1);

      expect(await firstPage(service, B)).toMatch(/^archive52-x+$/);
      expect(await extractedDirs(A)).toHaveLength(0);
      expect(await extractedDirs(B)).toHaveLength(1);
    });

    it('keeps the running total right when a rewritten file replaces its extraction', async () => {
      const paths = { [A]: await writeArchive(A), [B]: await writeArchive(B), [C]: await writeArchive(C) };
      const service = budgetedService(2500, paths);

      await service.getPageCount(A, user);
      await service.getPageCount(B, user);

      await writeArchive(A, 900, 'rewritten-');
      await utimes(paths[A], new Date(), new Date(Date.now() + 60_000));
      expect(await firstPage(service, A)).toMatch(/^rewritten-x+$/);

      // 1000 (B) + 1100 (new A) fits; a total that still counted the old A would evict B here.
      expect(await extractedDirs(A)).toHaveLength(1);
      expect(await extractedDirs(B)).toHaveLength(1);

      await service.getPageCount(C, user);

      expect(await extractedDirs(A)).toHaveLength(1);
      expect(await extractedDirs(B)).toHaveLength(0);
      expect(await extractedDirs(C)).toHaveLength(1);
    });
  });
});
