import { ServerNode, Endpoint, VendorId } from '@matter/main';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { WindowCoveringDevice } from '@matter/main/devices/window-covering';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import {
  MovementDirection,
  MovementType,
  WindowCoveringServer,
} from '@matter/main/behaviors/window-covering';
import { FabricManager, CommissioningConfigProvider } from '@matter/protocol';
import { Minutes } from '@matter/general';
import { join } from 'path';
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

/** State of the commissioning (pairing) window, pushed to the UI. */
export interface MatterCommissioningState {
  open: boolean;
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
  private fabricObserver?: () => void;
  private fabricDeletedObserver?: () => void;
  private currentPairing: PairingInfo | null = null;
  private commissioningOpen = false;
  private commissioningCallback?: (state: MatterCommissioningState) => void;
  private commissioningTimer?: ReturnType<typeof setTimeout>;
  private readonly commissioningWindowS = 60;

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

    // Persist Matter state (fabrics, operational credentials, root CA) inside the
    // mounted data directory. matter.js defaults its storage path to the container's
    // working directory ("."), which is discarded on image update and loses all
    // pairings. Redirect it into the persistent volume before the filesystem is used.
    const dataDir = process.env.RFXCOM_DATA_DIR || './data';
    try {
      server.env.vars.set('storage.path', join(dataDir, 'matter'));
    } catch {
      /* fall back to matter.js default location */
    }

    // Limit the commissioning window to `commissioningWindowS` seconds. matter.js
    // defaults to 15 min and does not expose advertisementWindow via the public
    // commissioning option, so inject it into the CommissioningConfigProvider
    // that DeviceCommissioner reads. Must happen before server.start().
    try {
      const windowS = this.commissioningWindowS;
      const existing = server.env.get(CommissioningConfigProvider);
      server.env.set(
        CommissioningConfigProvider,
        new (class extends CommissioningConfigProvider {
          override get values() {
            return { ...existing.values, advertisementWindow: Minutes(windowS / 60) };
          }
        })(),
      );
    } catch {
      /* fall back to matter.js default window */
    }

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
    this.currentPairing = { manual: pairingCode, qr: qrCode };

    // Commissioning window handling (multi-admin + UI visibility):
    // - When uncommissioned at start the device is already commissionable; we
    //   just surface the open window to the UI for `commissioningWindowS`.
    // - When a controller commissions the bridge we re-open the window so
    //   further controllers can join using the SAME pairing code.
    // - When the last fabric is removed the device becomes commissionable again.
    const fabricManager = server.env.get(FabricManager);
    const onFabricAdded = () => { void this.openCommissioning().catch(() => {}); };
    const onFabricDeleted = () => { if (fabricManager.fabrics.length === 0) this.openWindow(); };
    fabricManager.events.added.on(onFabricAdded);
    fabricManager.events.deleted.on(onFabricDeleted);
    this.fabricObserver = onFabricAdded;
    this.fabricDeletedObserver = onFabricDeleted;

    if (fabricManager.fabrics.length > 0) {
      void this.openCommissioning().catch(() => {});
    } else {
      this.openWindow();
    }

    return { manual: pairingCode, qr: qrCode };
  }

  /** Register a listener for commissioning-window state changes (UI push). */
  setCommissioningCallback(cb: (state: MatterCommissioningState) => void): void {
    this.commissioningCallback = cb;
  }

  /** Current commissioning-window state. */
  getCommissioningState(): MatterCommissioningState {
    return { open: this.commissioningOpen };
  }

  /**
   * Re-open the commissioning window so another controller can be paired
   * (Multi-Admin). The pairing code/passcode stays the same — Matter issues a
   * single fixed code per device; additional controllers simply (re)use it
   * while the commissioning window is open.
   */
  async openCommissioning(): Promise<void> {
    if (!this.node) return;
    const commissioning = (this.node as unknown as { commissioning?: { enterCommissionableMode?: () => Promise<void> } }).commissioning;
    if (commissioning?.enterCommissionableMode) {
      await commissioning.enterCommissionableMode();
    }
    this.openWindow();
  }

  /** Mark the commissioning window open and schedule auto-close. */
  private openWindow(): void {
    this.commissioningOpen = true;
    this.emitCommissioning();
    if (this.commissioningTimer) clearTimeout(this.commissioningTimer);
    this.commissioningTimer = setTimeout(() => this.closeWindow(), this.commissioningWindowS * 1000);
  }

  private closeWindow(): void {
    this.commissioningOpen = false;
    this.emitCommissioning();
  }

  private emitCommissioning(): void {
    this.commissioningCallback?.({ open: this.commissioningOpen });
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
    if (this.node && this.fabricObserver) {
      try {
        this.node.env.get(FabricManager).events.added.off(this.fabricObserver);
      } catch {
        /* ignore */
      }
      this.fabricObserver = undefined;
    }
    if (this.node && this.fabricDeletedObserver) {
      try {
        this.node.env.get(FabricManager).events.deleted.off(this.fabricDeletedObserver);
      } catch {
        /* ignore */
      }
      this.fabricDeletedObserver = undefined;
    }
    if (this.commissioningTimer) {
      clearTimeout(this.commissioningTimer);
      this.commissioningTimer = undefined;
    }
    this.commissioningOpen = false;
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
