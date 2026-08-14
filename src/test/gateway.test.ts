import { RfxcomGatewayServer } from '../rfxcom/RfxcomGatewayServer';
import { RfxcomService } from '../rfxcom/RfxcomService';
import * as net from 'net';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('PASS: ' + msg);
}

class FakeSerialPort {
  written: Buffer[] = [];
  listeners: Array<(d: Buffer) => void> = [];
  on(evt: string, cb: (d: Buffer) => void): void {
    if (evt === 'data') this.listeners.push(cb);
  }
  emitData(data: Buffer): void {
    for (const cb of this.listeners) cb(data);
  }
  write(data: Buffer, cb?: (err?: Error | null) => void): void {
    this.written.push(Buffer.from(data));
    if (cb) cb(null);
  }
}

class FakeRfxcomService extends RfxcomService {
  public serialport = new FakeSerialPort();
  constructor() {
    super({ usbport: '/dev/ttyUSB0', debug: false });
  }
  // expose the fake port to the gateway
  override getSerialPort(): any {
    return this.serialport;
  }
}

async function main(): Promise<void> {
  const port = 32101;
  const rfxcom = new FakeRfxcomService();
  const gateway = new RfxcomGatewayServer(rfxcom, port);
  await gateway.start();

  // open two clients to verify broadcast + TX serialization via the shared queue
  const c1 = net.createConnection({ port, host: '127.0.0.1' });
  const c2 = net.createConnection({ port, host: '127.0.0.1' });

  await new Promise<void>((resolve) => {
    let ready = 0;
    c1.on('connect', () => { if (++ready === 2) resolve(); });
    c2.on('connect', () => { if (++ready === 2) resolve(); });
  });

  assert(gateway.getClientCount() === 2, 'two clients connected');

  // bridge TX must NOT be blocked while a client is attached: the shared queue
  // accepts bridge writes (Web UI / Matter) even with socat/RFXmngr connected
  rfxcom.enqueueWrite(Buffer.from([0x77]));
  await new Promise((r) => setTimeout(r, 50));
  assert(rfxcom.serialport.written.length === 1, 'bridge TX not blocked while client attached');

  // RX broadcast: raw bytes from the stick go to BOTH clients
  const received = new Map<string, Buffer[]>();
  c1.on('data', (d) => (received.get('c1') || received.set('c1', []).get('c1')!).push(Buffer.from(d)));
  c2.on('data', (d) => (received.get('c2') || received.set('c2', []).get('c2')!).push(Buffer.from(d)));

  rfxcom.serialport.emitData(Buffer.from([0x0d, 0xaa, 0x11]));

  await new Promise((r) => setTimeout(r, 200));
  const c1data = received.get('c1') || [];
  const c2data = received.get('c2') || [];
  assert(
    c1data.length === 1 && Buffer.compare(c1data[0], Buffer.from([0x0d, 0xaa, 0x11])) === 0,
    'RX broadcast received by client 1',
  );
  assert(
    c2data.length === 1 && Buffer.compare(c2data[0], Buffer.from([0x0d, 0xaa, 0x11])) === 0,
    'RX broadcast received by client 2',
  );

  // TX from clients is serialized to the serial port via the shared queue
  c1.write(Buffer.from([0x55, 0x01]));
  c2.write(Buffer.from([0x66, 0x02]));
  await new Promise((r) => setTimeout(r, 200));
  const writes = rfxcom.serialport.written;
  assert(writes.length === 3, 'client TX forwarded to serial port');
  assert(
    Buffer.compare(writes[1], Buffer.from([0x55, 0x01])) === 0 &&
      Buffer.compare(writes[2], Buffer.from([0x66, 0x02])) === 0,
    'TX bytes preserved and not interleaved',
  );

  // disconnect clients -> gateway keeps working
  c1.destroy();
  c2.destroy();
  await new Promise((r) => setTimeout(r, 300));
  assert(gateway.getClientCount() === 0, 'clients disconnected');

  rfxcom.enqueueWrite(Buffer.from([0x88]));
  await new Promise((r) => setTimeout(r, 50));
  assert(rfxcom.serialport.written.length === 4, 'bridge TX works after clients leave');

  await gateway.stop();
  console.log('\nALL GATEWAY TESTS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
