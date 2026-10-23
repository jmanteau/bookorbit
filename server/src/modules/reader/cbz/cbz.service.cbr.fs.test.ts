import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildRar5StoreArchive } from '../../../../test/helpers/rar5-store.fixture';
import { CbzService } from './cbz.service';

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('CbzService with a real CBR on disk', () => {
  const user = { id: 9, isSuperuser: false, permissions: [] } as any;
  const pages = {
    'p1.jpg': Buffer.from([1, 1, 1]),
    'p2.jpg': Buffer.from([2, 2, 2, 2]),
    'p10.jpg': Buffer.from([10, 10, 10, 10, 10]),
  };

  let root: string;
  let service: CbzService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cbz-service-cbr-test-'));
    const absolutePath = join(root, 'book.cbr');
    await writeFile(
      absolutePath,
      buildRar5StoreArchive([
        { name: 'p10.jpg', data: pages['p10.jpg'] },
        { name: 'p2.jpg', data: pages['p2.jpg'] },
        { name: 'p1.jpg', data: pages['p1.jpg'] },
      ]),
    );
    service = new CbzService({ verifyFileAccess: () => Promise.resolve({ absolutePath, format: 'cbr' }) } as any);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function page(index: number): Promise<Buffer> {
    const result = await service.streamPage(1, index, user);
    if (result.notModified) throw new Error('expected page bytes, got notModified');
    return readStream(result.stream);
  }

  it('counts the pages and streams each one in natural order from disk', async () => {
    await expect(service.getPageCount(1, user)).resolves.toBe(3);

    await expect(page(0)).resolves.toEqual(pages['p1.jpg']);
    await expect(page(1)).resolves.toEqual(pages['p2.jpg']);
    await expect(page(2)).resolves.toEqual(pages['p10.jpg']);
    await expect(page(1)).resolves.toEqual(pages['p2.jpg']);
  });
});
