# lumo publisher: your own free code signing

Everything here is free and runs offline. On Windows it uses only what ships with Windows 10/11
(Windows PowerShell 5.1). Nothing is bought, nothing is uploaded, and the private keys are created on your PC and stay there.

| File | What it does |
|---|---|
| `New-LumoPublisher.ps1` | creates your publisher: a private root certificate plus a code-signing certificate issued by it (Windows) |
| `Sign-Lumo.ps1` | signs `.exe` / `.dll` / `.msi` / `.ps1` files (Authenticode SHA-256) and adds a free timestamp, then verifies the result |
| `Install-LumoTrust.ps1` | makes a PC trust your publisher, or removes that trust (`-Remove`); the lumo installer and uninstaller call it |
| `make_publisher.py` | the same as `New-LumoPublisher.ps1`, for Linux / macOS build machines (needs `cryptography`) |
| `sign.sh` | the same as `Sign-Lumo.ps1`, for Linux / macOS (needs the free `osslsigncode`) |

## 1. Create the publisher (once)

Open **Windows PowerShell** in this folder and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\New-LumoPublisher.ps1 -Publisher "lumo"
```

`-Publisher` is the name Windows shows as the publisher. It is "lumo" unless you give another one, for
example `-Publisher "Your Name"` or `-Publisher "lumo" -Organization "Your Studio" -Country LK`.
You choose one password (at least 12 characters). The script writes `.\publisher\`:

| File | Ship it? | Purpose |
|---|---|---|
| `lumo-codesign.pfx` | **never** | signing certificate + private key (also kept in *Current User > Personal*) |
| `lumo-root-PRIVATE-backup.pfx` | **never** | root + private key. **Move it offline** (USB stick, password manager). Needed only for renewal |
| `lumo-root.cer` | yes | public root certificate, goes into the installer |
| `lumo-codesign.cer` | yes | public publisher certificate, goes into the installer |
| `publisher.json` | yes | names, thumbprints, expiry dates (read by the signing scripts) |

Profile: root RSA-4096 / SHA-256 valid for 15 years, CA with pathlength 0, **restricted to code signing**.
Signing certificate RSA-3072 / SHA-256 valid for 5 years, code signing only. Because of the restriction, a PC
that trusts your root cannot be fooled with a web (TLS) certificate made from it.
After the signing certificate is issued, the root's private key is deleted from the Windows store, so it exists only
in the backup file. `-KeepRootInStore` keeps it.

## 2. Sign

```powershell
.\Sign-Lumo.ps1 dist\lumo-materials.exe dist\lumo-materials-setup.exe
```

The certificate is found automatically through `publisher.json`, or given with `-Thumbprint` or `-Pfx`. For the
`.pfx`, the password comes from the `LUMO_SIGN_PASSWORD` variable, or you are asked for it. Timestamps come from free public
servers (DigiCert, Sectigo, GlobalSign, tried in turn). The timestamp keeps a signature valid after the certificate
expires. The exit code is 0 only when every file was signed **and** verified.

**Inno Setup** (the installer of the app). In *Tools > Configure Sign Tools*, add a tool named `lumo`:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $qC:\path\to\lumo-publisher\Sign-Lumo.ps1$q -Quiet $f
```

(`$q` is Inno's quote character, `$f` the quoted file name) and in the `.iss`: `SignTool=lumo` and `SignedUninstaller=yes`.
`lumo-materials\packaging\build.ps1` sets all of this up automatically. Inno then signs the setup and the uninstaller.
The app's own `.exe` and `.dll` files are signed with `Sign-Lumo.ps1` before Inno packs them.

On Linux / macOS: `LUMO_SIGN_PASSWORD=... ./sign.sh dist/*.exe`.

## 3. Trust (what users see)

| PC | Result |
|---|---|
| has trusted your root (installer box ticked, or `Install-LumoTrust.ps1`) | *Verified publisher: lumo* in UAC prompts and file properties, signature *OK* |
| has not trusted it (e.g. downloads the setup for the first time) | file properties show your signature, but Windows calls the publisher **not trusted**. SmartScreen can still say "Windows protected your PC" (*More info > Run anyway*) |

Trust your own PC (no admin rights needed; Windows asks you to confirm once):

```powershell
.\Install-LumoTrust.ps1 -RootCer .\publisher\lumo-root.cer -PublisherCer .\publisher\lumo-codesign.cer -Scope User
```

The lumo materials installer offers this as an unticked option, *Trust the publisher on this PC* (machine-wide when installed for
all users, otherwise for the current user). Its uninstaller removes it with `-Remove`. The script refuses any root that is not code-signing-only with pathlength 0.

**Limit of free signing.** Only certificates from a certificate authority that Microsoft trusts remove the
SmartScreen warning on PCs that never ran your installer, and those certificates cost money. The one free route is
[SignPath Foundation](https://signpath.org/), for open-source projects only. Your own publisher still gives you
tamper protection (any change to a signed file breaks the signature), a consistent identity, and a verified publisher
on every PC that trusts your root.

## 4. Renew (before the signing certificate expires)

```powershell
.\New-LumoPublisher.ps1 -Publisher "lumo" -RootPfx E:\backup\lumo-root-PRIVATE-backup.pfx -Force
```

This issues a new signing certificate from the **same root**, so PCs that already trust you keep trusting new builds.
`Sign-Lumo.ps1` warns 60 days before expiry. Files signed earlier stay valid thanks to the timestamp.

## Rules

- Never ship, email, commit or upload a `.pfx`. Only the `.cer` files and `publisher.json` are public.
- If the signing `.pfx` leaks: renew with `-RootPfx` and stop using the old one. If the **root backup** leaks: create a new
  publisher, and remove the old root from PCs (`Install-LumoTrust.ps1 -Remove`).
- If you lose the root backup, you cannot renew. You then need a new publisher, and every PC has to trust it again.

## Tested

`make_publisher.py` was run and checked with OpenSSL 3.0: certificate profile, chain verification, thumbprints, password
protection (AES-256 and legacy 3DES `.pfx`), renewal from the root backup, quoting of names that contain commas, and
refusal to overwrite an existing publisher. The PowerShell scripts and `sign.sh` were written for Windows PowerShell 5.1 and
osslsigncode 2.x, but have **not been run** yet (no Windows and no osslsigncode on the build machine). The first real
run on your PC is their first test.
