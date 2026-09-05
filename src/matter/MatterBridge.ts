import { ServerNode, Endpoint, VendorId, Environment } from '@matter/main';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { WindowCoveringDevice } from '@matter/main/devices/window-covering';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import {
  MovementDirection,
  MovementType,
  WindowCoveringServer,
} from '@matter/main/behaviors/window-covering';
import { AdministratorCommissioningServer } from '@matter/node/behaviors/administrator-commissioning';
import { AdministratorCommissioning } from '@matter/types/clusters/administrator-commissioning';
import { CRYPTO_PBKDF_ITERATIONS_MAX, CRYPTO_PBKDF_ITERATIONS_MIN, Seconds, Time } from '@matter/general';
import {
  PAKE_PASSCODE_VERIFIER_LENGTH,
  Status,
  StatusResponseError,
} from '@matter/types';
import {
  DeviceCommissioner,
  FabricManager,
  PaseServer,
  SessionManager,
  hasRemoteActor,
} from '@matter/protocol';
import type { NodeSession } from '@matter/protocol';
import { CommissioningServer } from '@matter/node';
import { resolve } from 'path';
import { DeviceManager } from '../devices/DeviceManager';
import { SimulatedDevice } from '../devices/types';
import { MatterConfig } from '../config';
import { getVersion } from '../version';

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

/** Convert a semver string "major.minor.patch" to a single integer (major*10000 + minor*100 + patch). */
function versionToNum(v: string): number {
  const m = v.split('.').map(Number);
  return (m[0] || 0) * 10000 + (m[1] || 0) * 100 + (m[2] || 0);
}

/**
 * AdministratorCommissioning override that arms the Enhanced Commissioning
 * Window requested by a controller (e.g. the Google Play services Matter engine
 * used by the Home Assistant Android app) even while this bridge advertises its
 * basic commissioning window (uncommissioned).
 *
 * Why this is needed - the HA/Google Android flow does NOT commission with the
 * QR passcode:
 *   1. The engine establishes a PASE session with the bridge (QR passcode).
 *   2. It calls AdministratorCommissioning.openCommissioningWindow with a FRESH
 *      passcode verifier of its own (P_g) and hands that new passcode to
 *      matter-server.
 *   3. matter-server commissions over the enhanced window using P_g.
 * Real devices (e.g. the Aqara M100 the user paired successfully) behave
 * exactly like that.
 *
 * matter.js 0.17.9 rejects that call on an uncommissioned device, so the
 * enhanced window is never armed and matter-server's PASE with P_g is rejected
 * by the still-open basic window (CHIP_ERROR_INVALID_PASE_PARAMETER):
 *   - the engine's PASE session auto-arms a failsafe (GeneralCommissioningServer),
 *     so the base class' #assertCommissioningWindowRequirements throws Busy; AND
 *   - the auto-advertised basic window would make allowEnhancedCommissioning
 *     throw MatterFlowError.
 *
 * This override honors the request instead: close the basic window, then arm
 * the enhanced window with the caller's verifier. The failsafe Busy guard is
 * deliberately not enforced - the failsafe merely guards the commissionable
 * state during a commissioning and stays valid for the subsequent commissioning
 * by matter-server (its PASE/armFailSafe simply extends it).
 */
class RfxcomAdministratorCommissioningServer extends AdministratorCommissioningServer {
  static override lockOnInvoke = false;

  override async openCommissioningWindow({
    pakePasscodeVerifier,
    discriminator,
    iterations,
    salt,
    commissioningTimeout,
  }: AdministratorCommissioning.OpenCommissioningWindowRequest) {
    if (pakePasscodeVerifier.byteLength !== PAKE_PASSCODE_VERIFIER_LENGTH) {
      throw new AdministratorCommissioning.PakeParameterError('PAKE passcode verifier length is invalid');
    }
    if (iterations < CRYPTO_PBKDF_ITERATIONS_MIN || iterations > CRYPTO_PBKDF_ITERATIONS_MAX) {
      throw new AdministratorCommissioning.PakeParameterError('PAKE iterations invalid');
    }
    if (salt.byteLength < 16 || salt.byteLength > 32) {
      throw new AdministratorCommissioning.PakeParameterError('PAKE salt has invalid length.');
    }
    const commissioner = this.env.get(DeviceCommissioner);
    const timeout = Seconds(commissioningTimeout);

    if (timeout > this.internal.maximumCommissioningTimeout) {
      throw new StatusResponseError(
        `Commissioning timeout must not exceed ${this.internal.maximumCommissioningTimeout} seconds.`,
        Status.InvalidCommand,
      );
    }
    if (timeout < this.internal.minimumCommissioningTimeout) {
      throw new StatusResponseError(
        `Commissioning timeout must not be lower then ${this.internal.minimumCommissioningTimeout} seconds.`,
        Status.InvalidCommand,
      );
    }

    // Close the auto-advertised basic commissioning window (uncommissioned
    // device) so allowEnhancedCommissioning below does not throw. No-op when
    // the bridge is operational and no window is open.
    await commissioner.endCommissioning();

    if (commissioner.isFailsafeArmed) {
      console.log(
        '[matter] openCommissioningWindow: caller PASE session holds a failsafe - arming enhanced window anyway',
      );
    }

    if (this.internal.commissioningWindowTimeout !== undefined) {
      throw new AdministratorCommissioning.BusyError('A commissioning window is already opened');
    }

    const actor = hasRemoteActor(this.context) ? this.context.session.via : 'local actor';
    console.log(`[matter] enhanced commissioning window timer started for ${commissioningTimeout}s for ${actor}`);

    this.internal.commissioningWindowTimeout = Time.getTimer(
      'Commissioning timeout',
      timeout,
      this.callback(() => {
        void this.env.get(DeviceCommissioner).endCommissioning();
      }),
    ).start();

    // Track the requesting controller in the AdministratorCommissioning
    // attributes. PASE sessions carry no fabric, so those stay unset.
    if (hasRemoteActor(this.context)) {
      const adminFabric = this.context.session.fabric;
      if (adminFabric !== undefined) {
        this.state.adminFabricIndex = adminFabric.fabricIndex;
        this.state.adminVendorId = adminFabric.rootVendorId;
        const removeCallback = this.callback(this.clearAdminFabric);
        adminFabric.deleting.on(removeCallback);
        this.internal.stopMonitoringFabricForRemoval = () => adminFabric.deleting.off(removeCallback);
      }
    }
    this.state.windowStatus = AdministratorCommissioning.CommissioningWindowStatus.EnhancedWindowOpen;

    await commissioner.allowEnhancedCommissioning(
      discriminator,
      PaseServer.fromVerificationValue(this.env.get(SessionManager), pakePasscodeVerifier, { iterations, salt }),
      this.callback(this.closeEnhancedWindow),
    );
  }

  private closeEnhancedWindow() {
    if (this.internal.commissioningWindowTimeout !== undefined) {
      this.internal.commissioningWindowTimeout.stop();
      this.internal.commissioningWindowTimeout = undefined;
    }
    this.internal.stopMonitoringFabricForRemoval?.();
    this.internal.stopMonitoringFabricForRemoval = undefined;
    this.state.adminFabricIndex = null;
    this.state.adminVendorId = null;
    this.state.windowStatus = AdministratorCommissioning.CommissioningWindowStatus.WindowNotOpen;
  }

  private clearAdminFabric() {
    this.state.adminFabricIndex = null;
    this.internal.stopMonitoringFabricForRemoval?.();
    this.internal.stopMonitoringFabricForRemoval = undefined;
  }
}

/** Root endpoint variant with the HA/Google enhanced-window handling wired in. */
const RfxcomRootEndpoint = ServerNode.RootEndpoint.with(RfxcomAdministratorCommissioningServer);

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

    const server = await ServerNode.create(RfxcomRootEndpoint, {
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

    // Commissioning window handling: the device is only commissionable while
    // uncommissioned (matter.js auto-advertises at start) or while the user
    // explicitly opened a window via the UI button (openCommissioning). After a
    // controller has commissioned the bridge, matter.js enters operational mode
    // and stops advertising.
    //
    // The HA/Google Android flow (which successfully paired the Aqara M100 in
    // this network) does NOT commission with the QR passcode: the engine PASEs,
    // arms an enhanced window with its own fresh passcode via
    // RfxcomAdministratorCommissioningServer, and matter-server then commissions
    // against that enhanced window. The override installed above makes that work
    // on this bridge.
    //
    // NOTE: we must NOT re-enter commissionable mode from
    // FabricManager.events.added. That event fires while the controller is still
    // mid-commissioning (right after AddNOC, before it establishes CASE and sends
    // CommissioningComplete). Re-entering at that point is torn down again by
    // DeviceCommissioner.endCommissioning(), breaks the ongoing pairing and
    // leaves no commissionable advertisement behind.
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
          softwareVersion: versionToNum(getVersion()),
          softwareVersionString: getVersion(),
        },
      },
    );

    // push simulated position into Matter attributes
    const listener = (updated?: SimulatedDevice) => {
      if (!updated || updated.id !== device.id) return;
      const pos100ths = Math.round(updated.state.position * 100);
      const target100ths = updated.state.targetPosition !== null
        ? Math.round(updated.state.targetPosition * 100)
        : pos100ths;
      const liftStatus = updated.state.state === 'opening' ? 1 : updated.state.state === 'closing' ? 2 : 0;
      endpoint.set({
        windowCovering: {
          currentPositionLiftPercent100ths: pos100ths,
          targetPositionLiftPercent100ths: target100ths,
          operationalStatus: { lift: liftStatus },
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
