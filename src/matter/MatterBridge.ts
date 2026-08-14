import { ServerNode, Endpoint, VendorId } from '@matter/main';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { WindowCoveringDevice } from '@matter/main/devices/window-covering';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import {
  MovementDirection,
  MovementType,
  WindowCoveringServer,
} from '@matter/main/behaviors/window-covering';
import { FabricManager } from '@matter/protocol';
import { DeviceManager } from '../devices/DeviceManager';
import { SimulatedDevice } from '../devices/types';
import { MatterConfig } from '../config';

/** A commissioned Matter client (controller) connected to this bridge. */
export interface FabricInfo {
  fabricIndex: number;
  fabricId: string;
  nodeId: string;
  rootNodeId: string;
  rootVendorId: number;
  label: string;
}

const LiftingWindowCoveringServer = WindowCoveringServer.with('Lift', 'PositionAwareLift');

/**
 * Creates a WindowCovering behavior that maps Matter commands to the
 * position simulator (RFY has no position feedback).
 */
function createShutterServer(deviceId: string, devices: DeviceManager) {
  return class ShutterServer extends LiftingWindowCoveringServer {
    override async handleMovement(
      _type: MovementType,
      _reversed: boolean,
      direction: MovementDirection,
      targetPercent100ths?: number,
    ) {
      if (targetPercent100ths !== undefined) {
        devices.moveTo(deviceId, Math.round(targetPercent100ths / 100));
      } else if (direction === MovementDirection.Close) {
        devices.command(deviceId, 'close');
      } else {
        devices.command(deviceId, 'open');
      }
    }

    override async handleStopMovement() {
      devices.command(deviceId, 'stop');
      await super.handleStopMovement();
    }
  };
}

/**
 * Exposes simulated shutters as Matter WindowCovering bridged devices.
 * Position simulation (0-100, 0=open/100=closed) maps directly to the
 * Matter lift-percent100ths attributes.
 */
export interface PairingInfo {
  manual: string;
  qr: string;
}

export class MatterBridge {
  private config: MatterConfig;
  private devices: DeviceManager;
  private node: ServerNode | null = null;
  private endpoints = new Map<string, Endpoint>();
  private listeners = new Set<(updated?: SimulatedDevice) => void>();

  constructor(config: MatterConfig, devices: DeviceManager) {
    this.config = config;
    this.devices = devices;
  }

  async start(): Promise<PairingInfo | undefined> {
    if (!this.config.enabled) {
      console.log('[matter] disabled');
      return undefined;
    }

    const server = await ServerNode.create({
      id: 'rfxcom2matter',
      network: { port: this.config.port },
      commissioning: { passcode: 20202021, discriminator: this.config.discriminator },
      productDescription: {
        name: this.config.name,
        deviceType: AggregatorEndpoint.deviceType,
      },
      basicInformation: {
        vendorName: 'RFXCom2Matter',
        vendorId: VendorId(0xfff1),
        productName: 'RFXCom to Matter Bridge',
        productId: 0x8000,
        nodeLabel: this.config.name,
        serialNumber: 'rfxcom2matter-0001',
        uniqueId: 'rfxcom2matter-v1',
      },
    });

    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
    await server.add(aggregator);

    for (const device of this.devices.list()) {
      const endpoint = await this.addWindowCovering(aggregator, device);
      this.endpoints.set(device.id, endpoint);
    }

    await server.start();

    const pairingCode = server.state.commissioning.pairingCodes.manualPairingCode;
    const qrCode = server.state.commissioning.pairingCodes.qrPairingCode;
    console.log('[matter] bridge started');
    console.log(`[matter] manual pairing code: ${pairingCode}`);
    console.log(`[matter] QR code: ${qrCode}`);

    this.node = server;
    return { manual: pairingCode, qr: qrCode };
  }

  private async addWindowCovering(parent: Endpoint, device: SimulatedDevice): Promise<Endpoint> {
    const ShutterServer = createShutterServer(device.id, this.devices);

    const endpoint = new Endpoint(
      WindowCoveringDevice.with(ShutterServer, BridgedDeviceBasicInformationServer),
      {
        id: `wc-${device.id}`,
        bridgedDeviceBasicInformation: {
          nodeLabel: device.title,
          productName: device.title,
          productLabel: device.title,
          serialNumber: `rfxcom-${device.id}`,
          reachable: true,
        },
      },
    );

    // push simulated position into Matter attributes
    const listener = (updated?: SimulatedDevice) => {
      if (!updated || updated.id !== device.id) return;
      endpoint.set({
        windowCovering: {
          currentPositionLiftPercent100ths: Math.round(updated.state.position * 100),
        },
      });
    };
    this.devices.on('device:update', listener);
    this.listeners.add(listener);

    await parent.add(endpoint);
    return endpoint;
  }

  async stop(): Promise<void> {
    for (const listener of this.listeners) {
      this.devices.off('device:update', listener);
    }
    this.listeners.clear();
    this.endpoints.clear();
    if (this.node) {
      await this.node.close();
      this.node = null;
    }
  }

  /** List all commissioned Matter clients (fabrics). */
  getFabrics(): FabricInfo[] {
    if (!this.node) return [];
    const fabricManager = this.node.env.get(FabricManager);
    return fabricManager.fabrics.map((fabric) => {
      const e = fabric.externalInformation;
      return {
        fabricIndex: e.fabricIndex,
        fabricId: e.fabricId.toString(),
        nodeId: e.nodeId.toString(),
        rootNodeId: e.rootNodeId.toString(),
        rootVendorId: e.rootVendorId,
        label: e.label ?? '',
      };
    });
  }

  /** Remove (decommission) a Matter client by its fabric index. */
  async removeFabric(fabricIndex: number): Promise<void> {
    if (!this.node) return;
    const fabricManager = this.node.env.get(FabricManager);
    const fabric = fabricManager.maybeFor(fabricIndex as any);
    if (!fabric) return;
    await fabric.delete();
  }
}
