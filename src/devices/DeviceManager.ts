import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { SimulatedDevice } from './types';
import { PositionSimulator } from '../simulation/PositionSimulator';
import { DeviceConfig, BridgeConfig } from '../config';

export interface DeviceCallbacks {
  onCommand: (deviceId: string, command: string) => void;
}

interface PersistedState {
  [deviceId: string]: {
    position: number;
  };
}

/**
 * Registry of simulated devices. Loads devices from config, restores
 * last known positions from state file and delegates movement to the simulator.
 */
export class DeviceManager extends EventEmitter {
  private devices = new Map<string, SimulatedDevice>();
  private simulator: PositionSimulator;
  private stateFile: string;
  private callbacks?: DeviceCallbacks;

  constructor(simulator: PositionSimulator, stateFile: string) {
    super();
    this.simulator = simulator;
    this.stateFile = stateFile;
    this.simulator.on('update', (device: SimulatedDevice) => {
      this.emit('device:update', device);
      this.persist(device);
    });
  }

  setCallbacks(callbacks: DeviceCallbacks): void {
    this.callbacks = callbacks;
  }

  load(config: BridgeConfig): void {
    this.simulator.stopAll();
    this.devices.clear();
    const restored = this.readState();
    for (const dev of config.devices) {
      const device = this.toSimulatedDevice(dev, restored);
      this.devices.set(device.id, device);
      this.simulator.start(device);
    }
    for (const device of this.devices.values()) {
      this.emit('device:update', device);
    }
  }

  private toSimulatedDevice(cfg: DeviceConfig, restored: PersistedState): SimulatedDevice {
    const pos = restored[cfg.id]?.position ?? 0;
    const travelTimeUp = cfg.travelTimeUp ?? 6000;
    const travelTimeDown = cfg.travelTimeDown ?? 6000;
    return {
      id: cfg.id,
      name: cfg.name,
      title: cfg.title || cfg.name,
      type: cfg.type,
      subtype: cfg.subtype,
      travelTimeUp,
      travelTimeDown,
      timeBasedPosition: cfg.timeBasedPosition ?? true,
      shadePosition: cfg.shadePosition ?? 50,
      state: { position: pos, state: 'idle', targetPosition: null },
    };
  }

  list(): SimulatedDevice[] {
    return [...this.devices.values()];
  }

  get(id: string): SimulatedDevice | undefined {
    return this.devices.get(id);
  }

  command(id: string, command: string): boolean {
    const device = this.devices.get(id);
    if (!device) return false;
    this.callbacks?.onCommand(id, command);
    // when time-based positioning is disabled, send the RFY command but do not
    // animate a simulated position (there is no position feedback).
    if (!device.timeBasedPosition) {
      switch (command) {
        case 'up':
        case 'open':
        case 'down':
        case 'close':
          return true;
        case 'stop':
          this.simulator.stop(device);
          return true;
        default:
          return false;
      }
    }
    switch (command) {
      case 'up':
      case 'open':
        this.simulator.open(device);
        break;
      case 'down':
      case 'close':
        this.simulator.close(device);
        break;
      case 'stop':
        this.simulator.stop(device);
        break;
      case 'position':
        // handled via moveTo with target argument
        return false;
      default:
        return false;
    }
    return true;
  }

  /**
   * Starts the position simulation for a device WITHOUT sending a new RFY
   * command. Used by the measurement flow: the command is already transmitted,
   * and the motor only starts moving once the transmitter ACKs.
   */
  animate(id: string, command: string): boolean {
    const device = this.devices.get(id);
    if (!device) return false;
    if (!device.timeBasedPosition) return false;
    switch (command) {
      case 'up':
      case 'open':
        this.simulator.open(device);
        break;
      case 'down':
      case 'close':
        this.simulator.close(device);
        break;
      case 'stop':
        this.simulator.stop(device);
        break;
      default:
        return false;
    }
    return true;
  }

  moveTo(id: string, target: number): boolean {
    const device = this.devices.get(id);
    if (!device) return false;
    if (!device.timeBasedPosition) return false;
    const clampedTarget = Math.max(0, Math.min(100, target));
    this.callbacks?.onCommand(id, `position:${clampedTarget}`);
    this.simulator.moveTo(device, clampedTarget);
    return true;
  }

  private persist(device: SimulatedDevice): void {
    const state = this.readState();
    state[device.id] = { position: device.state.position };
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('Failed to persist state:', err);
    }
  }

  private readState(): PersistedState {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      }
    } catch {
      // ignore corrupt state file
    }
    return {};
  }
}
