import { link, mkdtemp, readFile, rm, stat, writeFile, chmod } from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { replaceFileAtomically } from './atomic-file-replace';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, chmod: vi.fn(actual.chmod) };
});

function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: refused, chmod`);
  error.code = code;
  return error;
}

describe('replaceFileAtomically on a real filesystem', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bookorbit-atomic-'));
  });

  afterEach(async () => {
    vi.mocked(fsPromises.chmod).mockClear();
    await rm(dir, { recursive: true, force: true });
  });

  it.each([0o444, 0o640, 0o600])('keeps the original mode %o on the replacement', async (mode) => {
    const target = join(dir, 'book.epub');
    const temp = join(dir, '.epub-write-temp');
    await writeFile(target, 'old');
    await chmod(target, mode);
    await writeFile(temp, 'new');

    await replaceFileAtomically(temp, target);

    expect(await readFile(target, 'utf8')).toBe('new');
    expect((await stat(target)).mode & 0o777).toBe(mode);
  });

  it('keeps the original owner and group', async () => {
    const target = join(dir, 'book.epub');
    const temp = join(dir, '.epub-write-temp');
    await writeFile(target, 'old');
    await writeFile(temp, 'new');
    const before = await stat(target);

    await replaceFileAtomically(temp, target);

    const after = await stat(target);
    expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
  });

  it('splits a hardlinked original so its twin, often a seeding copy, keeps its bytes', async () => {
    const target = join(dir, 'book.m4b');
    const twin = join(dir, 'seeding-copy.m4b');
    const temp = join(dir, '.bookorbit-write-temp.m4b');
    await writeFile(target, 'old');
    await link(target, twin);
    await writeFile(temp, 'new');

    await replaceFileAtomically(temp, target);

    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readFile(twin, 'utf8')).toBe('old');
  });

  it('replaces a file that did not exist yet with the temp file as is', async () => {
    const target = join(dir, 'new.epub');
    const temp = join(dir, '.epub-write-temp');
    await writeFile(temp, 'new');

    await replaceFileAtomically(temp, target);

    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it.each(['EPERM', 'ENOTSUP'])('replaces the file when the share refuses chmod with %s', async (code) => {
    const target = join(dir, 'book.epub');
    const temp = join(dir, '.epub-write-temp');
    await writeFile(target, 'old');
    await writeFile(temp, 'new');
    vi.mocked(fsPromises.chmod).mockRejectedValueOnce(errnoError(code));

    await replaceFileAtomically(temp, target);

    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('still fails and keeps the original when chmod is denied for another reason', async () => {
    const target = join(dir, 'book.epub');
    const temp = join(dir, '.epub-write-temp');
    await writeFile(target, 'old');
    await writeFile(temp, 'new');
    vi.mocked(fsPromises.chmod).mockRejectedValueOnce(errnoError('EACCES'));

    await expect(replaceFileAtomically(temp, target)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await readFile(target, 'utf8')).toBe('old');
    await expect(stat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
