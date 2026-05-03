# Credentials und Master-Passwort

## Server-Passwörter und Keyring

1. **Eingabe in der UI:** Beim Anlegen/Bearbeiten einer Verbindung oder beim Connect wird das Passwort (falls vorhanden) im Request mitgeschickt.
2. **Backend:** [`connection_manager.rs`](../../src-tauri/src/connection_manager.rs) speichert bei Bedarf mit [`vault::store_secret`](../../src-tauri/src/vault.rs) unter Service **`fz-next`** und Account = **Server-ID** (`connection.id`).
3. **Späteres Verbinden ohne erneute Passworteingabe:** [`vault::get_password(server_id)`](../../src-tauri/src/vault.rs) liest aus dem OS-Keyring (macOS Keychain, Windows Credential Locker, Secret Service auf Linux – je nach `keyring`-Backend).
4. **Frontend:** `getPassword` in [`tauri-client.ts`](../../src/services/tauri-client.ts) ruft den Befehl `vault_get_password` auf, wenn die UI das gespeicherte Geheimnis braucht.

Passwörter werden **nicht** in die normale Settings-JSON geschrieben (siehe auch Projektregeln in `CLAUDE.md`).

## Master-Passwort (separate Schicht)

Ziel: Zusätzliche Sperre bzw. Vorbereitung für verschlüsselte Speicherung. Implementierung in [`master_vault.rs`](../../src-tauri/src/master_vault.rs).

### Konfiguration auf der Platte

- Datei **`~/.fz-next/master.json`** (über `HOME`): enthält u. a. `enabled`, Base64-**Salt**, Base64-**Verifier** (kein Klartextpasswort).
- **Argon2** (`Argon2::default`) leitet aus Passwort + Salt einen **32-Byte-Wert** ab (`derive_key`, nur während Setup/Unlock im Stack).
- **Verifier:** SHA-256 über `key || b"fz-next-master-verifier"` – beim Unlock wird der abgeleitete Wert verglichen, ohne das Masterpasswort zu speichern.

### Laufzeit-Session

- Globaler `Mutex<SessionState>`: `unlocked`, Fehlversuche, optional **Cooldown** (nach 3 Fehlversuchen 5 s Sperre).
- **Unlock:** Ableitung + Verifier-Vergleich; bei Erfolg nur `unlocked = true` (kein dauerhafter Rohschlüssel in der Session).
- **Lock:** `lock_session()` setzt `unlocked = false`.

### Verschlüsselte Connection-DB (nicht umgesetzt)

- Früher existierten ungenutzte AES-GCM-Helfer; diese wurden entfernt. Pfad **`~/.fz-next/secure-connections.bin`** wird bei `reset_all` weiterhin gelöscht (Legacy-Datei).

**Folge für Audits:** Das Master-Passwort schützt die **Session** und die **Konfiguration des Master-Systems**; eine verschlüsselte Serverliste auf der Platte ist **nicht** implementiert. Siehe [../technical-debt.md](../technical-debt.md).

## Befehle (IPC)

| Befehl | Rolle |
|--------|--------|
| `master_password_status` | `enabled`, `configured`, `unlocked`, Fehlversuche, Cooldown |
| `master_password_setup` | Salt/Verifier anlegen, Session entsperren |
| `master_password_unlock` | Verifier prüfen, Session als entsperrt markieren |
| `master_password_change` | Unlock + neues Setup |
| `master_password_reset` | Konfiguration leeren, optional `secure-connections.bin` entfernen, Session sperren |
| `master_password_set_enabled` | Flag in `master.json` |
| `vault_store` / `vault_get_password` | Generischer Keyring-Zugriff (Server-Credentials) |

## Verwandte Dokumente

- [error-handling.md](error-handling.md)
- [../architecture/module-map.md](../architecture/module-map.md)
