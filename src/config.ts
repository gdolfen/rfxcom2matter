import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface DeviceConfig {
  id: string;
  name: string;
  title?: string;
  type: string;
  subtype: string;
  /** travel time in milliseconds when opening (moving up) */
  travelTimeUp?: number;
  /** travel time in milliseconds when closing (moving down) */
  travelTimeDown?: number;
  /** target position (0-100) used by the "shade" / partial-position button */
  shadePosition?: number;
  /**
   * Whether position is estimated by interpolating over travelTime (default
   * true). When false, up/down/stop are sent but position is not simulated
   * and partial-position (moveTo) commands are not supported.
   */
  timeBasedPosition?: boolean;
}

export interface RfxcomConfig {
  usbport: string;
  debug: boolean;
  tcp?: TcpGatewayConfig;
  /** connect to a remote stick over TCP instead of the local USB port */
  tcpClient?: TcpClientConfig;
}

export interface TcpGatewayConfig {
  enabled: boolean;
  port: number;
}

export interface TcpClientConfig {
  enabled: boolean;
  host: string;
  port: number;
}

const DEFAULT_TCP_GATEWAY: TcpGatewayConfig = { enabled: false, port: 10001 };
const DEFAULT_TCP_CLIENT: TcpClientConfig = { enabled: false, host: '', port: 10001 };

/**
 * Data directory that holds the runtime config.yml and state.json. In the
 * Docker image this is `/app/data` (mounted as a volume); for local runs it is
 * resolved relative to the current working directory.
 */
export const DATA_DIR = process.env.RFXCOM_DATA_DIR || path.join(process.cwd(), 'data');
/** Default location of config.yml (overridable via RFXCOM_CONFIG). */
export const DEFAULT_CONFIG_PATH = process.env.RFXCOM_CONFIG || path.join(DATA_DIR, 'config.yml');

export interface MatterConfig {
  enabled: boolean;
  port: number;
  discriminator: number;
  name: string;
}

export interface MqttConfig {
  enabled: boolean;
  server: string;
  base_topic: string;
  username: string;
  password: string;
  discovery_topic: string;
  discovery: boolean;
}

export interface UiConfig {
  /** color theme of the web UI */
  theme: 'dark' | 'light';
}

export interface ServerConfig {
  host: string;
  port: number;
}

export interface StateConfig {
  file: string;
}

export interface BridgeConfig {
  loglevel: string;
  server: ServerConfig;
  state: StateConfig;
  rfxcom: RfxcomConfig;
  matter: MatterConfig;
  mqtt: MqttConfig;
  ui: UiConfig;
  devices: DeviceConfig[];
}

const DEFAULT_CONFIG: BridgeConfig = {
  loglevel: 'info',
  server: { host: '0.0.0.0', port: 3000 },
  state: { file: path.join(DATA_DIR, 'state.json') },
  rfxcom: { usbport: '/dev/ttyUSB0', debug: false, tcp: DEFAULT_TCP_GATEWAY, tcpClient: DEFAULT_TCP_CLIENT },
  matter: { enabled: false, port: 5540, discriminator: 3840, name: 'RFXCom2Matter' },
  mqtt: {
    enabled: false,
    server: 'tcp://localhost:1883',
    base_topic: 'rfxcom2mqtt',
    username: '',
    password: '',
    discovery_topic: 'homeassistant',
    discovery: false,
  },
  ui: { theme: 'dark' },
  devices: [],
};

/**
 * Locate a documented reference config (`config.example.yml`) used as a
 * template when no config.yml exists yet. Searched in the working directory and
 * next to the compiled binary so it works for both local runs and the image.
 */
function findExampleConfig(): string | null {
  const candidates = [
    process.env.RFXCOM_CONFIG_EXAMPLE,
    path.join(process.cwd(), 'config.example.yml'),
    path.join(__dirname, '..', '..', 'config.example.yml'),
  ].filter((c): c is string => typeof c === 'string');
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
    } catch {
      // ignore unreadable candidate
    }
  }
  return null;
}

export function loadConfig(configPath?: string): BridgeConfig {
  // Search order for an existing config:
  //   1. explicit argument
  //   2. RFXCOM_CONFIG env
  //   3. <data-dir>/config.yml  and  <data-dir>/config.yaml
  //   4. <cwd>/config.yml       and  <cwd>/config.yaml   (local runs / bind mounts)
  const candidates = [
    configPath,
    process.env.RFXCOM_CONFIG,
    path.join(DATA_DIR, 'config.yml'),
    path.join(DATA_DIR, 'config.yaml'),
    path.join(process.cwd(), 'config.yml'),
    path.join(process.cwd(), 'config.yaml'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const existing = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  // Canonical location the bridge writes to (UI saves land here).
  const target = configPath || process.env.RFXCOM_CONFIG || path.join(DATA_DIR, 'config.yml');

  if (existing) {
    // If a config was found outside the data dir (e.g. repo-root ./config.yml)
    // and the data dir has none yet, seed it so edits persist in the volume.
    if (existing !== target && !fs.existsSync(target)) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(existing, target);
      } catch {
        // seeding is best-effort
      }
    }
    console.log(`[core] using config at ${existing}`);
  } else {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch {
      // directory may already exist
    }
    const template = findExampleConfig();
    const content =
      template ??
      '# RFXCom2Matter configuration (auto-generated defaults — everything disabled)\n' +
        serializeConfig(DEFAULT_CONFIG);
    fs.writeFileSync(target, content);
    console.log(`[core] no config found, created default config at ${target}`);
  }

  const resolved = existing || target;
  const loaded = yaml.load(fs.readFileSync(resolved, 'utf8')) as Partial<BridgeConfig>;
  const config: BridgeConfig = {
    ...DEFAULT_CONFIG,
    ...loaded,
    server: { ...DEFAULT_CONFIG.server, ...(loaded.server || {}) },
    state: { ...DEFAULT_CONFIG.state, ...(loaded.state || {}) },
    rfxcom: {
      ...DEFAULT_CONFIG.rfxcom,
      ...(loaded.rfxcom || {}),
      tcp: {
        enabled: (loaded.rfxcom?.tcp?.enabled ?? DEFAULT_TCP_GATEWAY.enabled),
        port: loaded.rfxcom?.tcp?.port ?? DEFAULT_TCP_GATEWAY.port,
      },
      tcpClient: {
        enabled: (loaded.rfxcom?.tcpClient?.enabled ?? DEFAULT_TCP_CLIENT.enabled),
        host: loaded.rfxcom?.tcpClient?.host ?? DEFAULT_TCP_CLIENT.host,
        port: loaded.rfxcom?.tcpClient?.port ?? DEFAULT_TCP_CLIENT.port,
      },
    },
    matter: { ...DEFAULT_CONFIG.matter, ...(loaded.matter || {}) },
    mqtt: { ...DEFAULT_CONFIG.mqtt, ...(loaded.mqtt || {}) },
    ui: { ...DEFAULT_CONFIG.ui, ...(loaded.ui || {}) },
    devices: loaded.devices || [],
  };
  return config;
}

export interface ConfigValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validate a config object; returns ok=false with human-readable errors. */
export function validateConfig(config: unknown): ConfigValidationResult {
  const errors: string[] = [];
  const c = config as Partial<BridgeConfig>;

  if (c.server && typeof c.server === 'object') {
    if (c.server.host !== undefined && typeof c.server.host !== 'string') errors.push('server.host muss ein String sein');
    if (c.server.port !== undefined && (typeof c.server.port !== 'number' || c.server.port <= 0)) {
      errors.push('server.port muss eine positive Zahl sein');
    }
  }
  if (c.rfxcom && typeof c.rfxcom === 'object') {
    if (c.rfxcom.usbport !== undefined && typeof c.rfxcom.usbport !== 'string') errors.push('rfxcom.usbport muss ein String sein');
    if (c.rfxcom.tcp && typeof c.rfxcom.tcp === 'object') {
      if (c.rfxcom.tcp.port !== undefined && (typeof c.rfxcom.tcp.port !== 'number' || c.rfxcom.tcp.port <= 0)) {
        errors.push('rfxcom.tcp.port muss eine positive Zahl sein');
      }
    }
    if (c.rfxcom.tcpClient && typeof c.rfxcom.tcpClient === 'object') {
      if (c.rfxcom.tcpClient.host !== undefined && typeof c.rfxcom.tcpClient.host !== 'string') {
        errors.push('rfxcom.tcpClient.host muss ein String sein');
      }
      if (c.rfxcom.tcpClient.port !== undefined && (typeof c.rfxcom.tcpClient.port !== 'number' || c.rfxcom.tcpClient.port <= 0)) {
        errors.push('rfxcom.tcpClient.port muss eine positive Zahl sein');
      }
    }
  }
  if (c.matter && typeof c.matter === 'object') {
    if (c.matter.port !== undefined && (typeof c.matter.port !== 'number' || c.matter.port <= 0)) {
      errors.push('matter.port muss eine positive Zahl sein');
    }
    if (c.matter.discriminator !== undefined && (typeof c.matter.discriminator !== 'number' || c.matter.discriminator < 0 || c.matter.discriminator > 4095)) {
      errors.push('matter.discriminator muss 0-4095 sein');
    }
  }
  if (c.mqtt && typeof c.mqtt === 'object') {
    if (c.mqtt.server !== undefined && typeof c.mqtt.server !== 'string') errors.push('mqtt.server muss ein String sein');
    if (c.mqtt.discovery_topic !== undefined && typeof c.mqtt.discovery_topic !== 'string') {
      errors.push('mqtt.discovery_topic muss ein String sein');
    }
  }
  if (c.ui && typeof c.ui === 'object') {
    if (c.ui.theme !== undefined && c.ui.theme !== 'dark' && c.ui.theme !== 'light') {
      errors.push('ui.theme muss "dark" oder "light" sein');
    }
  }
  if (!Array.isArray(c.devices)) {
    errors.push('devices muss eine Liste sein');
  } else {
    c.devices.forEach((d, i) => {
      const dev = d as Partial<DeviceConfig>;
      if (!dev.id || typeof dev.id !== 'string') errors.push(`devices[${i}].id fehlt`);
      if (!dev.name || typeof dev.name !== 'string') errors.push(`devices[${i}].name fehlt`);
      if (dev.travelTimeUp !== undefined && (typeof dev.travelTimeUp !== 'number' || dev.travelTimeUp <= 0)) {
        errors.push(`devices[${i}].travelTimeUp muss eine positive Zahl sein`);
      }
      if (dev.travelTimeDown !== undefined && (typeof dev.travelTimeDown !== 'number' || dev.travelTimeDown <= 0)) {
        errors.push(`devices[${i}].travelTimeDown muss eine positive Zahl sein`);
      }
      if (dev.timeBasedPosition !== undefined && typeof dev.timeBasedPosition !== 'boolean') {
        errors.push(`devices[${i}].timeBasedPosition muss ein Boolean sein`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

/** Merge a partial config onto loaded defaults and return a full config. */
export function mergeConfig(current: BridgeConfig, partial: Partial<BridgeConfig>): BridgeConfig {
  const server = { ...current.server, ...(partial.server || {}) };
  const state = { ...current.state, ...(partial.state || {}) };
  const rfxcom: RfxcomConfig = {
    ...current.rfxcom,
    ...(partial.rfxcom || {}),
    tcp: {
      enabled: partial.rfxcom?.tcp?.enabled ?? current.rfxcom.tcp?.enabled ?? DEFAULT_TCP_GATEWAY.enabled,
      port: partial.rfxcom?.tcp?.port ?? current.rfxcom.tcp?.port ?? DEFAULT_TCP_GATEWAY.port,
    },
    tcpClient: {
      enabled: partial.rfxcom?.tcpClient?.enabled ?? current.rfxcom.tcpClient?.enabled ?? DEFAULT_TCP_CLIENT.enabled,
      host: partial.rfxcom?.tcpClient?.host ?? current.rfxcom.tcpClient?.host ?? DEFAULT_TCP_CLIENT.host,
      port: partial.rfxcom?.tcpClient?.port ?? current.rfxcom.tcpClient?.port ?? DEFAULT_TCP_CLIENT.port,
    },
  };
  const matter = { ...current.matter, ...(partial.matter || {}) };
  const mqtt = { ...current.mqtt, ...(partial.mqtt || {}) };
  const ui = { ...current.ui, ...(partial.ui || {}) };
  const devices = Array.isArray(partial.devices) ? partial.devices : current.devices;
  return { ...current, ...partial, server, state, rfxcom, matter, mqtt, ui, devices };
}

/** Serialize a config object back to YAML for persistence. */
export function serializeConfig(config: BridgeConfig): string {
  const doc: Record<string, unknown> = {
    loglevel: config.loglevel,
    server: config.server,
    state: config.state,
    rfxcom: config.rfxcom,
    matter: config.matter,
    mqtt: config.mqtt,
    ui: config.ui,
    devices: config.devices,
  };
  const header = '# RFXCom2Matter configuration (edited via web UI)\n';
  return header + yaml.dump(doc, { noRefs: true });
}
