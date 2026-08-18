import { Environment, ServerNode } from '@matter/main';
import { Seconds } from '@matter/general';
import { resolve } from 'node:path';

// Standalone fallback controller run as a SEPARATE process by commission.test.ts.
// A separate process has its own mDNS solver, so it never sees the retired
// enhanced-window record that lingers in the parent's shared solver — it
// discovers the freshly re-opened basic window exactly like matter-server does
// in production and commissions with the QR passcode.
//
// Usage: node --import tsx src/test/commission-fallback.ts <passcode> <discriminator>

async function main(): Promise<void> {
  const passcode = Number(process.argv[2]);
  const discriminator = Number(process.argv[3]);
  if (!Number.isInteger(passcode) || !Number.isInteger(discriminator)) {
    throw new Error(`usage: commission-fallback.ts <passcode> <discriminator> (got ${process.argv.slice(2).join(' ')})`);
  }

  if (process.env.RFXCOM_DATA_DIR) {
    Environment.default.vars.set('storage.path', resolve(process.env.RFXCOM_DATA_DIR, 'matter'));
  }

  const controller = await ServerNode.create({
    id: 'controller-fallback',
    network: { port: 5597 },
  });
  await controller.start();

  const peer = await controller.peers.commission({
    id: 'peer-fallback',
    passcode,
    longDiscriminator: discriminator,
    timeout: Seconds(90),
  });
  if (!peer) {
    throw new Error('fallback commissioning failed: no peer returned');
  }

  await controller.close();
  console.log('FALLBACK_OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('FALLBACK_FAIL', err);
  process.exit(1);
});