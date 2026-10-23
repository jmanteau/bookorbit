import { getSevenZip, mountHostArchive } from '../../../common/sevenzip';
import { compareArchiveEntryNames, isArchiveImageFile } from './archive-image-utils';
import { cleanupSevenZipArtifacts, createSevenZipTempId, type SevenZipInstance } from './sevenzip-vfs';

export async function extractCb7Cover(absolutePath: string): Promise<Buffer | null> {
  let sz: SevenZipInstance | null = null;
  let source: ReturnType<typeof mountHostArchive> | null = null;
  let outDir: string | null = null;

  try {
    sz = await getSevenZip();
    source = mountHostArchive(sz, absolutePath);

    // Use a unique ID to avoid VFS path collisions between concurrent requests.
    outDir = `/${createSevenZipTempId('cover')}_out`;

    try {
      sz.FS.mkdir(outDir);
    } catch {
      // already exists
    }

    sz.callMain(['e', source.archivePath, `-o${outDir}`, '-y']);

    const files = sz.FS.readdir(outDir)
      .filter((f) => f !== '.' && f !== '..' && isArchiveImageFile(f))
      .sort(compareArchiveEntryNames);

    const result = files.length > 0 ? Buffer.from(sz.FS.readFile(`${outDir}/${files[0]}`)) : null;
    return result;
  } catch {
    return null;
  } finally {
    source?.release();
    if (sz && outDir) {
      cleanupSevenZipArtifacts(sz, outDir);
    }
  }
}
