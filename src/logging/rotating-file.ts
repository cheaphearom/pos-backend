import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'fs';
import { basename, join } from 'path';
import { pipeline } from 'stream';
import { createGzip } from 'zlib';

export interface RotatingFileOptions {
  /** Start a new file when the current one would grow past this size. */
  maxBytes?: number;
  /** Rolled files (.log.gz) kept per log; older ones are deleted. */
  maxFiles?: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Append-only log file with daily and size-based rotation, used as a pino destination.
 *
 * The active file always keeps its name (e.g. `pos-api.log`), so the ML detector can tail it.
 * Rolled files are gzipped as `pos-api.2026-11-12.1.log.gz`: the detector's live tailer ignores
 * `.log.gz` (it already read those lines), while training still reads them.
 */
export class RotatingFile {
  readonly path: string;
  private fd: number;
  private size = 0;
  private day: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(
    private readonly dir: string,
    private readonly name: string,
    opts: RotatingFileOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 14;
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${name}.log`);
    const st = existsSync(this.path) ? statSync(this.path) : null;
    this.size = st?.size ?? 0;
    this.day = day(st?.mtime ?? new Date());
    this.fd = openSync(this.path, 'a');
  }

  /** pino calls this with one serialized line (newline included). */
  write(line: string) {
    const bytes = Buffer.byteLength(line);
    const today = day(new Date());
    if (this.size > 0 && (today !== this.day || this.size + bytes > this.maxBytes)) this.rotate();
    this.day = today;
    try {
      writeSync(this.fd, line);
      this.size += bytes;
    } catch {
      /* disk full or file removed: never let logging crash the API */
    }
    return true;
  }

  private rotate() {
    try {
      closeSync(this.fd);
      let n = 1;
      while (existsSync(join(this.dir, `${this.name}.${this.day}.${n}.log.gz`)) || existsSync(join(this.dir, `${this.name}.${this.day}.${n}.rolling`))) n++;
      const rolled = join(this.dir, `${this.name}.${this.day}.${n}`);
      // Not *.log, so the detector does not read it twice while it is being compressed.
      renameSync(this.path, `${rolled}.rolling`);
      pipeline(createReadStream(`${rolled}.rolling`), createGzip(), createWriteStream(`${rolled}.log.gz`), (err) => {
        if (!err) unlinkSync(`${rolled}.rolling`);
        this.prune();
      });
    } catch {
      /* keep logging to a fresh file even if the rename failed */
    }
    this.fd = openSync(this.path, 'a');
    this.size = 0;
  }

  private prune() {
    try {
      const prefix = `${this.name}.`;
      const rolled = readdirSync(this.dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.log.gz'))
        .map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of rolled.slice(this.maxFiles)) unlinkSync(join(this.dir, basename(f)));
    } catch {
      /* ignore */
    }
  }

  close() {
    try {
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}
