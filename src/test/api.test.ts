import { PositionSimulator } from '../simulation/PositionSimulator';
import { DeviceManager } from '../devices/DeviceManager';
import { WebServer } from '../server/WebServer';
import { RfxcomService } from '../rfxcom/RfxcomService';
import { MatterBridge } from '../matter/MatterBridge';
import { BridgeConfig } from '../config';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfxcom-matter-api-'));
const config: BridgeConfig = {
  loglevel: 'info',
  server: { host: '0.0.0.0', port: 3199 },
  state: { file: path.join(tmpDir, 'state.json') },
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

  const rfxcom = new RfxcomService(config.rfxcom);
  const configFile = path.join(tmpDir, 'config.yml');
  fs.writeFileSync(configFile, '# test config\n', 'utf8');
  const server = new WebServer(config.server, devices, rfxcom, { configPath: configFile });
  server.setPairingCode('123-45-678', 'MT:QR-DUMMY');
  // The pairing code is only exposed while the commissioning window is open, so
  // simulate an open window without spinning up a real Matter bridge.
  server.setMatter({
    setCommissioningCallback: (cb: (s: { open: boolean }) => void) => cb({ open: true }),
  } as unknown as MatterBridge);
  await server.start();

  // GET /api/devices
  let res = await fetch('http://localhost:3199/api/devices');
  assert(res.status === 200, 'GET /api/devices -> 200');
  let body = (await res.json()) as { id: string; title: string }[];
  assert(body.length === 1, 'one device returned');
  assert(body[0].title === 'Rolladen Beispiel', 'device title correct');

  // POST command
  res = await fetch('http://localhost:3199/api/devices/1%2F0%2F1%2F1/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'down' }),
  });
  assert(res.status === 200, 'POST command down -> 200');

  // POST position
  res = await fetch('http://localhost:3199/api/devices/1%2F0%2F1%2F1/position', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 50 }),
  });
  assert(res.status === 200, 'POST position 50 -> 200');

  // invalid position rejected
  res = await fetch('http://localhost:3199/api/devices/1%2F0%2F1%2F1/position', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 150 }),
  });
  assert(res.status === 400, 'POST position 150 -> 400');

  // unknown device
  res = await fetch('http://localhost:3199/api/devices/unknown/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'up' }),
  });
  assert(res.status === 404, 'POST command to unknown device -> 404');

  // travel-time measurement: start -> waiting for ACK
  res = await fetch('http://localhost:3199/api/devices/1%2F0%2F1%2F1/measure/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'down' }),
  });
  assert(res.status === 200, 'POST measure/start -> 200');
  let meas = (await res.json()) as {
    deviceId: string | null;
    waitingForAck: boolean;
    startedAt: number | null;
  };
  assert(meas.deviceId === '1/0/1/1', 'measure bound to device');
  assert(meas.waitingForAck === true, 'measure waits for ACK after start');

  // simulate the transmitter ACK arriving on the rfxcom service
  rfxcom.emit('rfy-ack', { id: '1/0/1/1', command: 'down', at: Date.now() });
  res = await fetch('http://localhost:3199/api/measure');
  const measAfterAck = (await res.json()) as { waitingForAck: boolean; startedAt: number | null };
  assert(measAfterAck.waitingForAck === false, 'measure no longer waits for ACK');
  assert(typeof measAfterAck.startedAt === 'number', 'measure startedAt set after ACK');

  // stop the measurement -> duration computed
  res = await fetch('http://localhost:3199/api/devices/1%2F0%2F1%2F1/measure/stop', { method: 'POST' });
  assert(res.status === 200, 'POST measure/stop -> 200');
  const done = (await res.json()) as { durationMs: number | null; stoppedAt: number | null };
  assert(done.durationMs !== null && done.durationMs > 0, 'measure duration computed');

  // start with invalid command rejected
  res = await fetch('http://localhost:3199/api/devices/1%2F0%2F1%2F1/measure/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'sideways' }),
  });
  assert(res.status === 400, 'POST measure/start invalid command -> 400');

  // stop without active measurement -> 404
  res = await fetch('http://localhost:3199/api/devices/1%2F0%2F1%2F1/measure/stop', { method: 'POST' });
  assert(res.status === 404, 'POST measure/stop without active measure -> 404');

  // reset measurement
  res = await fetch('http://localhost:3199/api/devices/1%2F0%2F1%2F1/measure/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'up' }),
  });
  assert(res.status === 200, 'POST measure/start (up) -> 200');
  res = await fetch('http://localhost:3199/api/devices/1%2F0%2F1%2F1/measure', { method: 'DELETE' });
  assert(res.status === 200, 'DELETE measure -> 200');
  res = await fetch('http://localhost:3199/api/measure');
  const cleared = (await res.json()) as { deviceId: string | null };
  assert(cleared.deviceId === null, 'measure reset after DELETE');

  // unknown device measure/start -> 404
  res = await fetch('http://localhost:3199/api/devices/unknown/measure/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'down' }),
  });
  assert(res.status === 404, 'POST measure/start unknown device -> 404');

  // pairing code endpoint
  res = await fetch('http://localhost:3199/api/pairing-code');
  const pc = (await res.json()) as { pairingCode: string; qrCode: string | null; qrImage: string | null };
  assert(pc.pairingCode === '123-45-678', 'pairing code endpoint returns code');
  assert(pc.qrCode === 'MT:QR-DUMMY', 'qr code returned');
  assert(typeof pc.qrImage === 'string' && pc.qrImage.startsWith('data:image/png;base64,'), 'qr image data URL returned');

  // rfxcom status
  res = await fetch('http://localhost:3199/api/rfxcom/status');
  const st = (await res.json()) as { status: string; usbport: string; ports: unknown[] };
  assert(typeof st.status === 'string', 'rfxcom status returned');
  assert(typeof st.usbport === 'string' && Array.isArray(st.ports), 'rfxcom status info returned');

  // logs endpoint
  res = await fetch('http://localhost:3199/api/logs');
  const logsRes = (await res.json()) as { logs: { id: number; level: string }[] };
  assert(Array.isArray(logsRes.logs), 'logs endpoint returns array');

  // reconnect endpoint responds
  res = await fetch('http://localhost:3199/api/rfxcom/reconnect', { method: 'POST' });
  assert(res.status === 200, 'POST /api/rfxcom/reconnect -> 200');

  // version endpoint
  res = await fetch('http://localhost:3199/api/version');
  const ver = (await res.json()) as { version: string };
  assert(typeof ver.version === 'string' && ver.version.length > 0, 'version endpoint returns version');

  // frontend served
  res = await fetch('http://localhost:3199/');
  const html = await res.text();
  assert(html.includes('RFXCom2Matter'), 'frontend index.html served');

  // GET /api/config returns YAML
  res = await fetch('http://localhost:3199/api/config');
  const cfg = (await res.json()) as { config: string };
  assert(res.status === 200 && cfg.config.includes('# test config'), 'GET /api/config returns file');

  // PUT /api/config with invalid YAML rejected
  res = await fetch('http://localhost:3199/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: 'a: [unclosed' }),
  });
  assert(res.status === 400, 'PUT /api/config invalid YAML -> 400');

  // PUT /api/config valid YAML accepted + persisted
  res = await fetch('http://localhost:3199/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: 'loglevel: debug\n' }),
  });
  assert(res.status === 200, 'PUT /api/config valid YAML -> 200');
  const persisted = fs.readFileSync(configFile, 'utf8');
  assert(persisted.includes('loglevel: debug'), 'config file persisted');

  // GET /api/config/json returns structured config
  res = await fetch('http://localhost:3199/api/config/json');
  const cfgJson = (await res.json()) as { matter: { port: number }; devices: unknown[] };
  assert(res.status === 200 && cfgJson.matter.port === 5540, 'GET /api/config/json structured');
  assert(Array.isArray(cfgJson.devices), 'devices array in json config');

  // PUT /api/config/json invalid -> 400
  res = await fetch('http://localhost:3199/api/config/json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matter: { discriminator: 99999 } }),
  });
  assert(res.status === 400, 'PUT /api/config/json invalid discriminator -> 400');

  // PUT /api/config/json valid partial merge -> 200 + persisted
  res = await fetch('http://localhost:3199/api/config/json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matter: { enabled: true, name: 'Tabs' }, mqtt: { enabled: false } }),
  });
  assert(res.status === 200, 'PUT /api/config/json valid -> 200');
  const persistedJson = fs.readFileSync(configFile, 'utf8');
  assert(persistedJson.includes("name: Tabs"), 'json config merged + persisted');

  // GET /api/config/json reflects the saved value
  res = await fetch('http://localhost:3199/api/config/json');
  const cfgAfter = (await res.json()) as { matter: { name: string }; rfxcom: { tcp: { enabled: boolean } } };
  assert(cfgAfter.matter.name === 'Tabs', 'json config reflects saved matter name');
  assert(cfgAfter.rfxcom.tcp.enabled === false, 'rfxcom.tcp merged with default');

  // PUT /api/config/json with tcpClient (remote stick over TCP) accepted + persisted
  res = await fetch('http://localhost:3199/api/config/json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rfxcom: { tcpClient: { enabled: true, host: '192.168.1.50', port: 10001 } } }),
  });
  assert(res.status === 200, 'PUT /api/config/json tcpClient -> 200');
  res = await fetch('http://localhost:3199/api/config/json');
  const cfgTcp = (await res.json()) as { rfxcom: { tcpClient: { enabled: boolean; host: string; port: number } } };
  assert(cfgTcp.rfxcom.tcpClient.enabled === true && cfgTcp.rfxcom.tcpClient.host === '192.168.1.50', 'tcpClient merged with default');
  assert(cfgTcp.rfxcom.tcpClient.port === 10001, 'tcpClient port persisted');

  // invalid tcpClient port rejected
  res = await fetch('http://localhost:3199/api/config/json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rfxcom: { tcpClient: { port: -1 } } }),
  });
  assert(res.status === 400, 'PUT /api/config/json tcpClient invalid port -> 400');

  // PUT /api/config/json with direction travel times accepted
  res = await fetch('http://localhost:3199/api/config/json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devices: [{ id: '1/0/1/1', name: 'shutter_example', title: 'Rolladen Beispiel', type: 'rfy', subtype: 'RFY', travelTimeUp: 5000, travelTimeDown: 8000 }] }),
  });
  assert(res.status === 200, 'PUT /api/config/json direction travel times -> 200');

  console.log('\nALL API TESTS PASSED');
  simulator.stopAll();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
