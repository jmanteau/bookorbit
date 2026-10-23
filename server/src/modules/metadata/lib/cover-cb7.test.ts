vi.mock('../../../common/sevenzip', () => ({
  getSevenZip: vi.fn(),
  mountHostArchive: vi.fn(),
  createSevenZipTempId: (prefix: string) => `${prefix}_test`,
}));

import { getSevenZip, mountHostArchive } from '../../../common/sevenzip';
import { extractCb7Cover } from './cover-cb7';

const mockMountHostArchive = mountHostArchive as MockedFunction<typeof mountHostArchive>;
const mockGetSevenZip = getSevenZip as MockedFunction<typeof getSevenZip>;

describe('extractCb7Cover', () => {
  const release = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    mockMountHostArchive.mockReturnValue({ archivePath: '/src_test/book.cb7', release });
  });

  it('extracts first natural-sorted image and cleans wasm VFS artifacts', async () => {
    const fsApi = {
      mkdir: vi.fn(),
      readdir: vi.fn().mockReturnValue(['.', '..', '10.jpg', '2.jpg']),
      readFile: vi.fn().mockReturnValue(Uint8Array.from([1, 2, 3])),
      unlink: vi.fn(),
      rmdir: vi.fn(),
    };

    const callMain = vi.fn();
    mockGetSevenZip.mockResolvedValue({ FS: fsApi, callMain } as any);

    await expect(extractCb7Cover('/book.cb7')).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(mockMountHostArchive).toHaveBeenCalledWith(expect.anything(), '/book.cb7');
    expect(callMain).toHaveBeenCalledWith(['e', '/src_test/book.cb7', '-o/cover_test_out', '-y']);
    expect(fsApi.unlink).toHaveBeenCalledTimes(2);
    expect(fsApi.unlink).not.toHaveBeenCalledWith('/src_test/book.cb7');
    expect(fsApi.rmdir).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('returns null when extracted folder has no image files', async () => {
    const fsApi = {
      mkdir: vi.fn(),
      readdir: vi.fn().mockReturnValue(['.', '..', 'notes.txt']),
      readFile: vi.fn(),
      unlink: vi.fn(),
      rmdir: vi.fn(),
    };

    mockGetSevenZip.mockResolvedValue({ FS: fsApi, callMain: vi.fn() } as any);

    await expect(extractCb7Cover('/book.cb7')).resolves.toBeNull();
  });

  it('returns null on extraction failures', async () => {
    mockGetSevenZip.mockRejectedValue(new Error('7z unavailable'));
    await expect(extractCb7Cover('/book.cb7')).resolves.toBeNull();
  });

  it('cleans up VFS artifacts even when extraction command throws', async () => {
    const fsApi = {
      mkdir: vi.fn(),
      readdir: vi.fn().mockReturnValue(['.', '..']),
      readFile: vi.fn(),
      unlink: vi.fn(),
      rmdir: vi.fn(),
    };
    const callMain = vi.fn().mockImplementation(() => {
      throw new Error('extract failed');
    });

    mockGetSevenZip.mockResolvedValue({ FS: fsApi, callMain } as any);

    await expect(extractCb7Cover('/book.cb7')).resolves.toBeNull();
    expect(fsApi.rmdir).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
