# Release Notes

Alle wesentlichen Änderungen zu diesem Projekt werden in dieser Datei dokumentiert.
Das Format lehnt sich an [Keep a Changelog](https://keepachangelog.com/) an.

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