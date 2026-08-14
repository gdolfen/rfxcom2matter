# Release Notes

Alle wesentlichen Änderungen zu diesem Projekt werden in dieser Datei dokumentiert.
Das Format lehnt sich an [Keep a Changelog](https://keepachangelog.com/) an.

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