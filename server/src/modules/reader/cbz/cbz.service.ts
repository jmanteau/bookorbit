import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { stat } from 'fs/promises';
import { createSevenZipTempId, getSevenZip, mountHostArchive, type SevenZipFS } from '../../../common/sevenzip';
import { imageContentTypeFromPath } from '../../../common/image-content-type';
import { detectComicContainerFormat } from '../../../common/comic-format-detect';
import { extractRarEntry, isUnrarError, listRarEntries } from '../../../common/rar-file-reader';
import { createCbzZipEntryReadStream, readCbzZipIndex, type CbzZipEntry } from '../../../common/cbz-zip-reader';
import { compareComicPagePaths, listExtractedFiles, pathBasename, removeExtractedTree } from './cb7-extraction';

import type { RequestUser } from '../../../common/types/request-user';
import { BookService } from '../../book/book.service';

// ── Shared helpers ─────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

function isImage(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && IMAGE_EXTS.has(name.substring(dot).toLowerCase());
}

function isHidden(name: string): boolean {
  return name.split('/').some((p) => p.startsWith('.'));
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function mimeForExt(name: string): string {
  return imageContentTypeFromPath(name);
}

// ── CBR: node-unrar-js ─────────────────────────────────────────────────────────

function unreadableCbrArchive(err: Error): UnprocessableEntityException {
  return new UnprocessableEntityException(`CBR archive is unreadable: ${err.message}`);
}

function unreadableCbrPage(err: Error): UnprocessableEntityException {
  return new UnprocessableEntityException(`CBR page is unreadable: ${err.message}`);
}

// ── Freshness ──────────────────────────────────────────────────────────────────

/** Bump when page listing or ordering changes, so a revalidation cannot keep a page from the old order. */
const PAGE_ETAG_VERSION = 1;

type ComicFormat = 'cbz' | 'cbr' | 'cb7';

function isComicFormat(format: string | null): format is ComicFormat {
  return format === 'cbz' || format === 'cbr' || format === 'cb7';
}

/** Which version of a file a cache entry was built from. The metadata writer replaces files in place. */
interface FileStamp {
  mtimeMs: number;
  size: number;
}

interface Stamped<T> {
  stamp: FileStamp;
  value: T;
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function pageEtag(fileId: number, stamp: FileStamp, pageIndex: number): string {
  const digest = createHash('sha1').update(`${PAGE_ETAG_VERSION}:${fileId}:${stamp.mtimeMs}:${stamp.size}:${pageIndex}`).digest('base64url');
  return `"${digest}"`;
}

/** RFC 9110 weak comparison, which is what If-None-Match uses. */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
}

// ── Service ────────────────────────────────────────────────────────────────────

interface RarCache {
  pages: string[];
}

interface SevenZipPages {
  /** This extraction's own folder in the shared WASM filesystem. */
  dir: string;
  /** Paths relative to `dir`, in reading order. */
  pages: string[];
  /** Size of everything extracted into `dir`, which is what the cache budget counts. */
  bytes: number;
}

// efficiency: a fixed budget, not config, sized for a handful of large comics. A single archive over it is still served: it is kept alone.
const SEVEN_ZIP_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

export type ComicPageResult =
  { notModified: true; etag: string } | { notModified: false; etag: string; stream: NodeJS.ReadableStream; mimeType: string };

interface OpenedComic {
  absolutePath: string;
  format: ComicFormat;
  stamp: FileStamp;
}

@Injectable()
export class CbzService {
  private readonly logger = new Logger(CbzService.name);
  // CBZ: byte-offset index per fileId
  private readonly zipIndex = new Map<number, Stamped<CbzZipEntry[]>>();
  // CBR: sorted page names per fileId
  private readonly rarCache = new Map<number, Stamped<RarCache>>();
  // CB7: extracted folder + sorted page paths per fileId (extracted files live in WASM VFS). Insertion order is recency, oldest first.
  private readonly sevenZPages = new Map<number, Stamped<SevenZipPages>>();
  private sevenZipBytes = 0;
  private sevenZipCacheBudgetBytes = SEVEN_ZIP_CACHE_BUDGET_BYTES;
  // Resolved actual format per fileId (magic bytes override stored extension)
  private readonly resolvedFormat = new Map<number, Stamped<ComicFormat>>();

  constructor(private readonly bookService: BookService) {}

  private async openComic(fileId: number, user: RequestUser): Promise<OpenedComic> {
    const file = await this.bookService.verifyFileAccess(fileId, user);
    if (!isComicFormat(file.format)) {
      throw new NotFoundException(`Unsupported comic format: ${file.format ?? ''}`);
    }
    const stamp = await this.statFile(fileId, file.absolutePath);
    const format = await this.resolveFormat(fileId, file.absolutePath, file.format, stamp);
    return { absolutePath: file.absolutePath, format, stamp };
  }

  private async statFile(fileId: number, absolutePath: string): Promise<FileStamp> {
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(absolutePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new NotFoundException('Comic file is missing on disk');
      throw err;
    }

    const stamp = { mtimeMs: Number(stats.mtimeMs), size: Number(stats.size) };
    if (this.hasStaleEntry(fileId, stamp)) await this.invalidate(fileId);
    return stamp;
  }

  private hasStaleEntry(fileId: number, stamp: FileStamp): boolean {
    const entries = [this.zipIndex.get(fileId), this.rarCache.get(fileId), this.sevenZPages.get(fileId), this.resolvedFormat.get(fileId)];
    return entries.some((entry) => entry !== undefined && !sameStamp(entry.stamp, stamp));
  }

  private async invalidate(fileId: number): Promise<void> {
    this.zipIndex.delete(fileId);
    this.rarCache.delete(fileId);
    this.resolvedFormat.delete(fileId);
    const sevenZip = this.forgetSevenZipEntry(fileId);
    if (sevenZip) removeExtractedTree((await getSevenZip()).FS, sevenZip.value.dir);
  }

  private async resolveFormat(fileId: number, absolutePath: string, storedFmt: ComicFormat, stamp: FileStamp): Promise<ComicFormat> {
    const cached = this.resolvedFormat.get(fileId);
    if (cached && sameStamp(cached.stamp, stamp)) return cached.value;

    const resolved = await detectComicContainerFormat(absolutePath, storedFmt);
    this.resolvedFormat.set(fileId, { stamp, value: resolved });
    return resolved;
  }

  // ── CBZ ──────────────────────────────────────────────────────────────────────

  private async getCbzIndex(fileId: number, filePath: string, stamp: FileStamp): Promise<CbzZipEntry[]> {
    const cached = this.zipIndex.get(fileId);
    if (cached && sameStamp(cached.stamp, stamp)) return cached.value;

    const index = await readCbzZipIndex(filePath);
    // Not cached: the reader also answers null for a transient read error, which a retry should get past.
    if (!index) throw new UnprocessableEntityException('CBZ archive is unreadable');

    const entries = index.entries
      .filter((entry) => !entry.name.endsWith('/') && !isHidden(entry.name) && isImage(entry.name))
      .filter((entry) => (entry.compression === 0 || entry.compression === 8) && entry.compressedSize > 0)
      .sort((a, b) => naturalSort(a.name, b.name));
    this.zipIndex.set(fileId, { stamp, value: entries });
    return entries;
  }

  // ── CBR ──────────────────────────────────────────────────────────────────────

  private async getRarCache(fileId: number, filePath: string, stamp: FileStamp): Promise<RarCache> {
    const cached = this.rarCache.get(fileId);
    if (cached && sameStamp(cached.stamp, stamp)) return cached.value;

    let pages: string[];
    try {
      pages = await listRarEntries(filePath, (h) => isImage(h.name) && !isHidden(h.name));
    } catch (err) {
      throw isUnrarError(err) ? unreadableCbrArchive(err) : err;
    }

    pages.sort(naturalSort);
    const value = { pages };
    this.rarCache.set(fileId, { stamp, value });
    return value;
  }

  private async extractRarPage(filePath: string, pageName: string): Promise<Buffer> {
    let data: Buffer | null;
    try {
      // Pass an array so the extractor stops after the first match and never
      // hits the malformed end-of-archive marker present in some RAR 1.5 files.
      data = await extractRarEntry(filePath, [pageName]);
    } catch (err) {
      if (isUnrarError(err)) {
        throw unreadableCbrPage(err);
      }
      throw err;
    }
    if (data === null) throw new NotFoundException(`Page not found in RAR archive`);
    return data;
  }

  // ── CB7 ──────────────────────────────────────────────────────────────────────

  private async getSevenZPages(fileId: number, filePath: string, stamp: FileStamp): Promise<SevenZipPages> {
    const cached = this.sevenZPages.get(fileId);
    if (cached && sameStamp(cached.stamp, stamp)) {
      this.sevenZPages.delete(fileId);
      this.sevenZPages.set(fileId, cached);
      return cached.value;
    }

    const sz = await getSevenZip();

    // A folder per extraction, so a rebuild after the file changed never shares a tree with
    // requests still reading the previous one.
    const dir = `/${createSevenZipTempId(`comic${fileId}`)}`;

    let source: ReturnType<typeof mountHostArchive> | null = null;
    try {
      source = mountHostArchive(sz, filePath);
      sz.FS.mkdir(dir);

      // callMain is synchronous - blocks the event loop while 7z extracts.
      // Acceptable for a local single-user server; revisit with worker_threads if needed.
      // `x` keeps folders: `e` flattened them, so two pages sharing a name overwrote each other.
      sz.callMain(['x', source.archivePath, `-o${dir}`, '-y']);
    } catch (err) {
      removeExtractedTree(sz.FS, dir);
      throw err;
    } finally {
      source?.release();
    }

    const files = listExtractedFiles(sz.FS, dir);
    const bytes = files.reduce((total, path) => total + sz.FS.stat(`${dir}/${path}`).size, 0);

    // Only the file name decides hidden, as it did when the archive was extracted flat.
    const pages = files
      .filter((path) => {
        const name = pathBasename(path);
        return isImage(name) && !name.startsWith('.');
      })
      .sort(compareComicPagePaths);

    const previous = this.forgetSevenZipEntry(fileId);
    if (previous) removeExtractedTree(sz.FS, previous.value.dir);
    const value = { dir, pages, bytes };
    this.sevenZPages.set(fileId, { stamp, value });
    this.sevenZipBytes += bytes;
    this.evictSevenZipOverBudget(sz.FS, fileId);
    return value;
  }

  private forgetSevenZipEntry(fileId: number): Stamped<SevenZipPages> | undefined {
    const entry = this.sevenZPages.get(fileId);
    if (entry) {
      this.sevenZPages.delete(fileId);
      this.sevenZipBytes -= entry.value.bytes;
    }
    return entry;
  }

  private evictSevenZipOverBudget(fs: SevenZipFS, keepFileId: number): void {
    for (const [fileId, entry] of this.sevenZPages) {
      if (this.sevenZipBytes <= this.sevenZipCacheBudgetBytes || fileId === keepFileId) return;
      this.forgetSevenZipEntry(fileId);
      removeExtractedTree(fs, entry.value.dir);
      this.logger.debug(
        `[reader.cb7_cache_evict] [end] fileId=${fileId} bytes=${entry.value.bytes} totalBytes=${this.sevenZipBytes} budgetBytes=${this.sevenZipCacheBudgetBytes} - evicted cached CB7 extraction`,
      );
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  async getPageCount(fileId: number, user: RequestUser): Promise<number> {
    const comic = await this.openComic(fileId, user);

    if (comic.format === 'cbz') return (await this.getCbzIndex(fileId, comic.absolutePath, comic.stamp)).length;
    if (comic.format === 'cbr') return (await this.getRarCache(fileId, comic.absolutePath, comic.stamp)).pages.length;
    return (await this.getSevenZPages(fileId, comic.absolutePath, comic.stamp)).pages.length;
  }

  /**
   * Answers `notModified` without reading the archive when `ifNoneMatch` names this exact page of
   * this exact version of the file, so a client revalidating a page it already has costs a stat.
   */
  async streamPage(fileId: number, pageIndex: number, user: RequestUser, ifNoneMatch?: string): Promise<ComicPageResult> {
    const comic = await this.openComic(fileId, user);
    const etag = pageEtag(fileId, comic.stamp, pageIndex);
    if (matchesIfNoneMatch(ifNoneMatch, etag)) return { notModified: true, etag };

    if (comic.format === 'cbz') {
      const entries = await this.getCbzIndex(fileId, comic.absolutePath, comic.stamp);
      if (pageIndex < 0 || pageIndex >= entries.length) {
        throw new NotFoundException(`Page ${pageIndex} out of range`);
      }
      const entry = entries[pageIndex];
      return { notModified: false, etag, stream: createCbzZipEntryReadStream(comic.absolutePath, entry), mimeType: mimeForExt(entry.name) };
    }

    if (comic.format === 'cbr') {
      const { pages } = await this.getRarCache(fileId, comic.absolutePath, comic.stamp);
      if (pageIndex < 0 || pageIndex >= pages.length) {
        throw new NotFoundException(`Page ${pageIndex} out of range`);
      }
      const data = await this.extractRarPage(comic.absolutePath, pages[pageIndex]);
      return { notModified: false, etag, stream: Readable.from(data), mimeType: mimeForExt(pages[pageIndex]) };
    }

    const sz = await getSevenZip();
    const { dir, pages } = await this.getSevenZPages(fileId, comic.absolutePath, comic.stamp);
    if (pageIndex < 0 || pageIndex >= pages.length) {
      throw new NotFoundException(`Page ${pageIndex} out of range`);
    }
    const data = sz.FS.readFile(`${dir}/${pages[pageIndex]}`);
    return { notModified: false, etag, stream: Readable.from(Buffer.from(data)), mimeType: mimeForExt(pages[pageIndex]) };
  }
}
