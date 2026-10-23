import { cleanupSevenZipArtifacts, createSevenZipTempId } from './sevenzip-vfs';

describe('sevenzip-vfs', () => {
  it('creates prefixed unique temp ids', () => {
    const id = createSevenZipTempId('cover');
    expect(id.startsWith('cover_')).toBe(true);
    expect(id.length).toBeGreaterThan('cover_'.length);
  });

  it('cleans extracted files and the output directory', () => {
    const fsApi = {
      readdir: vi.fn().mockReturnValue(['.', '..', 'ComicInfo.xml']),
      unlink: vi.fn(),
      rmdir: vi.fn(),
    };

    cleanupSevenZipArtifacts({ FS: fsApi } as any, '/out');

    expect(fsApi.unlink).toHaveBeenCalledWith('/out/ComicInfo.xml');
    expect(fsApi.rmdir).toHaveBeenCalledWith('/out');
    expect(fsApi.unlink).toHaveBeenCalledTimes(1);
  });

  it('never unlinks anything but the extracted files, so a mounted archive stays on disk', () => {
    const fsApi = {
      readdir: vi.fn().mockImplementation(() => {
        throw new Error('missing directory');
      }),
      unlink: vi.fn(),
      rmdir: vi.fn(),
    };

    cleanupSevenZipArtifacts({ FS: fsApi } as any, '/out');

    expect(fsApi.unlink).not.toHaveBeenCalled();
  });
});
