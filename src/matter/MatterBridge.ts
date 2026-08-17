import { ServerNode, Endpoint, VendorId, Environment } from '@matter/main';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { WindowCoveringDevice } from '@matter/main/devices/window-covering';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import {
  MovementDirection,
  MovementType,
  WindowCoveringServer,
} from '@matter/main/behaviors/window-covering';
import { FabricManager, SessionManager } from '@matter/protocol';
import type { NodeSession } from '@matter/protocol';
import { CommissioningServer } from '@matter/node';
import { resolve } from 'path';
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
  /** Whether the controller currently has an active (CASE) session. */
  connected: boolean;
  /** Unix ms of the last session the controller established since bridge start (null = never). */
  lastSeen: number | null;
  /** True when the fabric never reconnected since bridge start - a leftover from a failed/unfinished commissioning. */
  stale: boolean;
  /** Human-readable name of the controller's root vendor. */
  vendorName: string;
}

/** Friendly names for well-known commissioner root vendor IDs. */
function vendorNameFor(vendorId: number): string {
  switch (vendorId) {
    case 0x6006:
      return 'Google';
    case 0x1001:
      return 'openHAB';
    case 0xfff1:
      return 'Matter (HA/matter.js)';
    default:
      return `Vendor 0x${vendorId.toString(16).toUpperCase()}`;
  }
}

/**
 * AdministratorCommissioning override is intentionally NOT installed, to
 * behave exactly like matterbridge (same matter.js 0.17.9).
 *
 * When the Home Assistant Android "Matter engine" calls openCommissioningWindow
 * while the bridge advertises its basic commissioning window (uncommissioned or
 * opened via the UI button), matter.js 0.17.9 answers with a MatterFlowError
 * ("Basic commissioning window is already open"). The engine treats that as a
 * fallback and commissions with the QR passcode against the still-active basic
 * window - which is what works.
 *
 * The previous override instead closed the basic window and opened an enhanced
 * window with the engine's own generated passcode. matter-server however
 * commissions with the QR passcode (20202021), so the bridge rejected the PASE
 * attempt with CHIP_ERROR_INVALID_PASE_PARAMETER ("Invalid PASE parameter").
 */

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
  private commissioningServer?: CommissioningServer;
  private sessionManager?: SessionManager;
  private sessionObserver?: (session: NodeSession) => void;
  private fabricLastSeen = new Map<number, number>();
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

    // Persist Matter state (fabrics, operational credentials, root CA) inside the
    // mounted data directory. matter.js resolves the storage path at ServerNode
    // *construction* time and caches it, so it must be configured on the default
    // environment BEFORE ServerNode.create(). Setting it afterwards is silently
    // ignored and the state would land in matter.js' platform default location,
    // which is discarded on container restart and loses all pairings.
    const storageDir = resolve(process.env.RFXCOM_DATA_DIR || 'data', 'matter');
    try {
      Environment.default.vars.set('storage.path', storageDir);
      console.log(`[matter] persisting Matter state in ${storageDir}`);
    } catch (err) {
      console.error('[matter] could not set storage path:', (err as Error)?.message ?? err);
    }

    const server = await ServerNode.create(ServerNode.RootEndpoint, {
      id: 'rfxcom2matter',
      network: { port: this.config.port, tcp: true, transportPreference: 'udp' },
      commissioning: { passcode: 20202021, discriminator: this.config.discriminator },
      productDescription: {
        name: this.config.name,
        deviceType: AggregatorEndpoint.deviceType,
        vendorId: VendorId(0xfff1),
        productId: 0x8000,
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
    this.currentPairing = { manual: pairingCode, qr: qrCode };

    // Commissioning window handling (matterbridge-style, no permanently open
    // window): the device is only commissionable while uncommissioned (matter.js
    // auto-advertises at start) or while the user explicitly opened a window via
    // the UI button (openCommissioning). After a controller has commissioned the
    // bridge, matter.js enters operational mode and stops advertising.
    //
    // NOTE: we must NOT re-enter commissionable mode from
    // FabricManager.events.added. That event fires while the controller is still
    // mid-commissioning (right after AddNOC, before it establishes CASE and sends
    // CommissioningComplete). Re-entering at that point is torn down again by
    // DeviceCommissioner.endCommissioning(), breaks the ongoing pairing and
    // leaves no commissionable advertisement behind. The always-open Multi-Admin
    // window this bridge used to keep also made the HA/Google commissioning flow
    // answer "Busy" (see RfxcomAdministratorCommissioningServer) - dropping it
    // removes that conflict entirely, like matterbridge.
    const fabricManager = server.env.get(FabricManager);
    // Reflect window state in the UI: any fabric change ends commissionable mode.
    const onFabricEvent = () => this.closeWindow();
    try {
      this.commissioningServer = await server.act((agent) => agent.get(CommissioningServer));
      this.commissioningServer.events.commissioned.on(onFabricEvent);
      this.commissioningServer.events.fabricsChanged.on(onFabricEvent);
    } catch (err) {
      console.error('[matter] could not subscribe to commissioning events:', (err as Error)?.message ?? err);
    }
    this.fabricObserver = onFabricEvent;

    // Track which controllers actually establish (CASE) sessions after this
    // bridge start. A fabric that never reconnects is a stale leftover from an
    // aborted commissioning (e.g. the Google Play services fabric left behind
    // by a failed HA-Android pairing) and gets marked "verwaist" in the UI so
    // it can be safely removed.
    try {
      const sessionManager = server.env.get(SessionManager);
      const onSessionAdded = (session: NodeSession) => {
        const fabricIndex = session.fabric?.fabricIndex;
        if (fabricIndex === undefined) return;
        this.fabricLastSeen.set(fabricIndex, Date.now());
      };
      sessionManager.sessions.added.on(onSessionAdded);
      this.sessionManager = sessionManager;
      this.sessionObserver = onSessionAdded;
    } catch (err) {
      console.error('[matter] could not subscribe to session events:', (err as Error)?.message ?? err);
    }

    // Uncommissioned: matter.js already advertises as commissionable; just
    // surface the open window to the UI. Commissioned: stay operational (the
    // window is opened on demand via the UI button "Pairing erneut öffnen").
    if (fabricManager.fabrics.length === 0) {
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
   * Open the commissioning window so another controller can be paired
   * (Multi-Admin). Called from the UI button "Pairing erneut öffnen". The
   * pairing code/passcode stays the same — Matter issues a single fixed code
   * per device; additional controllers simply (re)use it while the window is
   * open.
   */
  async openCommissioning(): Promise<void> {
    if (!this.node) return;
    try {
      // Matter.js does not expose the CommissioningServer as a property on the
      // node; the instance is reached through an action context. Running inside
      // `act()` is required so the call executes with a valid actor/transaction.
      await this.node.act((agent) => agent.get(CommissioningServer).enterCommissionableMode());
    } catch (err) {
      console.error('[matter] failed to open commissioning window:', (err as Error)?.message ?? err);
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
    if (this.fabricObserver) {
      if (this.commissioningServer) {
        try {
          this.commissioningServer.events.commissioned.off(this.fabricObserver);
          this.commissioningServer.events.fabricsChanged.off(this.fabricObserver);
        } catch {
          /* ignore */
        }
      }
      this.fabricObserver = undefined;
    }
    this.commissioningServer = undefined;
    if (this.sessionManager && this.sessionObserver) {
      try {
        this.sessionManager.sessions.added.off(this.sessionObserver);
      } catch {
        /* ignore */
      }
      this.sessionObserver = undefined;
    }
    this.sessionManager = undefined;
    this.fabricLastSeen.clear();
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
      const fabricIndex = e.fabricIndex;
      const lastSeen = this.fabricLastSeen.get(fabricIndex) ?? null;
      const connected = (this.sessionManager?.sessionsForFabricIndex(fabricIndex).length ?? 0) > 0;
      return {
        fabricIndex,
        fabricId: e.fabricId.toString(),
        nodeId: e.nodeId.toString(),
        rootNodeId: e.rootNodeId.toString(),
        rootVendorId: e.rootVendorId,
        label: e.label ?? '',
        connected,
        lastSeen,
        stale: !connected && lastSeen === null,
        vendorName: vendorNameFor(e.rootVendorId),
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
