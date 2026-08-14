import { EventEmitter } from 'events';
import * as net from 'net';

/**
 * SerialPort-compatible wrapper over a TCP connection, used to talk to an
 * RFXCom stick that is attached to a REMOTE machine (instead of a local USB
 * port). node-rfxcom accepts a fake "serialport" via `options.port`, so the
 * bridge can open the stick over plain TCP.
 *
 * On the remote side any serial-to-TCP bridge works, e.g.:
 *   socat -d -d PTY,link=/dev/ttyUSB0,raw,echo=0 TCP-LISTEN:10002,fork
 * or the bridge's own RFXmngr gateway (default 10001).
 */
export class TcpSerialPort extends EventEmitter {
  private socket: net.Socket | null = null;
  private parser: NodeJS.WritableStream | null = null;
  private host: string;
  private port: number;

  constructor(host: string, port: number) {
    super();
    this.host = host;
    this.port = port;
  }

  get isOpen(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  /** node-rfxcom pipes the incoming bytes into its packet parser. */
  pipe(parser: NodeJS.WritableStream): NodeJS.WritableStream {
    this.parser = parser;
    if (this.socket) this.socket.pipe(parser);
    return parser;
  }

  /** Connect the underlying TCP socket; emits 'open' once established. */
  open(): void {
    if (this.isOpen) {
      this.emit('open');
      return;
    }
    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on('connect', () => {
      if (this.parser) socket.pipe(this.parser);
      this.emit('open');
    });

    socket.on('data', (data: Buffer) => {
      this.emit('data', data);
    });

    socket.on('error', (err) => {
      this.emit('error', err);
    });

    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.emit('close', { disconnected: true });
    });
  }

  write(buffer: Buffer, cb?: (err?: Error | null) => void): boolean {
    if (!this.isOpen || !this.socket) {
      cb?.(new Error('TCP connection not open'));
      return false;
    }
    return this.socket.write(buffer, (err) => cb?.(err ?? null));
  }

  flush(cb?: (err?: Error | null) => void): void {
    cb?.(null);
  }

  close(cb?: (err?: Error | null) => void): void {
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.removeAllListeners('error');
      socket.destroy();
    }
    cb?.(null);
  }

  destroy(): void {
    this.close();
  }
}