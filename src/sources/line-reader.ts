// Incremental reader of an append-only file: each read() returns only the complete lines written
// since the previous call. Partial lines (and split UTF-8 characters) wait for the next read.
import { open, stat } from 'node:fs/promises';

const NEWLINE = 0x0a;
const CHUNK_BYTES = 1 << 20;

export interface LineReaderOptions {
  /** On the first read, start this many bytes before the end instead of at the beginning. */
  readonly maxInitialBytes?: number;
}

export interface ReadResult {
  readonly lines: readonly string[];
  /** True when the file was truncated or replaced and reading restarted from the beginning. */
  readonly restarted: boolean;
  /** False once the file no longer exists. */
  readonly exists: boolean;
  /** Last modification time seen by this read (0 when the file is missing). */
  readonly modifiedMs: number;
}

export interface LineReader {
  read(): Promise<ReadResult>;
  readonly path: string;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export function createLineReader(path: string, options: LineReaderOptions = {}): LineReader {
  let offset: number | null = null;
  let inode: number | null = null;
  let pending: Buffer = Buffer.alloc(0);
  let dropFirstLine = false;

  async function readRange(from: number, to: number): Promise<Buffer> {
    const handle = await open(path, 'r');
    try {
      const parts: Buffer[] = [];
      for (let position = from; position < to; ) {
        const length = Math.min(CHUNK_BYTES, to - position);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead === 0) break;
        parts.push(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return Buffer.concat(parts);
    } finally {
      await handle.close();
    }
  }

  function splitLines(data: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let index = data.indexOf(NEWLINE); index >= 0; index = data.indexOf(NEWLINE, start)) {
      lines.push(data.subarray(start, index).toString('utf8').replace(/\r$/, ''));
      start = index + 1;
    }
    pending = Buffer.from(data.subarray(start));
    if (dropFirstLine && lines.length > 0) {
      lines.shift();
      dropFirstLine = false;
    }
    return lines.filter((line) => line.length > 0);
  }

  return {
    path,
    async read() {
      let info;
      try {
        info = await stat(path);
      } catch (error) {
        if (isMissing(error)) return { lines: [], restarted: false, exists: false, modifiedMs: 0 };
        throw error;
      }
      const modifiedMs = info.mtimeMs;
      let restarted = false;
      if (offset === null) {
        offset = Math.max(0, info.size - (options.maxInitialBytes ?? Infinity));
        dropFirstLine = offset > 0;
      } else if (info.ino !== inode || info.size < offset) {
        offset = 0;
        pending = Buffer.alloc(0);
        dropFirstLine = false;
        restarted = true;
      }
      inode = info.ino;
      if (info.size === offset) return { lines: [], restarted, exists: true, modifiedMs };
      let chunk;
      try {
        chunk = await readRange(offset, info.size);
      } catch (error) {
        if (isMissing(error)) return { lines: [], restarted, exists: false, modifiedMs: 0 };
        throw error;
      }
      offset += chunk.length;
      return { lines: splitLines(Buffer.concat([pending, chunk])), restarted, exists: true, modifiedMs };
    },
  };
}
