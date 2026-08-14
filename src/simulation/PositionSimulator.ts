import { SimulatedDevice } from '../devices/types';
import { EventEmitter } from 'events';

/**
 * Simulates shutter movement for devices without position feedback (RFY).
 * Position is interpolated linearly over the travel time (in milliseconds).
 * 0 = fully open, 100 = fully closed.
 */
export class PositionSimulator extends EventEmitter {
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  start(device: SimulatedDevice): void {
    if (this.timers.has(device.id)) return;
    this.timers.set(device.id, setInterval(() => this.tick(device), 100));
  }

  private stopTimer(device: SimulatedDevice): void {
    const timer = this.timers.get(device.id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(device.id);
    }
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  moveTo(device: SimulatedDevice, target: number): void {
    const s = device.state;
    s.targetPosition = Math.max(0, Math.min(100, target));
    s.state = s.targetPosition > s.position ? 'closing' : s.targetPosition < s.position ? 'opening' : 'idle';
    this.start(device);
    this.emit('update', device);
  }

  /** Send up/stop/down commands typical for RFY remotes */
  open(device: SimulatedDevice): void {
    this.moveTo(device, 0);
  }

  close(device: SimulatedDevice): void {
    this.moveTo(device, 100);
  }

  stop(device: SimulatedDevice): void {
    const s = device.state;
    s.state = 'idle';
    s.targetPosition = null;
    this.stopTimer(device);
    this.emit('update', device);
  }

  private tick(device: SimulatedDevice): void {
    const s = device.state;
    if (s.state === 'idle' || s.targetPosition === null) return;

    const diff = s.targetPosition - s.position;
    // direction-dependent travel time (in ms): closing uses travelTimeDown, opening travelTimeUp
    const travelTimeMs = s.state === 'closing' ? device.travelTimeDown : device.travelTimeUp;
    const step = 10000 / travelTimeMs; // units per 100ms tick

    if (Math.abs(diff) <= step) {
      s.position = s.targetPosition;
      s.targetPosition = null;
      s.state = 'idle';
      this.stopTimer(device);
    } else {
      s.position += Math.sign(diff) * step;
    }
    this.emit('update', device);
  }
}
