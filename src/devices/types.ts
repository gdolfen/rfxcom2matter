export type MovementState = 'idle' | 'opening' | 'closing';

export interface DeviceState {
  // 0 = fully open, 100 = fully closed
  position: number;
  state: MovementState;
  targetPosition: number | null;
}

export interface SimulatedDevice {
  id: string;
  name: string;
  title: string;
  type: string;
  subtype: string;
  /** travel time in milliseconds when opening (moving up) */
  travelTimeUp: number;
  /** travel time in milliseconds when closing (moving down) */
  travelTimeDown: number;
  /** whether position is simulated by interpolating over travelTime */
  timeBasedPosition: boolean;
  /** target position (0-100) for the shade/partial-position button */
  shadePosition: number;
  state: DeviceState;
}
