import { EventEmitter } from 'events';
import * as os from 'os';
import * as net from 'net';
import { RfxcomConfig } from '../config';
import { TcpSerialPort } from './TcpSerialPort';

// lazy require so the module loads even if the stick is absent in dev
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rfxcom = require('rfxcom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SerialPort } = require('serialport');

export type RfxStatus = 'connecting' | 'ready' | 'disconnected' | 'error';

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  productId?: string;
  vendorId?: string;
}

export interface RfxcomStatusInfo {
  status: RfxStatus;
  usbport: string;
  ports: PortInfo[];
  lastError?: string;
}

interface TxItem {
  data: Buffer;
  cb?: (err?: Error | null) => void;
}

/**
 * Wraps the node-rfxcom serial connection. Opens the USB port, waits for
 * readiness and exposes RFY commands (up/down/stop/program) per device id.
 *
 * Supports hot-plugging: a watch loop polls the OS for available serial
 * ports and reconnects automatically when the configured stick appears
 * (or when the connection drops).
 */
export class RfxcomService extends EventEmitter {
  private status: RfxStatus = 'disconnected';
  private rfxtrx: any = null;
  private rfy: any = null;
  private config: RfxcomConfig;
  private lastError?: string;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private connecting = false;
  private knownPorts: PortInfo[] = [];
  // single-writer TX queue: all serial writes (bridge RFY + TCP-gateway clients)
  // are serialized here so bytes never interleave on the wire.
  private txQueue: TxItem[] = [];
  private txWriting = false;
  private rawWrite: ((data: Buffer, cb?: (err?: Error | null) => void) => void) | null = null;
  private txWrappedPorts = new Set<any>();

  constructor(config: RfxcomConfig) {
    super();
    this.config = config;
  }

  getStatus(): RfxStatus {
    return this.status;
  }

  getStatusInfo(): RfxcomStatusInfo {
    return {
      status: this.status,
      usbport: this.isTcpMode() ? `tcp://${this.config.tcpClient!.host}:${this.config.tcpClient!.port}` : this.config.usbport,
      ports: this.knownPorts,
      lastError: this.lastError,
    };
  }

  private isTcpMode(): boolean {
    return !!this.config.tcpClient?.enabled;
  }

  /**
   * Scan the local network(s) for TCP endpoints listening on `port`.
   * Enumerates non-internal IPv4 interfaces, probes every host in each /24
   * subnet and returns the IPs that accept a connection. Used to suggest
   * remote RFXCom sticks when no local USB stick is present.
   */
  async discoverTcp(port: number, timeoutMs = 250): Promise<string[]> {
    const candidates: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        const base = ni.address.split('.').slice(0, 3).join('.');
        for (let i = 1; i <= 254; i++) candidates.push(`${base}.${i}`);
      }
    }
    const queue = [...new Set(candidates)];
    const probe = (ip: string) =>
      new Promise<string | null>((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (r: string | null) => {
          if (done) return;
          done = true;
          sock.destroy();
          resolve(r);
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(ip));
        sock.once('timeout', () => finish(null));
        sock.once('error', () => finish(null));
        try {
          sock.connect(port, ip);
        } catch {
          finish(null);
        }
      });
    const results: (string | null)[] = [];
    const workers = Array.from({ length: Math.min(64, queue.length || 1) }, async () => {
      while (queue.length) {
        const ip = queue.shift()!;
        results.push(await probe(ip));
      }
    });
    await Promise.all(workers);
    return results.filter((r): r is string => r !== null);
  }

  /** Underlying serialport (used by the RFXmngr TCP gateway). */
  getSerialPort(): any {
    return this.rfxtrx ? this.rfxtrx.serialport : null;
  }

  /**
   * Enqueue raw bytes for the serial port. Both bridge RFY commands and
   * external TCP-gateway clients write through this single queue, so they can
   * be used concurrently (Web UI / Matter + RFXmngr) without byte interleaving.
   */
  enqueueWrite(data: Buffer, cb?: (err?: Error | null) => void): void {
    this.txQueue.push({ data: Buffer.from(data), cb });
    this.flushTxQueue();
  }

  private flushTxQueue(): void {
    if (this.txWriting) return;
    const item = this.txQueue.shift();
    if (!item) return;
    const serialport = this.getSerialPort();
    if (!serialport || typeof serialport.write !== 'function') {
      item.cb?.(new Error('serial port not open'));
      this.flushTxQueue();
      return;
    }
    // use the original (unwrapped) write to avoid recursion; fall back to the
    // port's own write when it was never wrapped (e.g. in tests)
    const writer = this.txWrappedPorts.has(serialport)
      ? this.rawWrite!
      : (data: Buffer, cb?: (err?: Error | null) => void) => serialport.write(data, cb);
    this.txWriting = true;
    writer(item.data, (err?: Error | null) => {
      this.txWriting = false;
      item.cb?.(err ?? null);
      this.flushTxQueue();
    });
  }

  /** Route the RfxCom serialport's writes through the shared TX queue. */
  private installTxQueue(): void {
    const serialport = this.rfxtrx?.serialport;
    if (!serialport || typeof serialport.write !== 'function' || this.txWrappedPorts.has(serialport)) return;
    const self = this;
    this.rawWrite = serialport.write.bind(serialport);
    serialport.write = (data: Buffer, cb?: (err?: Error | null) => void) => {
      self.enqueueWrite(data, cb);
      return true;
    };
    this.txWrappedPorts.add(serialport);
  }

  /** Start periodic USB hot-plug detection. */
  startWatch(intervalMs = 3000): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.scan(), intervalMs);
  }

  stopWatch(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  /** Poll OS for serial ports; (re)connect if the configured stick is present. */
  async scan(): Promise<void> {
    // TCP mode: no USB hot-plug detection; reconnect automatically when the
    // remote endpoint becomes reachable again.
    if (this.isTcpMode()) {
      if (this.status !== 'ready' && !this.connecting) {
        console.log(`[rfxcom] tcp endpoint ${this.config.tcpClient!.host}:${this.config.tcpClient!.port}, connecting...`);
        await this.connect();
      }
      return;
    }
    try {
      const ports = (await SerialPort.list()) as PortInfo[];
      this.knownPorts = ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        productId: p.productId,
        vendorId: p.vendorId,
      }));
      this.emit('ports', this.knownPorts);
      const stickPresent = this.knownPorts.some((p) => p.path === this.config.usbport);
      if (stickPresent && this.status !== 'ready' && !this.connecting) {
        console.log(`[rfxcom] stick detected on ${this.config.usbport}, connecting...`);
        await this.connect();
      }
    } catch (err) {
      console.error('[rfxcom] port scan failed:', (err as Error).message);
    }
  }

  connect(): Promise<void> {
    if (this.connecting) return Promise.resolve();
    this.connecting = true;
    return new Promise((resolve) => {
      this.status = 'connecting';
      this.lastError = undefined;
      this.emit('status', this.status);

      // dispose any previous instance before reconnecting
      this.dispose();

      if (this.isTcpMode()) {
        // remote stick over TCP: hand node-rfxcom a fake serialport backed by a
        // TCP socket instead of a local USB port
        this.rfxtrx = new rfxcom.RfxCom(
          `tcp://${this.config.tcpClient!.host}:${this.config.tcpClient!.port}`,
          {
            debug: this.config.debug,
            port: new TcpSerialPort(this.config.tcpClient!.host, this.config.tcpClient!.port),
          },
        );
        // node-rfxcom only auto-pipes the parser when it creates its own
        // serialport; with a custom `port` we must connect it ourselves.
        this.rfxtrx.serialport.pipe(this.rfxtrx.parser);
      } else {
        this.rfxtrx = new rfxcom.RfxCom(this.config.usbport, { debug: this.config.debug });
      }

      // never block startup: even if the stick is absent or no event fires,
      // resolve after a short grace period so web UI + Matter still run
      const failSafe = setTimeout(() => {
        if (this.status !== 'ready') {
          this.status = 'error';
          this.emit('status', this.status);
          this.connecting = false;
          resolve();
        }
      }, 7000);

      this.rfxtrx.on('connectfailed', (err: any) => {
        clearTimeout(failSafe);
        this.status = 'error';
        this.lastError = err?.message ?? String(err);
        this.emit('status', this.status);
        this.emit('error', err);
        // do not block startup when the stick is missing or unplugged
        this.connecting = false;
        resolve();
      });

      this.rfxtrx.on('disconnect', () => {
        clearTimeout(failSafe);
        this.status = 'disconnected';
        this.emit('status', this.status);
        this.connecting = false;
      });

      this.rfxtrx.on('ready', () => {
        clearTimeout(failSafe);
        this.rfy = new rfxcom.Rfy(this.rfxtrx, rfxcom.rfy.RFY, { venetianBlindsMode: 'EU' });
        this.status = 'ready';
        this.emit('status', this.status);
        this.connecting = false;
        resolve();
      });

      this.rfxtrx.on('error', (err: any) => {
        this.lastError = err?.message ?? String(err);
        this.emit('error', err);
      });

      this.rfxtrx.initialise();
      this.installTxQueue();
    });
  }

  private dispose(): void {
    if (this.rfxtrx) {
      try {
        this.rfxtrx.close();
      } catch {
        // ignore
      }
      this.rfxtrx = null;
      this.rfy = null;
    }
    this.rawWrite = null;
    this.txWrappedPorts.clear();
  }

  disconnect(): void {
    this.stopWatch();
    this.dispose();
    this.status = 'disconnected';
    this.emit('status', this.status);
  }

  /**
   * Sends a raw RFY command; resolves with the ack response.
   * Emits 'rfy-ack' ({ id, command, at }) when the transmitter ACKs,
   * so consumers (e.g. travel-time measurement) can start timing on the ACK.
   */
  sendRfyCommand(id: string, command: 'up' | 'down' | 'stop' | 'program'): Promise<void> {
    if (this.status !== 'ready' || !this.rfy) {
      throw new Error(`RFXCOM not ready (status: ${this.status})`);
    }
    // device ids are stored in the RFXmngr display format (e.g. "1/01/01/1",
    // hex bytes + decimal unit); node-rfxcom expects the 3-byte hex form
    // ("0x10101/1"), so convert at the transmission boundary only.
    const rfxcomId = rfxmngrToRfxcomId(id);
    return new Promise((resolve, reject) => {
      this.rfy.doCommand(rfxcomId, command, (err: any) => {
        if (err) reject(err);
        else {
          this.emit('rfy-ack', { id, command, at: Date.now() });
          resolve();
        }
      });
    });
  }
}

/**
 * Convert an RFXmngr device id ("1/01/01/1", hex bytes + decimal unit) to the
 * node-rfxcom form ("0x10101/1", 3-byte hex + unit). Already-converted ids are
 * returned unchanged.
 */
function rfxmngrToRfxcomId(id: string): string {
  const s = String(id || '');
  if (/^0x[0-9a-fA-F]{1,5}\/\d{1,2}$/.test(s)) return s;
  const m = /^(\d{1,3})\/(\d{1,3})\/(\d{1,3})\/(\d{1,2})$/.exec(s);
  if (m) {
    const id1 = parseInt(m[1], 16);
    const id2 = parseInt(m[2], 16);
    const id3 = parseInt(m[3], 16);
    const unit = parseInt(m[4], 10);
    const value = (id1 << 16) | (id2 << 8) | id3;
    return '0x' + value.toString(16) + '/' + unit;
  }
  return s;
}
