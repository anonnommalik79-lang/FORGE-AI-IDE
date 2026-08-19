# FORGE

**AI Coding Platform**

FORGE is an AI-native desktop development environment built around an autonomous coding agent.

## Product identity

- Product: **FORGE**
- Agent: **FORGE Agent**
- User-facing engine: **MalikLLM 75B**
- Interface languages: **English / Русский**

## Current desktop build

The repository currently contains the editable application resources from the Windows desktop build. The large runtime executable is intentionally not stored in GitHub because it exceeds GitHub's normal file-size limit. Keep the local `CortexIDE.exe` runtime in the project folder while the FORGE product layer is being migrated.

## Launch locally

```powershell
cd "D:\CORTEX-APP"
git pull
Start-Process ".\CortexIDE.exe"
```

Or after this branch is merged:

```powershell
.\START-FORGE.ps1
```

## Branding policy

All user-facing product surfaces are branded as FORGE. Legacy internal identifiers may remain temporarily where changing them could break extension compatibility, settings, protocols, mutexes, update infrastructure, or the existing installed binary.

Third-party license and copyright notices are preserved.
