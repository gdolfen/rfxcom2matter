import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as QRCode from 'qrcode';
import { DeviceManager } from '../devices/DeviceManager';
import { RfxcomService } from '../rfxcom/RfxcomService';
import { LogBuffer, LogEntry } from '../log/LogBuffer';
import { getVersion } from '../version';
import {
  ServerConfig,
  BridgeConfig,
  loadConfig,
  mergeConfig,
  serializeConfig,
  validateConfig,
} from '../config';

export interface WebServerOptions {
  configPath?: string;
  onConfigSaved?: () => void | Promise<void>;
  logs?: LogBuffer;
}

/** Travel-time measurement state (timer starts on transmitter ACK). */
export interface MeasureState {
  deviceId: string | null;
  command: 'up' | 'down' | null;
  /** true between start and the moment the transmitter ACK arrives */
  waitingForAck: boolean;
  startedAt: number | null;
  stoppedAt: number | null;
  durationMs: number | null;
  /** server epoch ms at the moment the state was produced (for clock sync) */
  serverNow: number;
}

export class WebServer {
  private app: express.Application;
  private server: http.Server;
  private io: SocketIOServer;
  private devices: DeviceManager;
  private rfxcom: RfxcomService;
  private pairingCode: string | null = null;
  private qrCode: string | null = null;
  private port: number;
  private configPath?: string;
  private onConfigSaved?: () => void | Promise<void>;
  private logs?: LogBuffer;
  private measure: MeasureState = {
    deviceId: null,
    command: null,
    waitingForAck: false,
    startedAt: null,
    stoppedAt: null,
    durationMs: null,
    serverNow: 0,
  };
  private measureAckTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ServerConfig, devices: DeviceManager, rfxcom: RfxcomService, options: WebServerOptions = {}) {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new SocketIOServer(this.server, { cors: { origin: '*' } });
    this.devices = devices;
    this.rfxcom = rfxcom;
    this.port = config.port;
    this.configPath = options.configPath;
    this.onConfigSaved = options.onConfigSaved;
    this.logs = options.logs;
    this.setupRoutes();
    this.setupSocket();
    this.devices.on('device:update', () => this.emitDevices());
    this.rfxcom.on('status', () => this.emitRfxcomStatus());
    this.rfxcom.on('ports', () => this.emitRfxcomStatus());
    // travel-time measurement: the timer starts exactly when the transmitter
    // acknowledges the RFY command (ack packet 0x02).
    this.rfxcom.on('rfy-ack', ({ id }: { id: string }) => this.onRfyAck(id));
    if (this.logs) this.logs.on('append', (entry: LogEntry) => this.emitLog(entry));
    void config;
  }

  /** Returns a copy of the current measurement state. */
  getMeasureState(): MeasureState {
    return { ...this.measure, serverNow: Date.now() };
  }

  private onRfyAck(deviceId: string): void {
    if (!this.measure.deviceId || this.measure.deviceId !== deviceId) return;
    if (this.measure.waitingForAck && this.measure.startedAt === null) {
      this.measure.startedAt = Date.now();
      this.measure.waitingForAck = false;
      if (this.measureAckTimeout) {
        clearTimeout(this.measureAckTimeout);
        this.measureAckTimeout = null;
      }
      // the motor only actually starts moving once the transmitter ACKs, so
      // start the position simulation here (not when the command was sent)
      if (this.measure.command) this.devices.animate(deviceId, this.measure.command);
      console.log(`[web] measurement for ${deviceId} started (ACK received)`);
      this.emitMeasure();
    }
  }

  private emitMeasure(): void {
    this.io.emit('measure', this.getMeasureState());
  }

  /**
   * Starts a travel-time measurement for a device: sends the RFY command and
   * arms the timer. The timer (and the position simulation) only start once
   * the transmitter ACKs, so the measured duration reflects real travel time.
   */
  async startMeasure(deviceId: string, command: 'up' | 'down'): Promise<MeasureState | null> {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    if (this.measureAckTimeout) {
      clearTimeout(this.measureAckTimeout);
      this.measureAckTimeout = null;
    }
    this.measure = {
      deviceId,
      command,
      waitingForAck: true,
      startedAt: null,
      stoppedAt: null,
      durationMs: null,
      serverNow: Date.now(),
    };
    // safety net: if the ACK never arrives (stick absent/not ready), reset the timer
    this.measureAckTimeout = setTimeout(() => {
      if (this.measure.waitingForAck) {
        this.measure.waitingForAck = false;
        console.log(`[web] measurement for ${deviceId} timed out waiting for ACK`);
        this.emitMeasure();
      }
    }, 5000);
    // send the RFY command directly (no simulation yet - it starts on ACK)
    try {
      this.rfxcom.sendRfyCommand(deviceId, command).catch((err) => {
        console.error(`[web] measurement RFY ${command} to ${deviceId} failed:`, err?.message ?? err);
      });
    } catch (err) {
      console.error(`[web] measurement RFY ${command} to ${deviceId} failed:`, (err as Error)?.message ?? err);
    }
    this.emitMeasure();
    return this.getMeasureState();
  }

  /**
   * Stops the running measurement and returns the measured duration in ms.
   * Does not send a stop command to the device (the user may want the shutter
   * to keep moving, e.g. while measuring a full travel time).
   */
  stopMeasure(deviceId: string): MeasureState | null {
    if (!this.measure.deviceId || this.measure.deviceId !== deviceId) return null;
    // only a measurement that is waiting for ACK or currently running can be stopped
    if (!this.measure.waitingForAck && (this.measure.startedAt === null || this.measure.stoppedAt !== null)) {
      return null;
    }
    if (this.measureAckTimeout) {
      clearTimeout(this.measureAckTimeout);
      this.measureAckTimeout = null;
    }
    if (this.measure.startedAt !== null && this.measure.stoppedAt === null) {
      this.measure.stoppedAt = Date.now();
      this.measure.durationMs = this.measure.stoppedAt - this.measure.startedAt;
      console.log(
        `[web] measurement for ${deviceId} stopped: ${this.measure.durationMs} ms (${(this.measure.durationMs / 1000).toFixed(2)} s)`,
      );
    }
    this.measure.waitingForAck = false;
    this.emitMeasure();
    return this.getMeasureState();
  }

  /** Cancels / resets the current measurement. */
  resetMeasure(deviceId: string | null): void {
    if (deviceId && this.measure.deviceId && this.measure.deviceId !== deviceId) return;
    if (this.measureAckTimeout) {
      clearTimeout(this.measureAckTimeout);
      this.measureAckTimeout = null;
    }
    this.measure = {
      deviceId: null,
      command: null,
      waitingForAck: false,
      startedAt: null,
      stoppedAt: null,
      durationMs: null,
      serverNow: Date.now(),
    };
    this.emitMeasure();
  }

  setPairingCode(code: string | null, qr?: string | null): void {
    this.pairingCode = code;
    this.qrCode = qr ?? null;
    if (this.io) this.io.emit('pairing-code', { available: !!code });
  }

  private loadConfigObject(): BridgeConfig | null {
    if (!this.configPath) return null;
    try {
      return loadConfig(this.configPath);
    } catch (err) {
      console.error('[web] failed to load config:', (err as Error).message);
      return null;
    }
  }

  /** Resolve a project-root file regardless of the compiled module's depth. */
  private resolveProjectFile(name: string): string | null {
    let dir = __dirname;
    for (;;) {
      const f = path.join(dir, name);
      if (fs.existsSync(f)) return f;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const base of [process.cwd(), '/app']) {
      const f = path.join(base, name);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    this.app.get('/api/devices', (_req, res) => {
      res.json(this.devices.list());
    });

    this.app.post('/api/devices/:id/command', (req, res) => {
      const { command } = req.body as { command?: string };
      if (!command) {
        res.status(400).json({ error: 'command is required' });
        return;
      }
      const ok = this.devices.command(req.params.id, command);
      if (!ok) {
        res.status(404).json({ error: 'device not found or invalid command' });
        return;
      }
      res.json({ ok: true });
    });

    this.app.post('/api/devices/:id/position', (req, res) => {
      const target = Number(req.body?.target);
      if (Number.isNaN(target) || target < 0 || target > 100) {
        res.status(400).json({ error: 'target must be a number 0-100' });
        return;
      }
      const ok = this.devices.moveTo(req.params.id, target);
      if (!ok) {
        res.status(404).json({ error: 'device not found' });
        return;
      }
      res.json({ ok: true });
    });

    // travel-time measurement
    this.app.get('/api/measure', (_req, res) => {
      res.json(this.getMeasureState());
    });

    this.app.post('/api/devices/:id/measure/start', async (req, res) => {
      const { command } = req.body as { command?: string };
      if (command !== 'up' && command !== 'down') {
        res.status(400).json({ error: 'command must be "up" or "down"' });
        return;
      }
      const state = await this.startMeasure(req.params.id, command);
      if (!state) {
        res.status(404).json({ error: 'device not found' });
        return;
      }
      res.json(state);
    });

    this.app.post('/api/devices/:id/measure/stop', (req, res) => {
      const state = this.stopMeasure(req.params.id);
      if (!state) {
        res.status(404).json({ error: 'no active measurement for this device' });
        return;
      }
      res.json(state);
    });

    this.app.delete('/api/devices/:id/measure', (req, res) => {
      this.resetMeasure(req.params.id);
      res.json({ ok: true });
    });

    this.app.get('/api/rfxcom/status', (_req, res) => {
      res.json(this.rfxcom.getStatusInfo());
    });

    // scan the local network for TCP endpoints listening on the given port
    // (used to suggest remote RFXCom sticks when no USB stick is present)
    this.app.get('/api/rfxcom/discover-tcp', async (req, res) => {
      const port = Number(req.query.port) || 10001;
      try {
        const hosts = await this.rfxcom.discoverTcp(port);
        res.json({ port, hosts });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // manual reconnect trigger (useful after hot-plug edge cases)
    this.app.post('/api/rfxcom/reconnect', async (_req, res) => {
      await this.rfxcom.scan();
      if (this.rfxcom.getStatus() !== 'ready') {
        await this.rfxcom.connect();
      }
      res.json({ status: this.rfxcom.getStatus() });
    });

    this.app.get('/api/logs', (_req, res) => {
      res.json({ logs: this.logs ? this.logs.list() : [] });
    });

    this.app.get('/api/version', (_req, res) => {
      res.json({ version: getVersion() });
    });

    this.app.get('/api/release-notes', (_req, res) => {
      const file = this.resolveProjectFile('RELEASE-NOTES.md');
      if (!file) {
        res.status(404).json({ error: 'release notes not available' });
        return;
      }
      try {
        const content = fs.readFileSync(file, 'utf8');
        res.type('text/markdown').send(content);
      } catch (err) {
        res.status(404).json({ error: 'release notes not available' });
      }
    });

    this.app.delete('/api/logs', (_req, res) => {
      this.logs?.clear();
      res.json({ ok: true });
    });

    this.app.get('/api/pairing-code', async (_req, res) => {
      let qrDataUrl: string | null = null;
      if (this.qrCode) {
        try {
          qrDataUrl = await QRCode.toDataURL(this.qrCode, { width: 220, margin: 1 });
        } catch (err) {
          console.error('[web] QR generation failed:', (err as Error).message);
        }
      }
      res.json({
        pairingCode: this.pairingCode ?? null,
        qrCode: this.qrCode ?? null,
        qrImage: qrDataUrl,
        status: 'online',
      });
    });

    // config editor: read + write config.yml
    this.app.get('/api/config', (_req, res) => {
      if (!this.configPath) {
        res.status(404).json({ error: 'config file not configured' });
        return;
      }
      try {
        const content = fs.readFileSync(this.configPath, 'utf8');
        res.json({ config: content });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.put('/api/config', async (req, res) => {
      if (!this.configPath) {
        res.status(404).json({ error: 'config file not configured' });
        return;
      }
      const { config } = req.body as { config?: string };
      if (typeof config !== 'string') {
        res.status(400).json({ error: 'config must be a string' });
        return;
      }
      // validate before persisting
      try {
        yaml.load(config);
      } catch (err) {
        res.status(400).json({ error: `invalid YAML: ${(err as Error).message}` });
        return;
      }
      try {
        fs.writeFileSync(this.configPath, config, 'utf8');
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
        return;
      }
      try {
        await this.onConfigSaved?.();
      } catch (err) {
        console.error('[web] config reload failed:', err);
        res.json({ ok: true, reloadError: (err as Error).message });
        return;
      }
      res.json({ ok: true });
    });

    // structured config for the visual tabs
    this.app.get('/api/config/json', (_req, res) => {
      const cfg = this.loadConfigObject();
      if (!cfg) {
        res.status(500).json({ error: 'config file not available' });
        return;
      }
      res.json(cfg);
    });

    this.app.put('/api/config/json', async (req, res) => {
      if (!this.configPath) {
        res.status(404).json({ error: 'config file not configured' });
        return;
      }
      const current = this.loadConfigObject();
      if (!current) {
        res.status(500).json({ error: 'config file not available' });
        return;
      }
      const partial = req.body as Partial<BridgeConfig>;
      const merged = mergeConfig(current, partial);
      const validation = validateConfig(merged);
      if (!validation.ok) {
        res.status(400).json({ error: validation.errors.join('; ') });
        return;
      }
      try {
        fs.writeFileSync(this.configPath, serializeConfig(merged), 'utf8');
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
        return;
      }
      try {
        await this.onConfigSaved?.();
      } catch (err) {
        console.error('[web] config reload failed:', err);
        res.json({ ok: true, reloadError: (err as Error).message });
        return;
      }
      res.json({ ok: true });
    });

    // static frontend
    const frontendDir = path.join(__dirname, '../../frontend');
    this.app.use(express.static(frontendDir));
  }

  private setupSocket(): void {
    this.io.on('connection', (socket) => {
      socket.emit('devices', this.devices.list());
      socket.emit('rfxcom-status', this.rfxcom.getStatusInfo());
      socket.emit('measure', this.getMeasureState());
      if (this.logs) socket.emit('logs', this.logs.list());
    });
  }

  /** Broadcast device state changes (called by DeviceManager bridge) */
  emitDevices(): void {
    this.io.emit('devices', this.devices.list());
  }

  private emitRfxcomStatus(): void {
    this.io.emit('rfxcom-status', this.rfxcom.getStatusInfo());
  }

  private emitLog(entry: LogEntry): void {
    this.io.emit('log', entry);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[web] listening on http://0.0.0.0:${this.port}`);
        resolve();
      });
    });
  }
}