import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createExtractorFromFile, UnrarError, type FileHeader } from 'node-unrar-js';

const ENTRY_FILE = 'entry';

export function isUnrarError(err: unknown): err is Error {
  if (typeof UnrarError === 'function' && err instanceof UnrarError) return true;
  if (!(err instanceof Error)) return false;
  const reason = (err as Error & { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.startsWith('ERAR_');
}

export async function listRarEntries(absolutePath: string, accept: (header: FileHeader) => boolean): Promise<string[]> {
  const extractor = await createExtractorFromFile({ filepath: absolutePath });
  const names: string[] = [];
  try {
    // Generators MUST be fully drained to avoid WASM memory leak
    for (const header of extractor.getFileList().fileHeaders) {
      if (!header.flags.directory && accept(header)) names.push(header.name);
    }
  } catch (err) {
    // Some RAR 1.5 archives throw ERAR_BAD_DATA at the end-of-archive marker instead of
    // ERAR_END_ARCHIVE. Accept the partial list when it already has entries.
    if (!isUnrarError(err) || names.length === 0) throw err;
  }
  return names;
}

/**
 * The extractor can only write to disk, so the entry goes to a private temp dir under a fixed
 * name: a hostile entry name cannot escape the dir, and the output path is known.
 */
export async function extractRarEntry(absolutePath: string, files: string[] | ((header: FileHeader) => boolean)): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'bookorbit-rar-'));
  try {
    const extractor = await createExtractorFromFile({ filepath: absolutePath, targetPath: dir, filenameTransform: () => ENTRY_FILE });
    let extracted = false;
    try {
      for (const file of extractor.extract({ files }).files) {
        if (!file.fileHeader.flags.directory) extracted = true;
      }
    } catch (err) {
      // Some RAR 1.5 archives throw ERAR_BAD_DATA at the end-of-archive marker.
      // If we already extracted the file we needed, use it.
      if (!isUnrarError(err) || !extracted) throw err;
    }
    return extracted ? await readFile(join(dir, ENTRY_FILE)) : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
