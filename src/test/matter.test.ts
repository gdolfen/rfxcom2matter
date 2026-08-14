import { PositionSimulator } from '../simulation/PositionSimulator';
import { DeviceManager } from '../devices/DeviceManager';
import { MatterBridge } from '../matter/MatterBridge';
import { BridgeConfig } from '../config';
import * as os from 'os';
import * as path from 'path';

const config: BridgeConfig = {
  loglevel: 'info',
  server: { host: '0.0.0.0', port: 0 },
  state: { file: path.join(os.tmpdir(), `rfxcom2matter-test-${Date.now()}.json`) },
  rfxcom: { usbport: '/dev/ttyUSB0', debug: false },
  matter: { enabled: true, port: 5541, discriminator: 3840, name: 'RFXCom2Matter-Test' },
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
    { id: '1/0/1/1', name: 'shutter_example', title: 'Rolladen Beispiel', type: 'rfy', subtype: 'RFY', travelTimeUp: 6000, travelTimeDown: 6000 },
  ],
};

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('PASS: ' + msg);
}

async function main(): Promise<void> {
  const simulator = new PositionSimulator();
  const devices = new DeviceManager(simulator, config.state.file);
  devices.load(config);

  const bridge = new MatterBridge(config.matter, devices);
  const pairing = await bridge.start();
  assert(!!pairing && pairing.manual.length > 0, `manual pairing code generated (${pairing?.manual})`);
  assert(!!pairing && pairing.qr.startsWith('MT:'), 'QR pairing code generated');

  // give the bridge a moment to advertise
  await new Promise((r) => setTimeout(r, 2000));
  console.log('[test] bridge advertising, waiting for shutdown');
  await bridge.stop();
  console.log('\nALL MATTER BRIDGE TESTS PASSED');
  simulator.stopAll();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
