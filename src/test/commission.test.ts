import { ServerNode } from '@matter/main';
import { Seconds } from '@matter/general';
import { PositionSimulator } from '../simulation/PositionSimulator';
import { DeviceManager } from '../devices/DeviceManager';
import { MatterBridge } from '../matter/MatterBridge';
import { BridgeConfig } from '../config';
import * as os from 'os';
import * as path from 'path';

const config: BridgeConfig = {
  loglevel: 'info',
  server: { host: '0.0.0.0', port: 0 },
  state: { file: path.join(os.tmpdir(), `rfxcom2matter-commission-${Date.now()}.json`) },
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
  // fresh storage per run (MatterBridge reads RFXCOM_DATA_DIR for storage.path)
  process.env.RFXCOM_DATA_DIR = path.join(os.tmpdir(), `rfxcom2matter-commission-${Date.now()}`);

  const simulator = new PositionSimulator();
  const devices = new DeviceManager(simulator, config.state.file);
  devices.load(config);

  const bridge = new MatterBridge(config.matter, devices);
  const pairing = await bridge.start();
  assert(!!pairing && pairing.manual.length > 0, `manual pairing code generated (${pairing?.manual})`);
  if (!pairing) throw new Error('FAIL: no pairing code generated');

  // give the bridge a moment to advertise commissionable
  await new Promise((r) => setTimeout(r, 2000));

  // Controller (mimics Home Assistant / openHAB) - separate ServerNode in the same process
  const controller = await ServerNode.create({
    id: 'controller-test',
    network: { port: 5599 },
  });
  await controller.start();

  const peer = await controller.peers.commission({
    id: 'peer-test',
    pairingCode: pairing.manual,
    longDiscriminator: config.matter.discriminator,
    timeout: Seconds(90),
  });
  assert(!!peer, 'commissioning succeeded (fabric added on bridge)');

  const fabrics = bridge.getFabrics();
  assert(fabrics.length === 1, `bridge shows exactly one fabric (got ${fabrics.length})`);
  console.log('[test] fabric:', fabrics[0]);

  // The commissioning window must be re-opened AFTER commissioning completed, otherwise
  // a second controller (openHAB) cannot discover the bridge and times out.
  assert(bridge.getCommissioningState().open === true, 'commissioning window re-opened after commissioning');

  await controller.close();
  await bridge.stop();
  console.log('\nALL COMMISSIONING TESTS PASSED');
  simulator.stopAll();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});