import type { FastifyRequest } from 'fastify';
import type { FileStorage, StorageCategory, StoredFile } from './storage';
import { badRequest } from './errors';
import { safeFilename } from './util';

export interface MultipartResult {
  fields: Record<string, string>;
  files: { field: string; filename: string; mimetype: string; stored: StoredFile }[];
}

/** Reads a multipart request, streaming every file part into storage. */
export async function readMultipart(
  req: FastifyRequest,
  storage: FileStorage,
  category: StorageCategory,
  maxBytes: number,
  maxFiles = 1,
): Promise<MultipartResult> {
  if (!req.isMultipart()) throw badRequest('Expected multipart/form-data');
  const fields: Record<string, string> = {};
  const files: MultipartResult['files'] = [];
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (files.length >= maxFiles) {
          part.file.resume();
          throw badRequest(`At most ${maxFiles} file(s) per request`);
        }
        const stored = await storage.save(category, part.file, maxBytes);
        files.push({ field: part.fieldname, filename: safeFilename(part.filename || 'upload'), mimetype: part.mimetype, stored });
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value.slice(0, 2000);
      }
    }
  } catch (err) {
    for (const f of files) storage.remove(f.stored.storagePath);
    throw err;
  }
  return { fields, files };
}
