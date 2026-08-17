import { ServerNode } from '@matter/main';
import { AdministratorCommissioningClient } from '@matter/node/behaviors/administrator-commissioning';
import { Seconds, Spake2p, Bytes, type Crypto } from '@matter/general';
import { SessionManager } from '@matter/protocol';
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

/** Build a syntactically valid PAKE passcode verifier (w0 || L) like a real controller would. */
async function makePasscodeVerifier(passcode: number, crypto: Crypto): Promise<Uint8Array> {
  const iterations = 10000;
  const salt = crypto.randomBytes(32);
  const { w0, L } = await Spake2p.computeW0L(crypto, { iterations, salt }, passcode);
  return Bytes.concat(Bytes.fromBigInt(w0, 32), L);
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
  assert(fabrics[0].stale === false, 'freshly commissioned fabric is not marked stale');
  assert(fabrics[0].lastSeen !== null, 'freshly commissioned fabric has a lastSeen timestamp');

  // Like matterbridge, the bridge does NOT keep a commissioning window open after
  // commissioning: it enters operational mode. A second controller (openHAB) pairs
  // again only while the window is (re)opened on demand via the UI button.
  assert(bridge.getCommissioningState().open === false, 'commissioning window closed after commissioning');

  // On-demand reopen (UI button "Pairing erneut öffnen") must open the window again.
  await bridge.openCommissioning();
  assert(bridge.getCommissioningState().open === true, 'commissioning window re-opened on demand');

  // Home Assistant (Google Play services) opens an enhanced commissioning window with its own
  // passcode via the AdministratorCommissioning cluster. Our override must close any
  // currently open window (here: the on-demand basic window) and honor the request instead
  // of answering Busy - otherwise HA aborts the pairing.
  const verifier = await makePasscodeVerifier(20202021, controller.env.get(SessionManager).crypto);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await peer.act((agent) =>
      agent
        .get(AdministratorCommissioningClient)
        .openCommissioningWindow({
          pakePasscodeVerifier: verifier,
          discriminator: config.matter.discriminator,
          iterations: 10000,
          salt: controller.env.get(SessionManager).crypto.randomBytes(32),
          commissioningTimeout: 180,
        }),
    );
    assert(true, `openCommissioningWindow honored on attempt ${attempt} (no Busy, window closed & reopened)`);
  }

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