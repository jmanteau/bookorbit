import { extractRarEntry, listRarEntries } from '../../../common/rar-file-reader';
import { compareArchiveEntryNames, isArchiveImageFile, isHiddenArchivePath } from './archive-image-utils';

export async function extractCbrCover(absolutePath: string): Promise<Buffer | null> {
  try {
    const images = await listRarEntries(absolutePath, (h) => isArchiveImageFile(h.name) && !isHiddenArchivePath(h.name));
    if (images.length === 0) return null;
    images.sort(compareArchiveEntryNames);

    // Pass an array so the extractor stops after the first match and never
    // hits the malformed end-of-archive marker in some RAR 1.5 files.
    return await extractRarEntry(absolutePath, [images[0]]);
  } catch {
    return null;
  }
}
