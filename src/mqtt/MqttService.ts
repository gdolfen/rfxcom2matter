import * as mqtt from 'mqtt';
import { MqttConfig } from '../config';
import { DeviceManager } from '../devices/DeviceManager';
import type { SimulatedDevice } from '../devices/types';

/**
 * Optional MQTT publishing of device state + Home Assistant discovery.
 * Compatible with the original rfxcom2mqtt base_topic layout
 * (rfxcom2mqtt/devices/<id>).
 *
 * On connect it publishes a `homeassistant/cover/<id>/config` discovery
 * payload per device and subscribes to `<base>/command/rfy/<id>` so HA
 * (or any MQTT client) can drive the shutters.
 */
export class MqttService {
  private config: MqttConfig;
  private devices: DeviceManager;
  private client: mqtt.MqttClient | null = null;

  constructor(config: MqttConfig, devices: DeviceManager) {
    this.config = config;
    this.devices = devices;
  }

  connect(): void {
    if (!this.config.enabled) return;

    const opts: mqtt.IClientOptions = {};
    if (this.config.username) opts.username = this.config.username;
    if (this.config.password) opts.password = this.config.password;

    this.client = mqtt.connect(this.config.server, opts);
    this.client.on('connect', () => {
      console.log('[mqtt] connected');
      if (this.config.discovery) {
        for (const device of this.devices.list()) {
          this.publishDiscovery(device);
        }
      }
      for (const device of this.devices.list()) {
        this.publish(device);
      }
      for (const device of this.devices.list()) {
        this.client!.subscribe(`${this.config.base_topic}/command/rfy/${this.topicId(device.name)}`, (err) => {
          if (err) console.error(`[mqtt] subscribe ${device.id} failed:`, err.message);
        });
      }
    });
    this.client.on('message', (topic, payload) => this.handleMessage(topic, payload.toString()));
    this.client.on('error', (err) => console.error('[mqtt] error:', err.message));

    this.devices.on('device:update', (device) => this.publish(device));
  }

  /** publish HA cover discovery for a device (each shutter gets its own device) */
  private publishDiscovery(device: SimulatedDevice): void {
    if (!this.client) return;
    const id = this.topicId(device.name);
    const base = `${this.config.base_topic}`;
    const topic = `${this.config.discovery_topic}/cover/${id}/config`;
    const payload = {
      name: device.title,
      unique_id: `${this.config.base_topic}_${id}`,
      device_class: 'shutter',
      device: {
        identifiers: [`shutter_${id}`],
        manufacturer: 'RFXCom',
        name: device.title,
        model: 'RFXtrx433',
      },
      command_topic: `${base}/command/rfy/${id}`,
      set_position_topic: `${base}/command/rfy/${id}`,
      set_position_template: '{"command":"position","target":{{position}}}',
      position_topic: `${base}/devices/${id}`,
      position_template: '{{ value_json.position }}',
      state_topic: `${base}/devices/${id}`,
      state_value_template: '{{ value_json.ha_state }}',
      state_open: 'open',
      state_closed: 'closed',
      state_stopped: 'stopped',
      payload_open: '{"command":"open"}',
      payload_close: '{"command":"close"}',
      payload_stop: '{"command":"stop"}',
      position_open: 0,
      position_closed: 100,
      optimistic: true,
    };
    this.client.publish(topic, JSON.stringify(payload), { retain: true });
  }

  private handleMessage(topic: string, payload: string): void {
    // derive deviceId from topic: <base>/command/rfy/<topicId>
    const deviceId = this.resolveDeviceFromTopic(topic);
    if (!deviceId) return;
    let parsed: { command?: string; target?: number };
    try {
      parsed = JSON.parse(payload);
    } catch {
      // non-JSON fallback: treat raw payload as command (open/close/stop/up/down)
      const raw = payload.trim().toLowerCase();
      if (['open', 'close', 'stop', 'up', 'down'].includes(raw)) {
        this.devices.command(deviceId, raw === 'up' ? 'open' : raw === 'down' ? 'close' : raw);
      }
      return;
    }
    if (typeof parsed.target === 'number') {
      this.devices.moveTo(deviceId, Math.max(0, Math.min(100, parsed.target)));
    } else if (typeof parsed.command === 'string') {
      this.devices.command(deviceId, parsed.command === 'up' ? 'open' : parsed.command);
    }
  }

  /** map a <base>/command/rfy/<topicId> topic back to the raw device id */
  private resolveDeviceFromTopic(topic: string): string | undefined {
    const prefix = `${this.config.base_topic}/command/rfy/`;
    if (!topic.startsWith(prefix)) return undefined;
    const topicId = topic.slice(prefix.length);
    for (const device of this.devices.list()) {
      if (this.topicId(device.name) === topicId) return device.id;
    }
    return undefined;
  }

  /** sanitize device id for use in an MQTT topic segment (no '/', no '#') */
  private topicId(id: string): string {
    return id.replace(/[^a-zA-Z0-9]/g, '_');
  }

  private publish(device: { id: string; name: string; state: { position: number; state: string } }): void {
    if (!this.client || !device) return;
    const topic = `${this.config.base_topic}/devices/${this.topicId(device.name)}`;
    const state = device.state.state === 'opening' ? 'opening' : device.state.state === 'closing' ? 'closing' : 'stopped';
    const payload = JSON.stringify({
      position: Math.round(device.state.position),
      state,
      // HA cover friendly strings
      ha_state: device.state.position === 0 ? 'open' : device.state.position >= 100 ? 'closed' : state,
    });
    this.client.publish(topic, payload, { retain: true });
  }

  disconnect(): void {
    if (this.client) this.client.end(true);
  }
}