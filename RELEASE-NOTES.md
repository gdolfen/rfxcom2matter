# Release Notes

Alle wesentlichen Änderungen zu diesem Projekt werden in dieser Datei dokumentiert.
Das Format lehnt sich an [Keep a Changelog](https://keepachangelog.com/) an.

## [0.2.10] – 2026-08-17

### Fixed

| Bereich | Funktion |
| --- | --- |
| **Matter** | **HA-Android-Pairing funktioniert** (matterbridge-gleich): Der bisherige `RfxcomAdministratorCommissioningServer`-Override (0.2.6) schloss das Basic-Commissioning-Fenster und öffnete stattdessen ein Enhanced-Fenster mit dem von der Phone-Matter-Engine generierten Passcode. matter-server kommissioniert aber mit dem QR-Passcode (`20202021`) – die Bridge lehnte PASE mit `CHIP_ERROR_INVALID_PASE_PARAMETER` ab („Invalid PASE parameter" im matter-server-Log). Der Override wurde entfernt. Wie bei matterbridge (matter.js 0.17.9, identische Version) wird `openCommissioningWindow` bei offenem Basic-Fenster von matter.js mit einem Fehler beantwortet; die Engine fällt auf den QR-Passcode zurück und PASE läuft erfolgreich gegen das Basic-Fenster. Der Commissioning-Test bildet diesen Ablauf nach: Enhanced-Window wird abgelehnt, danach kommissioniert ein zweiter Controller mit dem QR-Passcode (2 Fabrics) |

## [0.2.9] – 2026-08-17

### Fixed

| Bereich | Funktion |
| --- | --- |
| **MQTT** | **HA-Discovery-Messages verschwinden nicht mehr**: Die Discovery-Konfiguration wird nun beim Verbindungsaufbau **und danach alle 30 s erneut gepublished** (`announceAll`) und mit **QoS 1 + retain** versendet. Damit heilen sich HA-Entities selbst, falls retained Messages verloren gehen (Broker-Neustart, Verbindungsabbrüche, überschriebene Topics) |

## [0.2.8] – 2026-08-17

### Changed

| Bereich | Funktion |
| --- | --- |
| **MQTT** | **Home-Assistant-Discovery stellt jedes Rolladen als eigenes Gerät bereit** – bisher waren alle Covers unter einem gemeinsamen Gerät (`identifiers: [rfxcom2mqtt]`, Name „RFXCom2Matter") zusammengefasst. Jetzt erhält jedes Rolladen seinen eigenen HA-Device-Block mit `identifiers: ["shutter_<name>"]` und dem Rolladen-Titel als Gerätename. Entity-`unique_id` und Topic-Layout (`homeassistant/cover/<id>/config`, `rfxcom2mqtt/...`) bleiben unverändert |

## [0.2.7] – 2026-08-17

### Changed

| Bereich | Funktion |
| --- | --- |
| **Matter** | **Kein dauerhaft offenes Commissioning-Fenster mehr (matterbridge-Konvention)** – die Bridge hielt bisher ein Basic-Fenster für Multi-Admin permanent offen und öffnete es nach jeder Kopplung automatisch wieder. matterbridge hält kein Fenster offen; es wird nur bei ungepaartem Gerät oder auf Anforderung geöffnet. Die Bridge folgt jetzt demselben Muster: nach erfolgreicher Kopplung geht sie in den Betriebsmodus und bewirbt nichts mehr als `commissionable`. Weitere Controller werden per UI-Button „Pairing erneut öffnen“ (weiterhin derselbe Pairing-Code) hinzugefügt. Damit gibt es zum Zeitpunkt eines HA/Google-Pairings nur noch **eine** `commissionable`-Werbung (das per `openCommissioningWindow` geöffnete Enhanced-Fenster) – der `Busy`-Konflikt und mögliche Fehlzuordnungen der HA-Seite entfallen wie bei matterbridge |
| **Matter** | Netzwerk-/Produktwerbung an matterbridge angeglichen: `network` setzt jetzt `tcp: true` und `transportPreference: 'udp'`, und `productDescription` enthält explizit `vendorId`/`productId` (0xFFF1/0x8000) für die `commissionable`-TXT-Records |
| **Matter** | Der ineffektive `CommissioningConfigProvider`-Override (60-s-`advertisementWindow`) wurde entfernt – er entsprach nicht matterbridge und wirkte in matter.js 0.17.9 nicht (der Timer wird nie gestartet) |

### Fixed

| Bereich | Funktion |
| --- | --- |
| **Test** | Der Commissioning-Test erwartet jetzt das matterbridge-konforme Verhalten: Fenster **zu** nach der Kopplung, erneut **offen** nach On-Demand-Aufruf (UI-Button) |

## [0.2.6] – 2026-08-17

### Fixed

| Bereich | Funktion |
| --- | --- |
| **Matter** | **Home-Assistant-Kopplung scheiterte mit „Keine Verbindung mit dem Gerät möglich“** – HA/Google (Google Play services Matter-Engine) öffnet per `AdministratorCommissioning.openCommissioningWindow` ein eigenes Commissioning-Fenster mit selbst erzeugtem Passcode. matter.js beantwortete das mit **Busy** („A commissioning window is already opened“), sobald irgendein Fenster offen war – auch das von der Bridge für Multi-Admin offen gehaltene. HA bricht das Pairing bei dieser Antwort ab. Die Bridge schließt nun vor dem Öffnen eines angefragten Fensters das bestehende und erfüllt die Anfrage (geschützt vor einem noch laufenden Commissioning über den Failsafe-Timer) |
| **Matter-UI** | Controller-Fabrics, die sich seit dem Bridge-Start nie (erneut) verbunden haben, werden als **„verwaist“** markiert – Rückstände abgebrochener Pairings (z. B. einer fehlgeschlagenen HA-Kopplung) sind damit sichtbar und sicher entfernbar. Zusätzlich werden Vendor-Name, Verbindungsstatus und „zuletzt gesehen“ angezeigt |

### Added

| Bereich | Funktion |
| --- | --- |
| **Test** | Der Commissioning-Test ruft `openCommissioningWindow` als Controller zweimal hintereinander auf und verhindert damit Regressionen auf den Busy-Fehler |

## [0.2.5] – 2026-08-17

### Fixed

| Bereich | Funktion |
| --- | --- |
| **Matter** | **Commissioning-Fenster wurde zur falschen Zeit wieder geöffnet** – das Re-Open lief über `FabricManager.events.added` und feuerte damit **während** der laufenden Commissioning-Sitzung (direkt nach `AddNOC`, bevor der Controller per CASE `CommissioningComplete` sendet). Das störte das Pairing von Home Assistant („Ein Fehler ist aufgetreten“, obwohl die Fabric angelegt wurde) und das Fenster wurde anschließend von matter.js wieder geschlossen, sodass der nächste Controller (z. B. openHAB) keine `commissionable`-Werbung mehr fand und in einen Timeout lief. Das Fenster wird nun erst **nach** abgeschlossenem Commissioning über `CommissioningServer.events.commissioned`/`fabricsChanged` neu geöffnet |
| **Matter** | Beim Entfernen der **letzten Fabric** wird das Commissioning-Fenster jetzt wirklich geöffnet (vorher wurde nur das UI-Flag gesetzt) |

### Added

| Bereich | Funktion |
| --- | --- |
| **Test** | Neuer End-to-End-Test `src/test/commission.test.ts`: kommissioniert die Bridge mit einem echten matter.js-Controller und prüft Fabric-Erstellung sowie das erneute Öffnen des Commissioning-Fensters |

## [0.2.4] – 2026-08-17

### Fixed

| Bereich | Funktion |
| --- | --- |
| **Matter** | **Matter-State wurde nicht persistent gespeichert** – `storage.path` wurde erst *nach* `ServerNode.create()` gesetzt, aber matter.js wertet den Pfad bereits beim Konstruieren aus und cached ihn. Dadurch griff der Default (flüchtiger Container-Speicher bzw. Plattform-Standard), sodass alle gekoppelten Fabrics bei jedem Neustart verloren gingen (openHAB verschwand, Pairings hielten nicht). `storage.path` wird nun auf `Environment.default` **vor** `ServerNode.create()` gesetzt und zeigt auf `${RFXCOM_DATA_DIR}/matter` (Volume `/app/data/matter`). Damit überleben Pairings Updates/Restarts |

## [0.2.3] – 2026-08-17

### Fixed

| Bereich | Funktion |
| --- | --- |
| **Matter** | **Commissioning-Fenster wurde faktisch nie geöffnet** – `openCommissioning()` rief `server.commissioning.enterCommissionableMode()` auf, aber matter.js stellt `server.commissioning` gar nicht als Property bereit (es ist immer `undefined`). Dadurch wurde zwar das UI-Flag gesetzt, aber **nie eine `commissionable`-mDNS-Aussendung verschickt**, sodass ein zweiter Controller (z. B. Home Assistant) den Bridge-Code nicht entdecken konnte. Der korrekte Aufruf erfolgt nun über `server.act((agent) => agent.get(CommissioningServer).enterCommissionableMode())`. Multi-Admin-Reopening funktioniert damit erstmals korrekt |
| **Matter** | `@matter/node` als explizite Dependency ergänzt (zuvor nur transitiv vorhanden), da `CommissioningServer` von dort bezogen wird |

## [0.2.2] – 2026-08-17

### Fixed

| Bereich | Funktion |
| --- | --- |
| **Matter** | **Pairings werden jetzt persistent gespeichert.** matter.js legte den State bisher im Working Directory des Containers (`/app`) ab, das bei einem Image-Update verworfen wurde – dadurch gingen alle gekoppelten Controller (z. B. openHAB) verloren. Der State wird nun nach `${RFXCOM_DATA_DIR}/matter` (Volume `/app/data/matter`) geschrieben und überlebt Updates/Restarts |
| **Matter** | Analyse-Fix für Home Assistant: Controller, die noch einen alten (nun ungültigen) Fabric besaßen, scheiterten mit `fabric-not-found`/CASE-Fehlern. Nach dem Update muss der alte Matter-Eintrag in HA einmal entfernt und neu gekoppelt werden; danach bleibt das Pairing erhalten |

### Changed

| Bereich | Funktion |
| --- | --- |
| **Matter** | Commissioning-Fenster ist nur noch **60 Sekunden** geöffnet und schließt dann automatisch (vorher 15 Minuten) |
| **Matter-UI** | Der Pairing-Code (manuell + QR) wird **nur noch angezeigt, solange das Commissioning-Fenster offen ist**; bei geschlossenem Fenster wird er ausgeblendet |
| **Matter** | Beim Start mit bereits vorhandenen Fabrics wird das Commissioning-Fenster geöffnet, damit weitere Controller ohne Neustart hinzugefügt werden können |

## [0.2.1] – 2026-08-17

### Added

| Bereich | Funktion |
| --- | --- |
| **Matter** | **Multi-Admin / Multi-Controller** ordentlich unterstützt: Nach dem Koppeln eines Controllers (z. B. openHAB) wird das Commissioning-Fenster automatisch wieder geöffnet, sodass ein weiterer Controller (z. B. Home Assistant) denselben Pairing-Code nutzen kann |
| **Matter-UI** | Button *„Pairing erneut öffnen (weiteren Controller hinzufügen)“* im Tab *Matter*, um das Commissioning-Fenster jederzeit manuell erneut zu öffnen |
| **Matter-API** | `POST /api/matter/open-commissioning` zum erneuten Öffnen des Pairing-Fensters |

### Changed

| Bereich | Funktion |
| --- | --- |
| **Matter** | Beim Start mit bereits vorhandenen Fabrics wird das Commissioning-Fenster geöffnet, damit weitere Controller ohne Neustart hinzugefügt werden können |

> Hinweis: Der Matter-Pairing-Code ist pro Gerät fest und ändert sich nicht. Zusätzliche Controller nutzen denselben Code, sobald das Commissioning-Fenster (wieder) geöffnet ist.

## [0.2.0] – 2026-08-16

### Added

| Bereich | Funktion |
| --- | --- |
| **Matter** | Unterstützung für **mehrere gleichzeitig gekoppelte Controller** (Fabrics) – die Bridge ist nicht mehr auf einen einzelnen Client beschränkt |
| **Matter** | Angemeldete Clients sind in der Web-UI (Tab *Matter* → *Angemeldete Clients*) aufgelistet (Fabric-Index, Node-ID, Fabric-ID, Label) und können dort einzeln entfernt werden |
| **Matter-API** | `GET /api/matter/fabrics` (Liste der Clients) und `DELETE /api/matter/fabrics/:fabricIndex` (Client entfernen); Änderungen werden per Socket gepusht |

### Changed

| Bereich | Funktion |
| --- | --- |
| **Laufzeit** | Node auf die aktuelle LTS-Version **24** angehoben |
| **Bibliotheken** | Abhängigkeiten auf den neuesten Stand gebracht (u. a. Express 5, js-yaml 5, TypeScript 7; `ts-node` durch `tsx` ersetzt) |

### Fixed

| Bereich | Funktion |
| --- | --- |
| **Stabilität** | Absturz beim Speichern behoben: `reload` startet nicht mehr bei jedem Speichern alle Dienste neu und behandelt Fehler abgefangen; `DeviceManager.load` emittiert wieder korrekte Geräte-Objekte, sodass der Container nicht mehr crasht |

## [0.1.0] – 2026-08-15

Initiales Release von **rfxcom2matter**.

### Added

| Bereich | Funktion |
| --- | --- |
| **Matter** | Bridge für RFXCom / Somfy RTS (RFY) Rolladen; anknüpfbar in Apple Home, Google Home, Home Assistant (mDNS, Port 5540) |
| **Web-UI** | Geräteverwaltung, Rollladen-Steuerung sowie Geräte-Dialog mit Dropdowns für Typ & Subtyp aller bekannten RFXCom-Typen |
| **Position** | Zeitbasierte Similation mit Teilpositionen; Laufzeiten in Millisekunden (`travelTimeUp` / `travelTimeDown`) |
| **Messung** | Stoppuhr startet exakt beim ACK des Transmitters; getrennt für Hoch- und Runterfahren übernehmbar; laufende Anzeige mit Server-Zeit synchronisiert |
| **MQTT** | State-Publishing mit optionaler Home-Assistant-Discovery |
| **RFXCom** | USB-Seriell oder TCP (RFXmngr-TCP-Gateway bzw. entfernter socat/ser2net); automatischer TCP-Scan zur Stick-Erkennung |
| **Konfiguration** | YAML mit Live-Bearbeitung direkt in der UI |