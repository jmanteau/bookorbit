import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { copyFileWithFallback } from './safe-copy.utils';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});

const copyFileMock = vi.mocked(fsPromises.copyFile);

function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: refused, copyfile`);
  error.code = code;
  return error;
}

describe('copyFileWithFallback', () => {
  let root: string;
  let source: string;
  let destination: string;
  const content = Buffer.from('comic bytes '.repeat(4096));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'safe-copy-'));
    source = join(root, 'source.cbz');
    destination = join(root, 'destination.cbz');
    await writeFile(source, content);
  });

  afterEach(async () => {
    copyFileMock.mockClear();
    await rm(root, { recursive: true, force: true });
  });

  async function stagingLeftovers(): Promise<string[]> {
    return (await readdir(root)).filter((name) => name.startsWith('.bookorbit-copy-'));
  }

  it('uses copyFile on the normal path', async () => {
    await copyFileWithFallback(source, destination);

    expect(copyFileMock).toHaveBeenCalledTimes(1);
    expect(await readFile(destination)).toEqual(content);
  });

  it.each(['EPERM', 'ENOSYS'])('falls back to a stream copy when copyFile fails with %s', async (code) => {
    copyFileMock.mockRejectedValueOnce(errnoError(code));

    await copyFileWithFallback(source, destination);

    expect(await readFile(destination)).toEqual(content);
    expect(await stagingLeftovers()).toEqual([]);
  });

  it('overwrites an existing destination through the fallback when not exclusive', async () => {
    await writeFile(destination, 'old');
    copyFileMock.mockRejectedValueOnce(errnoError('EPERM'));

    await copyFileWithFallback(source, destination);

    expect(await readFile(destination)).toEqual(content);
  });

  it('refuses an existing destination in exclusive mode on the normal path', async () => {
    await writeFile(destination, 'keep me');

    await expect(copyFileWithFallback(source, destination, { exclusive: true })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination, 'utf8')).toBe('keep me');
  });

  it('refuses an existing destination in exclusive mode on the fallback path', async () => {
    await writeFile(destination, 'keep me');
    copyFileMock.mockRejectedValueOnce(errnoError('EPERM'));

    await expect(copyFileWithFallback(source, destination, { exclusive: true })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination, 'utf8')).toBe('keep me');
    expect(await stagingLeftovers()).toEqual([]);
  });

  it('rethrows errors that a stream copy would not fix', async () => {
    copyFileMock.mockRejectedValueOnce(errnoError('EACCES'));

    await expect(copyFileWithFallback(source, destination)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await readdir(root)).toEqual(['source.cbz']);
  });

  it('removes a partial destination left by copyFile before falling back', async () => {
    copyFileMock.mockImplementationOnce(async (_src, dest) => {
      await writeFile(dest as string, 'partial');
      throw errnoError('EPERM');
    });

    await copyFileWithFallback(source, destination, { exclusive: true });

    expect(await readFile(destination)).toEqual(content);
    expect(await stagingLeftovers()).toEqual([]);
  });

  it('cleans up staging when the stream copy fails', async () => {
    copyFileMock.mockRejectedValueOnce(errnoError('EPERM'));

    await expect(copyFileWithFallback(join(root, 'missing.cbz'), destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stagingLeftovers()).toEqual([]);
    expect(await readdir(root)).toEqual(['source.cbz']);
  });
});
