# RFXCom2Matter

Matter-Bridge für RFXCom-Rolläden (Somfy RTS / RFY) mit Web-UI zur Steuerung und
Konfiguration. Die Bridge besitzt den USB-Stick exklusiv und stellt ihn
race-frei über einen TCP-Gateway zusätzlich für RFXmngr bereit.

> **Wichtig (Hardware-Limitierung):** Der RFXtrx kann Somfy RTS/RFY **nicht
> empfangen** (RFY ist transmit-only, die Fernbedienung kann also nicht
> „abgehört" werden). Die Positionen werden deshalb zeitbasiert simuliert.

---

## Inhaltsverzeichnis

- [Architektur](#architektur)
- [Deployment mit Docker Compose](#deployment-mit-docker-compose)
- [Deployment über GitHub Actions (GHCR)](#deployment-über-github-actions-ghcr)
- [Konfiguration (config.yml)](#konfiguration-configyml)
- [Web-UI](#web-ui)
- [RFXmngr / TCP-Gateway](#rfxmngr--tcp-gateway)
- [Stick über TCP statt USB verbinden](#stick-über-tcp-statt-usb-verbinden)
- [Matter einrichten](#matter-einrichten)
- [Entwicklung](#entwicklung)
- [Technologie](#technologie)

---

## Architektur

```
                ┌───────────────────────────── RFXCom2Matter ─────────────────────────────┐
 RFXmngr ◄─────►│ TCP-Gateway (10001) ──► gemeinsame TX-Queue ─┐                           │
                │                                            ├─► USB-Stick (RFXtrx)        │
 Web-UI (3000) ►│ REST / Socket.IO ──► DeviceManager ──► Simulator ─► Positionen/State      │
 Matter (5540) ►│ MatterBridge ──► DeviceManager                                   │        │
 HomeAssistant ►│ MQTT ──► DeviceManager                                           │        │
                └──────────────────────────────────────────────────────────────────────────┘
```

- **DeviceManager**: hält die Geräte (ID, Name, travelTime, Position) und
  delegiert Bewegungen an den Simulator.
- **PositionSimulator**: interpoliert die Position linear über die Laufzeit
  (0 = offen, 100 = geschlossen) und emittiert Updates.
- **RfxcomService**: sendet RFY-Kommandos an den Stick, wartet auf ACK (0x02)
  und stellt den Status bereit.
- **MatterBridge**: mDNS-Ankündigung + Pairing-Code/QR.
- **MqttService**: publiziert State und Home-Assistant-Discovery.
- **LogBuffer**: fängt `console.*` ab und streamt die Logs an die Web-UI.

---

## Deployment mit Docker Compose

Voraussetzungen:

- Docker + Docker Compose
- Linux-Host (oder Docker Desktop / WSL mit `usbipd`), an dem der RFXCom-Stick
  als `/dev/ttyUSB0` durchgereicht werden kann

Start:

```bash
docker compose up -d --build
```

Wichtige Einstellungen in `docker-compose.yml`:

| Bereich | Wert | Bedeutung |
|---|---|---|
| `ports` | `3000:3000` | Web-UI |
| `ports` | `5540:5540/udp` | Matter (UDP) |
| `ports` | `10001:10001` | RFXmngr-TCP-Gateway (wenn aktiviert) |
| `devices` | `/dev/ttyUSB0:/dev/ttyUSB0` | USB-Passthrough des Sticks (nur Linux) — bei TCP-Verbindung oder Docker Desktop auskommentieren |
| `volumes` | `bridge-data:/app/data` | **config.yml + state.json** (Persistent Volume) |

> **Wichtig — Volume:** Es wird **ein** Volume (bzw. ein Bind-Mount) auf
> `/app/data` gemountet. Dort legt die Bridge beim ersten Start automatisch eine
> `config.yml` mit Default-Werten (alles deaktiviert, inkl. Dokumentation aller
> Optionen) und die `state.json` an. Die App-Dateien liegen **nicht** im Volume —
> ein Mount auf `/app` würde die Applikation überschatten. Die Config kann auch
> per Bind-Mount editiert werden, z. B. `- ./data:/app/data`.
>
> **Hinweis:** Änderungen an `src/` oder `frontend/` sind im Docker-Image
> „gebacken" — nach jeder Änderung ist `docker compose up -d --build`
> erforderlich. Host/Port der Web-UI erfordern einen Container-Neustart.

### USB-Passthrough unter Windows/WSL

Wenn der Stick an Windows angeschlossen ist und die Bridge in WSL/Docker läuft,
den Stick per `usbipd` binden:

```bash
usbipd list                     # BusID finden
usbipd bind --busid <BUSID>
usbipd attach --wsl --busid <BUSID>
```

### Logs ansehen

```bash
docker logs -f rfxcom2matter
```

---

## Deployment über GitHub Actions (GHCR)

Der Workflow `.github/workflows/docker-publish.yml` baut das Docker-Image und
publiziert es als GitHub-Package (GHCR), wenn ein **Tag** gepusht wird:

```bash
git tag v1.2.3
git push origin v1.2.3
```

Ergebnis:

- `ghcr.io/<owner>/<repo>:1.2.3` (Tag ohne führendes `v`)
- `ghcr.io/<owner>/<repo>:latest`
- Die Tag-Version wird als `--build-arg VERSION=…` an den Docker-Build übergeben
  und in `/app/version.txt` geschrieben.

Die Version erscheint automatisch als Badge **im Web-UI-Header** und über den
Endpunkt `GET /api/version`. Für lokale Builds ohne Tag steht dort `dev` bzw.
die `package.json`-Version.

> Das Package ist zunächst **privat**. Zum Freigeben im Repo unter
> *Settings → Packages* (oder `Packages`-Einstellungen des Images) Sichtbarkeit
> auf *public* stellen.

### Image aus GHCR verwenden

```bash
docker pull ghcr.io/<owner>/<repo>:1.2.3
docker run --device=/dev/ttyUSB0 -p 3000:3000 -p 5540:5540/udp \
  -v bridge-data:/app/data \
  ghcr.io/<owner>/<repo>:1.2.3
```

Beim ersten Start wird unter `/app/data` automatisch eine `config.yml` erzeugt
(Default: alles deaktiviert). Zum Bearbeiten auf dem Host den Volume als
Bind-Mount mounten, z. B. `-v ./data:/app/data`, oder die `config.yml` über die
Web-UI (Tab *Roh-Konfig*) anpassen.

---

## Konfiguration (config.yml)

Die Konfiguration liegt standardmäßig im **Daten-Verzeichnis** (Docker:
`/app/data/config.yml`, lokal: `./config.yml` im Projektstamm bzw.
`$RFXCOM_CONFIG`). Ist die Datei beim Start nicht vorhanden, legt die Bridge
eine Default-`config.yml` an (alle Features deaktiviert, inkl. Dokumentation
aller Optionen) und startet normal weiter. Eine vollständig dokumentierte
Referenz aller Optionen ist im Repo als `config.example.yml` abgelegt.

Die Datei wird über die Web-UI (Tab *Roh-Konfig* oder Geräte-Modal) gespeichert.
Beim Speichern wird sie sofort neu geladen.

### Globale Einstellungen

```yaml
loglevel: info            # debug | info | warn | error (im Logs-Tab änderbar)
server:
  host: 0.0.0.0
  port: 3000              # Web-UI
state:
  file: ./data/state.json # Positions-Persistenz (Docker-Volume)

rfxcom:
  usbport: /dev/ttyUSB0   # Pfad zum Stick (lokaler USB-Port)
  debug: true             # rohe USB-Bytes mitschneiden
  tcp:
    enabled: true         # RFXmngr-Gateway aktivieren
    port: 10001
  # Alternative zu usbport: Stick an einem REMOTEN Rechner über TCP statt USB
  tcpClient:
    enabled: true         # true = TCP-Verbindung nutzen (usbport wird ignoriert)
    host: 192.168.1.100   # Host mit dem Stick / ser2net / socat
    port: 10001

matter:
  enabled: false          # Default: deaktiviert
  port: 5540
  discriminator: 3840     # 0-4095, eindeutig pro Bridge im Netz
  name: RFXCom2Matter

mqtt:
  enabled: false
  server: tcp://localhost:1883
  base_topic: rfxcom2mqtt
  username: ''
  password: ''
  discovery_topic: homeassistant
  discovery: false        # Home-Assistant-Discovery publizieren (Default: aus)

ui:
  theme: light            # dark | light
```

### Geräte

```yaml
devices:
  - id: 0x10101/1           # RFY-ID (rfxcom2mqtt-Form): 3-Byte-Hex + Unit, z. B. 0x10101/1
                              #   (die UI zeigt sie als "1/01/01 · Unit 1")
    name: shutter_example   # eindeutiger Name
    title: Rolladen Beispiel # Anzeigename in der UI
    type: rfy
    subtype: RFY
    travelTimeUp: 16000     # optional: Laufzeit beim Öffnen (ms, Default 6000)
    travelTimeDown: 18000   # optional: Laufzeit beim Schließen (ms, Default 6000)
    timeBasedPosition: true # Position zeitbasiert simulieren + Teilpositionen
    shadePosition: 50       # Zielposition (0-100) für den Schatten-Button
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `id` | ja | RFY-ID in rfxcom2mqtt-Form, z. B. `0x10101/1` (3-Byte-Hex + dezimale Unit); die UI zeigt sie als `1/01/01 · Unit 1` |
| `name` | ja | Eindeutiger Name |
| `title` | nein | Anzeigename (Fallback: `name`) |
| `type` / `subtype` | ja | `rfy` / `RFY` |
| `travelTimeUp` | nein | Laufzeit beim Öffnen in Millisekunden (Default 6000) |
| `travelTimeDown` | nein | Laufzeit beim Schließen in Millisekunden (Default 6000) |
| `timeBasedPosition` | nein | Default `true`. `false` = nur Auf/Stop/Ab, keine Positionsschätzung, keine Teilpositionen; die zugehörigen Widgets (Slider, Schatten-Button, Laufzeiten, Messung) verschwinden in der UI |
| `shadePosition` | nein | Zielposition des Schatten-Buttons (0-100, 0 = offen, 100 = geschlossen) |

---

## Web-UI

Erreichbar unter `http://<host>:3000`.

| Tab | Funktion |
|---|---|
| **Geräte** | Bedienkarten (Auf/Stop/Ab, Schatten, Positions-Slider) + Zahnrad → Geräte-Konfiguration |
| **Matter** | Pairing-Code + QR, Bridge-Einstellungen (Name, Port, Discriminator) |
| **Stick** | Verbindungstyp (USB/TCP), Host/Port, Status, erkannter Port, Fehler, *Erneut verbinden* |
| **MQTT** | Broker, Topics, Discovery-Toggle |
| **Socat / RFXmngr** | TCP-Gateway aktivieren, Port, Stick-Port |
| **Logs** | Live-Logs (letzte 500) + Log-Level |
| **Roh-Konfig** | config.yml direkt editieren |

### Geräte-Konfiguration (Modal)

- Grunddaten (ID, Name, Titel, Typ, Subtyp)
- Abschnitt **Laufzeit & Positionierung**:
  - `Laufzeit hoch` / `Laufzeit runter` (getrennt einstellbar)
  - **Zeitbasierte Positionierung** (ausschalten blendet alle zugehörigen
    Widgets aus)
  - Schatten-Position (Slider)
  - **Laufzeit messen**: Stoppuhr startet beim ACK des Transmitters; Stopp
    manuell; „übernehmen" setzt die gemessene Zeit für die gemessene Richtung
    (hoch → `travelTimeUp`, runter → `travelTimeDown`)

> **Tipp:** Einmal die reale Laufzeit pro Richtung messen und übernehmen —
> damit stimmen Simulation und Teilpositionierung.

---

## RFXmngr / TCP-Gateway

Die Bridge besitzt den USB-Stick **exklusiv**. Das TCP-Gateway (Port 10001)
sendet alle Stick-Bytes an verbundene Clients und leitet Client-Schreibvorgänge
in die **gemeinsame, einzelne TX-Queue** — Web-UI-/Matter-Befehle und
RFXmngr-Befehle überlappen sich dadurch nie auf dem Draht.

Auf dem Rechner mit RFXmngr den TCP-Endpunkt in ein lokales virtuelles
serielles Gerät (PTY) verwandeln:

```bash
./scripts/rfxmngr-socat.sh [bridge-host] [bridge-port] [pty-path]
# z. B.:
./scripts/rfxmngr-socat.sh 192.168.1.20 10001 /dev/rfxmngr
```

Danach RFXmngr auf das erzeugte Gerät (`/dev/rfxmngr`) zeigen lassen. Es ist
jeweils **ein** RFXmngr-Client vorgesehen.

---

## Stick über TCP statt USB verbinden

Die Bridge kann den Stick statt über einen lokalen USB-Port auch über eine
**TCP-Verbindung** ansprechen — z. B. wenn der Stick an einem anderen Rechner
hängt (Docker ohne Geräte-Passthrough, Raspberry Pi im Keller, etc.).

### Konfiguration

In `config.yml` (oder im Web-UI *Stick*-Tab):

```yaml
rfxcom:
  tcpClient:
    enabled: true
    host: 192.168.1.100
    port: 10001
  ```

  | Feld | Bedeutung |
|---|---|
| `tcpClient.enabled` | `true` = TCP statt `usbport` verwenden |
| `tcpClient.host` | Host des Remote-Sticks |
| `tcpClient.port` | TCP-Port des Remote-Sticks |

> Ist `tcpClient.enabled` gesetzt, wird `rfxcom.usbport` ignoriert. Der Status
> in der UI zeigt dann `tcp://<host>:<port>`.

### Remote-Seite (wo der Stick hängt)

Am Remote-Rechner den seriellen Port über TCP bereitstellen. Gängige Optionen:

**Option A — socat (Linux)**

```bash
socat -d -d PTY,link=/dev/ttyUSB0,raw,echo=0 TCP-LISTEN:10001,fork
```

**Option B — ser2net (Linux, dauerhaft als Dienst)**

```ini
# /etc/ser2net.conf
10001:raw:600:/dev/ttyUSB0:38400 8DATABITS NONE 1STOPBIT
```

**Option C — die Bridge selbst als Gateway**

Läuft die Bridge bereits irgendwo mit lokalem USB-Stick und aktiviertem
RFXmngr-Gateway (`rfxcom.tcp.enabled: true`, Port 10001), kann eine **zweite**
Bridge-Instanz den TCP-Client darauf zeigen — so werden zwei Bridges mit einem
Stick betrieben (z. B. getrennte Matter-Bridges pro Etage):

```yaml
rfxcom:
  tcpClient:
    enabled: true
    host: <host-der-ersten-bridge>
    port: 10001
```

### Hinweise

- Bei TCP entfällt die automatische USB-Hot-Plug-Erkennung; stattdessen
  versucht die Bridge im Watch-Loop (3 s) automatisch neu zu verbinden, sobald
  der Endpunkt wieder erreichbar ist.
- Alle Befehle (Web-UI, Matter, RFXmngr) laufen weiterhin durch dieselbe
  einzelne TX-Queue — es gibt keine Byte-Überlappungen auf der Leitung.
- Auf Windows/Docker Desktop, wo `devices: /dev/ttyUSB0` im
  `docker-compose.yml` nicht verfügbar ist, den USB-Passthrough-Block einfach
  auskommentieren und `tcpClient` verwenden.

---

## Matter einrichten

1. Bridge starten (Docker).
2. Web-UI öffnen → Tab *Matter*: Pairing-Code bzw. QR-Code ablesen.
3. Im Controller (Apple Home, Google Home, Home Assistant) Gerät hinzufügen
   und den Code/die Kamera-Scans verwenden.
4. Die Bridge kündigt sich per mDNS an (`_matterc._udp.local`, UDP 5540).

> Unter Docker Desktop (Windows/Mac) funktioniert mDNS/Multicast über die
> Port-Weiterleitung eingeschränkt. Für volle Matter-Unterstützung auf Linux
> ggf. `network_mode: host` verwenden (siehe Kommentar in
> `docker-compose.yml`).

---

## Entwicklung

```bash
npm install
npm run dev          # ts-node, ohne Docker
npm run build        # TypeScript nach dist/
npm test             # Simulations-Test
node -e "require('ts-node/register'); require('./src/test/api.test.ts')"   # API-Test
```

Tests decken ab: Simulation (inkl. richtungsabhängiger Laufzeiten,
`timeBasedPosition: false`), Web-API (Geräte, Befehle, Messung, Config,
Version).

---

## Technologie

- Node.js 22, TypeScript
- Express + Socket.IO (Web-UI/REST)
- `@matter/main` (Matter-Bridge)
- `mqtt` (MQTT-Client + Discovery)
- `rfxcom` (RFXtrx-Protokoll)
- Docker / Docker Compose
- GitHub Actions + GHCR (Paketveröffentlichung per Tag)