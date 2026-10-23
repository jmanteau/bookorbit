import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { constants, createReadStream } from 'fs';
import { copyFile, open, rename, stat, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { pipeline } from 'stream/promises';

import { sanitizeLogValue } from './log-sanitize.utils';

const logger = new Logger('SafeCopy');

// copyFile goes through copy_file_range and copies the file mode, which ACL-backed shares
// (ZFS, TrueNAS, Synology, some NFS/SMB mounts) refuse even though plain writes are allowed.
const FALLBACK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL']);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function existsError(destination: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`EEXIST: file already exists, copyfile -> '${destination}'`);
  error.code = 'EEXIST';
  error.path = destination;
  return error;
}

/**
 * Copies with `copyFile` (reflinks and server-side copies stay intact) and falls back to a staged
 * stream copy only when the filesystem refuses it. With `exclusive`, an existing destination is
 * never overwritten and the call fails with EEXIST.
 */
export async function copyFileWithFallback(source: string, destination: string, { exclusive = false }: { exclusive?: boolean } = {}): Promise<void> {
  const existedBefore = exclusive && (await pathExists(destination));
  try {
    await copyFile(source, destination, exclusive ? constants.COPYFILE_EXCL : 0);
    return;
  } catch (error) {
    const code = errorCode(error);
    if (!code || !FALLBACK_CODES.has(code)) throw error;
    if (exclusive && existedBefore) throw existsError(destination);
    if (exclusive) await unlink(destination).catch(() => {});

    const startedAt = Date.now();
    await streamCopyViaStaging(source, destination, exclusive);
    logger.debug(
      `[storage.copy_fallback] [end] path="${sanitizeLogValue(destination)}" errno=${code} durationMs=${Date.now() - startedAt} - copied via stream fallback`,
    );
  }
}

async function streamCopyViaStaging(source: string, destination: string, exclusive: boolean): Promise<void> {
  // No book extension on the staging name, so scanners never ingest a partially written file.
  const stagingPath = join(dirname(destination), `.bookorbit-copy-${randomUUID()}.tmp`);
  const stagingFile = await open(stagingPath, 'wx');
  try {
    await pipeline(createReadStream(source), stagingFile.createWriteStream());
    // efficiency: check-then-rename leaves a tiny race; request import claims the name before copying.
    if (exclusive && (await pathExists(destination))) throw existsError(destination);
    await rename(stagingPath, destination);
  } catch (error) {
    await stagingFile.close().catch(() => {});
    await unlink(stagingPath).catch(() => {});
    throw error;
  }
}
