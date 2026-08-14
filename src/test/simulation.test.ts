import { PositionSimulator } from '../simulation/PositionSimulator';
import { DeviceManager } from '../devices/DeviceManager';
import { BridgeConfig } from '../config';
import * as os from 'os';
import * as path from 'path';

const config: BridgeConfig = {
  loglevel: 'info',
  server: { host: '0.0.0.0', port: 0 },
  state: { file: path.join(os.tmpdir(), `rfxcom-matter-test-${Date.now()}.json`) },
  rfxcom: { usbport: '/dev/ttyUSB0', debug: false },
  matter: { enabled: false, port: 5540, discriminator: 3840, name: 'test' },
  mqtt: {
    enabled: false,
    server: '',
    base_topic: 'rfxcom2mqtt',
    username: '',
    password: '',
    discovery_topic: 'homeassistant',
    discovery: true,
  },
  ui: { theme: 'dark' },
  devices: [
    {
      id: '1/0/1/1',
      name: 'shutter_example',
      title: 'Rolladen Beispiel',
      type: 'rfy',
      subtype: 'RFY',
      travelTimeUp: 6000,
      travelTimeDown: 6000,
    },
    {
      id: '1/22/43/1',
      name: 'shutter_richtungs',
      title: 'Rolladen Richtungs',
      type: 'rfy',
      subtype: 'RFY',
      travelTimeUp: 4000,
      travelTimeDown: 10000,
    },
    {
      id: '1/0/2/1',
      name: 'shutter_manuel',
      title: 'Rolladen Manuel',
      type: 'rfy',
      subtype: 'RFY',
      travelTimeUp: 6000,
      travelTimeDown: 6000,
      timeBasedPosition: false,
    },
  ],
};

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('PASS: ' + msg);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`TIMEOUT waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main(): Promise<void> {
  const simulator = new PositionSimulator();
  const devices = new DeviceManager(simulator, config.state.file);
  devices.load(config);

  const d = devices.get('1/0/1/1')!;
  assert(d.state.position === 0, 'initial position is 0 (open)');
  assert(d.state.state === 'idle', 'initial state is idle');

  // close -> position should move towards 100 over 6 seconds
  devices.command('1/0/1/1', 'down');
  assert(d.state.state === 'closing', 'state is closing after down command');

  await waitFor(() => d.state.position > 25, 3000, 'position moving');
  const midPos = d.state.position;
  assert(midPos > 25 && midPos < 60, `mid position moving (got ${midPos})`);

  // stop freezes position
  devices.command('1/0/1/1', 'stop');
  assert(d.state.state === 'idle', 'state idle after stop');
  const frozenPos = d.state.position;
  await new Promise((r) => setTimeout(r, 500));
  assert(d.state.position === frozenPos, 'position frozen after stop');

  // moveTo 100 completes to exactly 100
  devices.moveTo('1/0/1/1', 100);
  await waitFor(() => d.state.position === 100, 5000, 'position 100');
  assert(d.state.position === 100, `position reached 100 (got ${d.state.position})`);
  assert(d.state.state === 'idle', 'idle after reaching target');

  // moveTo partial (60) -> opens from 100 down to 60 (4s travel)
  devices.moveTo('1/0/1/1', 60);
  await waitFor(() => Math.round(d.state.position) === 60, 5000, 'position 60');
  assert(Math.round(d.state.position) === 60, `position reached 60 (got ${d.state.position})`);

  // ---- direction-dependent travel times ----
  const rd = devices.get('1/22/43/1')!;
  assert(rd.travelTimeUp === 4000, 'travelTimeUp resolved from config');
  assert(rd.travelTimeDown === 10000, 'travelTimeDown resolved from config');
  // ensure the device is fully closed so both directions have room to move
  devices.moveTo('1/22/43/1', 100);
  await waitFor(() => rd.state.position === 100, 15000, 'rd at 100');
  // opening uses travelTimeUp=4 (fast): ~25 units per second
  devices.command('1/22/43/1', 'up');
  await new Promise((r) => setTimeout(r, 1000));
  const openDist = 100 - rd.state.position;
  devices.command('1/22/43/1', 'stop');
  // closing uses travelTimeDown=10 (slow): ~10 units per second
  devices.command('1/22/43/1', 'down');
  await new Promise((r) => setTimeout(r, 1000));
  const closedDist = rd.state.position - (100 - openDist);
  devices.command('1/22/43/1', 'stop');
  assert(openDist > closedDist, `opening faster than closing (open ${openDist.toFixed(1)} vs close ${closedDist.toFixed(1)})`);

  // ---- timeBasedPosition:false device ----
  const m = devices.get('1/0/2/1')!;
  assert(m.timeBasedPosition === false, 'device flags timeBasedPosition=false');
  // moveTo is unsupported without time-based positioning
  assert(devices.moveTo('1/0/2/1', 50) === false, 'moveTo rejected when timeBasedPosition=false');
  // up/down still accepted (RFY sent), but position does not animate
  const before = m.state.position;
  devices.command('1/0/2/1', 'down');
  assert(m.state.state === 'idle' || m.state.state === 'closing', 'command down accepted');
  await new Promise((r) => setTimeout(r, 400));
  assert(m.state.position === before, 'position frozen when timeBasedPosition=false');
  // stop accepted
  assert(devices.command('1/0/2/1', 'stop') === true, 'stop accepted when timeBasedPosition=false');

  simulator.stopAll();
  console.log('\nALL TESTS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
