import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { uuid } from './util';
import { HttpError } from './errors';

export type StorageCategory = 'logs' | 'firmware' | 'payload';

export interface StoredFile {
  storagePath: string;
  size: number;
  sha256: string;
}

/** Content-addressed-ish local file storage below <dataDir>/files. Paths are always server-generated. */
export class FileStorage {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'files');
    for (const c of ['logs', 'firmware', 'payload'] as const) mkdirSync(join(this.root, c), { recursive: true });
  }

  /** Streams data into a new file, computing size and SHA-256. Enforces maxBytes. */
  async save(category: StorageCategory, source: Readable, maxBytes: number): Promise<StoredFile> {
    const rel = join(category, uuid());
    const abs = this.abs(rel);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          cb(new HttpError(413, 'too_large', `File exceeds the ${Math.round(maxBytes / 1048576)} MB limit`));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(abs, { flags: 'wx' }));
    } catch (err) {
      rmSync(abs, { force: true });
      throw err;
    }
    return { storagePath: rel, size, sha256: hash.digest('hex') };
  }

  async saveBuffer(category: StorageCategory, data: Buffer): Promise<StoredFile> {
    const { Readable } = await import('node:stream');
    return this.save(category, Readable.from([data]), Number.MAX_SAFE_INTEGER);
  }

  abs(storagePath: string): string {
    const abs = resolve(this.root, storagePath);
    if (!abs.startsWith(this.root + sep)) throw new Error('invalid storage path');
    return abs;
  }

  stream(storagePath: string): Readable {
    return createReadStream(this.abs(storagePath));
  }

  size(storagePath: string): number {
    return statSync(this.abs(storagePath)).size;
  }

  remove(storagePath: string): void {
    rmSync(this.abs(storagePath), { force: true });
  }
}
