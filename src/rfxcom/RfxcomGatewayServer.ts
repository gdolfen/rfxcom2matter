import * as net from 'net';
import { RfxcomService } from './RfxcomService';

/**
 * Race-free TCP exposure of the RFXCom serial port for RFXmngr.
 *
 * The bridge process keeps sole ownership of the serial port. This gateway
 * listens on a TCP port (default 10001) and:
 *   - broadcasts all bytes received from the stick to every connected client,
 *   - forwards client writes into the bridge's single-writer TX queue
 *     (RfxcomService.enqueueWrite), so bridge commands (Web UI / Matter) and
 *     RFXmngr commands can be used at the same time and never interleave
 *     bytes on the wire.
 *
 * RFXmngr connects to this TCP endpoint; socat is only needed on the client
 * side to turn it into a local serial device (see scripts/rfxmngr-socat.sh).
 */
export class RfxcomGatewayServer {
  private rfxcom: RfxcomService;
  private port: number;
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();

  constructor(rfxcom: RfxcomService, port: number) {
    this.rfxcom = rfxcom;
    this.port = port;
  }

  getClientCount(): number {
    return this.clients.size;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));

      this.server.on('error', (err) => {
        console.error('[tcp-gateway] error:', err.message);
        reject(err);
      });

      // forward raw bytes from the stick to all clients (RX broadcast)
      const serialport = this.rfxcom.getSerialPort();
      if (serialport) {
        serialport.on('data', (data: Buffer) => {
          for (const client of this.clients) {
            if (!client.destroyed) client.write(data);
          }
        });
      }

      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[tcp-gateway] RFXmngr gateway listening on 0.0.0.0:${this.port}`);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    this.clients.add(socket);
    console.log(`[tcp-gateway] client connected (${this.clients.size} connected)`);

    socket.on('data', (data: Buffer) => {
      // single-writer TX queue: bridge + external clients never interleave bytes
      this.rfxcom.enqueueWrite(data);
    });

    socket.on('close', () => this.dropClient(socket));
    socket.on('error', () => this.dropClient(socket));
  }

  private dropClient(socket: net.Socket): void {
    if (!this.clients.has(socket)) return;
    this.clients.delete(socket);
    console.log(`[tcp-gateway] client disconnected (${this.clients.size} connected)`);
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }
}