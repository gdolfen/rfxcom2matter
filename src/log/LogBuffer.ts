import { EventEmitter } from 'events';

export interface LogEntry {
  id: number;
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
}

/**
 * Ring buffer that captures console output and streams it to the web UI
 * (Logs tab). Patches console.* at attach time.
 */
export class LogBuffer extends EventEmitter {
  private entries: LogEntry[] = [];
  private max: number;
  private nextId = 1;
  private originals: Partial<Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void>> = {};
  private attached = false;

  constructor(max = 500) {
    super();
    this.max = max;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const self = this;
    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
    for (const level of levels) {
      const orig = console[level].bind(console);
      this.originals[level] = orig;
      const mapped: 'debug' | 'info' | 'warn' | 'error' = level === 'log' ? 'info' : level;
      (console as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
        orig(...args);
        self.append(mapped, args);
      };
    }
  }

  private append(level: LogEntry['level'], args: unknown[]): void {
    const raw = args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    const msg = LogBuffer.clean(raw);
    const entry: LogEntry = { id: this.nextId++, ts: Date.now(), level, msg };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    this.emit('append', entry);
  }

  /**
   * Remove ANSI color escape sequences and the Matter.js logger's own
   * "<date> <time> <LEVEL>" prefix so the captured line shows a single,
   * app-generated timestamp/level instead of a duplicated, garbled one.
   */
  private static clean(text: string): string {
    const withoutAnsi = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const withoutPrefix = withoutAnsi.replace(
      /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+/i,
      '',
    );
    return withoutPrefix;
  }

  list(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.emit('clear');
  }

  restore(): void {
    if (!this.attached) return;
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      if (this.originals[level]) (console as unknown as Record<string, unknown>)[level] = this.originals[level]!;
    }
    this.originals = {};
    this.attached = false;
  }
}
