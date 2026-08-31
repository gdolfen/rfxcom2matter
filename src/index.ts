import { loadConfig } from './config';
import { PositionSimulator } from './simulation/PositionSimulator';
import { DeviceManager } from './devices/DeviceManager';
import { RfxcomService } from './rfxcom/RfxcomService';
import { RfxcomGatewayServer } from './rfxcom/RfxcomGatewayServer';
import { WebServer } from './server/WebServer';
import { MatterBridge } from './matter/MatterBridge';
import { MqttService } from './mqtt/MqttService';
import { LogBuffer } from './log/LogBuffer';

async function main(): Promise<void> {
  const logs = new LogBuffer();
  logs.attach();

  const configPath = process.env.RFXCOM_CONFIG || './config.yml';
  let config = loadConfig(configPath);
  console.log(`[core] config loaded, ${config.devices.length} devices`);

  const simulator = new PositionSimulator();
  const devices = new DeviceManager(simulator, config.state.file);
  devices.load(config);

  const rfxcom = new RfxcomService(config.rfxcom);
  rfxcom.on('status', (status) => console.log(`[rfxcom] status: ${status}`));
  rfxcom.on('error', (err) => console.error('[rfxcom] error:', err?.message ?? err));

  // bridge RFY commands to the USB stick (if ready); simulation always runs
  devices.setCallbacks({
    onCommand: (deviceId, command) => {
      let rfyCommand: 'up' | 'down' | 'stop' | null = null;
      let stopDelayMs: number | undefined;
      switch (command) {
        case 'up':
        case 'open':
          rfyCommand = 'up';
          break;
        case 'down':
        case 'close':
          rfyCommand = 'down';
          break;
        case 'stop':
          rfyCommand = 'stop';
          break;
        default:
          if (command.startsWith('position:')) {
            const target = Number(command.split(':')[1]);
            const device = devices.get(deviceId);
            if (device && device.timeBasedPosition) {
              if (target === 0) {
                rfyCommand = 'up';
              } else if (target === 100) {
                rfyCommand = 'down';
              } else {
                const distance = Math.abs(target - device.state.position);
                rfyCommand = target > device.state.position ? 'down' : 'up';
                if (distance > 0) {
                  const travelTimeMs = rfyCommand === 'down' ? device.travelTimeDown : device.travelTimeUp;
                  stopDelayMs = (distance / 100) * travelTimeMs;
                }
              }
            }
          }
          break;
      }
      if (rfyCommand) {
        rfxcom
          .sendRfyCommand(deviceId, rfyCommand)
          .then(() => {
            if (stopDelayMs !== undefined && stopDelayMs > 0) {
              setTimeout(() => {
                rfxcom.sendRfyCommand(deviceId, 'stop').catch(() => {});
              }, stopDelayMs);
            }
          })
          .catch((err) => console.error(`[rfxcom] send ${rfyCommand} to ${deviceId} failed:`, err?.message ?? err));
      }
    },
  });

  await rfxcom.connect();
  rfxcom.startWatch(3000);

  const server = new WebServer(config.server, devices, rfxcom, {
    configPath,
    onConfigSaved: () => reload(configPath),
    logs,
  });
  await server.start();

  let matter = new MatterBridge(config.matter, devices);
  server.setMatter(matter);
  let pairingInfo = await matter.start();
  server.setPairingCode(pairingInfo?.manual ?? null, pairingInfo?.qr ?? null);

  let mqtt = new MqttService(config.mqtt, devices);
  mqtt.connect();

  let gateway: RfxcomGatewayServer | null = null;
  if (config.rfxcom.tcp?.enabled) {
    gateway = new RfxcomGatewayServer(rfxcom, config.rfxcom.tcp.port);
    await gateway.start();
  }

  const matterKey0 = JSON.stringify(config.matter);
  const mqttKey0 = JSON.stringify(config.mqtt);
  const tcpKey0 = JSON.stringify(config.rfxcom.tcp ?? null);
  const deviceKey0 = JSON.stringify(config.devices.map((d) => [d.id, d.title]));
  let lastMatterKey = matterKey0;
  let lastMqttKey = mqttKey0;
  let lastTcpKey = tcpKey0;
  let lastDeviceKey = deviceKey0;

  async function reload(configPath: string): Promise<void> {
    console.log('[core] config saved, reloading...');
    config = loadConfig(configPath);
    devices.load(config);

    const matterKey = JSON.stringify(config.matter);
    const mqttKey = JSON.stringify(config.mqtt);
    const tcpKey = JSON.stringify(config.rfxcom.tcp ?? null);
    const deviceKey = JSON.stringify(config.devices.map((d) => [d.id, d.title]));

    const errors: string[] = [];

    // Matter only needs a restart when its config or the device set changed.
    if (matterKey !== lastMatterKey || deviceKey !== lastDeviceKey) {
      try {
        await matter.stop();
        matter = new MatterBridge(config.matter, devices);
        server.setMatter(matter);
        if (config.matter.enabled) {
          pairingInfo = await matter.start();
          server.setPairingCode(pairingInfo?.manual ?? null, pairingInfo?.qr ?? null);
        } else {
          pairingInfo = undefined;
          server.setPairingCode(null, null);
        }
        lastMatterKey = matterKey;
        lastDeviceKey = deviceKey;
      } catch (err) {
        errors.push(`matter: ${err instanceof Error ? err.message : String(err)}`);
        console.error('[core] matter reload failed:', err);
      }
    }

    // MQTT only when its config changed.
    if (mqttKey !== lastMqttKey) {
      try {
        mqtt.disconnect();
        mqtt = new MqttService(config.mqtt, devices);
        mqtt.connect();
        lastMqttKey = mqttKey;
      } catch (err) {
        errors.push(`mqtt: ${err instanceof Error ? err.message : String(err)}`);
        console.error('[core] mqtt reload failed:', err);
      }
    }

    // TCP gateway only when its config changed.
    if (tcpKey !== lastTcpKey) {
      try {
        if (gateway) await gateway.stop();
        gateway = config.rfxcom.tcp?.enabled
          ? new RfxcomGatewayServer(rfxcom, config.rfxcom.tcp.port)
          : null;
        if (gateway) await gateway.start();
        lastTcpKey = tcpKey;
      } catch (err) {
        errors.push(`tcp: ${err instanceof Error ? err.message : String(err)}`);
        console.error('[core] tcp reload failed:', err);
      }
    }

    if (errors.length) {
      throw new Error('reload errors: ' + errors.join('; '));
    }
    console.log('[core] reload complete');
  }

  console.log('----------------------------------------');
  console.log('[core] bridge running');
  console.log(`[core] pairing code: ${pairingInfo?.manual ?? 'n/a (matter disabled)'}`);
  console.log('----------------------------------------');

  process.on('SIGINT', async () => {
    simulator.stopAll();
    mqtt.disconnect();
    await matter.stop();
    if (gateway) await gateway.stop();
    rfxcom.disconnect();
    logs.restore();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[core] fatal error:', err);
  process.exit(1);
});
