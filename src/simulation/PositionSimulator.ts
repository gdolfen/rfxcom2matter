import { SimulatedDevice } from '../devices/types';
import { EventEmitter } from 'events';

/**
 * Simulates shutter movement for devices without position feedback (RFY).
 * Position is interpolated using wall-clock time for accuracy.
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
    s.moveStartTime = Date.now();
    s.moveStartPos = s.position;
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

    const elapsed = Date.now() - s.moveStartTime;
    const distance = Math.abs(s.targetPosition - s.moveStartPos);
    const travelTimeMs = s.state === 'closing' ? device.travelTimeDown : device.travelTimeUp;
    const fraction = Math.min(1, elapsed / travelTimeMs);

    if (s.targetPosition >= s.moveStartPos) {
      s.position = s.moveStartPos + fraction * distance;
    } else {
      s.position = s.moveStartPos - fraction * distance;
    }

    if (fraction >= 1) {
      s.position = s.targetPosition;
      s.targetPosition = null;
      s.state = 'idle';
      this.stopTimer(device);
    }
    this.emit('update', device);
  }
}
