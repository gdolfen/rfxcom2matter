import { ServerNode, Environment } from '@matter/main';
import { AdministratorCommissioningClient } from '@matter/node/behaviors/administrator-commissioning';
import { AdministratorCommissioning } from '@matter/types/clusters/administrator-commissioning';
import { Seconds, Spake2p, Bytes, type Crypto } from '@matter/general';
import { SessionManager } from '@matter/protocol';
import { PositionSimulator } from '../simulation/PositionSimulator';
import { DeviceManager } from '../devices/DeviceManager';
import { MatterBridge } from '../matter/MatterBridge';
import { BridgeConfig } from '../config';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'node:child_process';

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
async function makePasscodeVerifier(
  passcode: number,
  crypto: Crypto,
): Promise<{ verifier: Uint8Array; iterations: number; salt: Uint8Array }> {
  const iterations = 10000;
  const salt = crypto.randomBytes(32);
  const { w0, L } = await Spake2p.computeW0L(crypto, { iterations, salt }, passcode);
  return { verifier: Bytes.concat(Bytes.fromBigInt(w0, 32), L), iterations, salt };
}

/** Run the standalone fallback controller (src/test/commission-fallback.ts) in its own process. */
function runFallbackController(passcode: number, discriminator: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/test/commission-fallback.ts', String(passcode), String(discriminator)],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    );
    let output = '';
    child.stdout.on('data', (d) => (output += d.toString()));
    child.stderr.on('data', (d) => (output += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && output.includes('FALLBACK_OK')) {
        resolvePromise();
      } else {
        reject(new Error(`fallback controller exited with code ${code}: ${output.slice(-2000)}`));
      }
    });
  });
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

  // HA/Google Android flow (the flow that successfully paired the Aqara M100):
  // the engine does NOT commission with the QR passcode. Over its (PASE) session
  // it opens an ENHANCED commissioning window with a FRESH passcode P_g of its
  // own (via AdministratorCommissioning.openCommissioningWindow) and hands that
  // passcode to matter-server, which then commissions over the enhanced window.
  // RfxcomAdministratorCommissioningServer honors that request.
  const p_g = 12345678;
  const { verifier, iterations, salt } = await makePasscodeVerifier(
    p_g,
    controller.env.get(SessionManager).crypto,
  );
  await peer.act((agent) =>
    agent
      .get(AdministratorCommissioningClient)
      .openCommissioningWindow({
        pakePasscodeVerifier: verifier,
        discriminator: config.matter.discriminator,
        iterations,
        salt,
        commissioningTimeout: 180,
      }),
  );
  // allow the attribute change subscription report to arrive
  await new Promise((r) => setTimeout(r, 500));
  const enhancedStatus = await peer.act(
    (agent) => agent.get(AdministratorCommissioningClient).state.windowStatus,
  );
  assert(
    enhancedStatus === AdministratorCommissioning.CommissioningWindowStatus.EnhancedWindowOpen,
    `enhanced commissioning window armed (windowStatus=${enhancedStatus})`,
  );

  // matter-server path: a second controller (separate fabric) commissions with
  // the engine's fresh passcode P_g against the enhanced window, discovered by
  // discriminator like matter-server does. (Delayed briefly so the enhanced
  // mDNS announcement is well established; the initial basic-window record has
  // long since been retired, so discovery sees a single commissionable node.)
  await new Promise((r) => setTimeout(r, 1000));
  const controller2 = await ServerNode.create({
    id: 'controller2-test',
    environment: new Environment('controller2-env', Environment.default),
    network: { port: 5598 },
  });
  await controller2.start();
  const peer2 = await controller2.peers.commission({
    id: 'peer-enhanced',
    passcode: p_g,
    longDiscriminator: config.matter.discriminator,
    timeout: Seconds(90),
  });
  assert(!!peer2, 'enhanced commissioning with fresh passcode succeeded (enhanced window)');
  assert(
    bridge.getFabrics().length === 2,
    `bridge shows two fabrics after enhanced commissioning (got ${bridge.getFabrics().length})`,
  );
  const closedStatus = await peer.act(
    (agent) => agent.get(AdministratorCommissioningClient).state.windowStatus,
  );
  assert(
    closedStatus === AdministratorCommissioning.CommissioningWindowStatus.WindowNotOpen,
    `enhanced window closed after commissioning (windowStatus=${closedStatus})`,
  );
  assert(bridge.getCommissioningState().open === false, 'commissioning window closed after enhanced commissioning');

  // Regression: the QR fallback (basic window) still works. Reopen on demand and
  // re-pair with the QR passcode in a SEPARATE process (fresh mDNS solver, like
  // matter-server in production) so the retired enhanced-window record cannot
  // collide with the re-opened basic window; the child adds a third fabric.
  await bridge.openCommissioning();
  assert(bridge.getCommissioningState().open === true, 'commissioning window re-opened on demand');
  // let the basic window's mDNS announcement establish before the child starts
  await new Promise((r) => setTimeout(r, 1500));
  await runFallbackController(20202021, config.matter.discriminator);
  assert(
    bridge.getFabrics().length === 3,
    `bridge shows three fabrics after fallback commissioning (got ${bridge.getFabrics().length})`,
  );
  await controller2.close();

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