# Architectural Strategy & Operational Guide: Option C

## Executive Overview

This repository is a **buffered fork** of [INAC-Sistemas/shiva-code](https://github.com/INAC-Sistemas/shiva-code) (which itself is an active downstream extension of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)).

We have adopted **Option C: Buffered Fork with Modular, Non-Intrusive Extensions**.

### Why Option C?
1. **Upstream Decoupling**: Upstream `shiva-code` undergoes rapid, direct-to-master iteration. Maintaining our own fork provides a stabilization buffer preventing unvetted upstream commits from breaking production environments.
2. **Auto-Update & Distribution Sovereignty**: The bundled Electron desktop client includes background auto-updaters (`electron-updater`). A dedicated fork ensures updater endpoints and builds point to our controlled release channels rather than upstream's release tags.
3. **Zero-Merge-Conflict Invariant**: Custom tools, agent capabilities, and UI modules are isolated into separate plugin and skill packages. The core harness dispatch engine remains untouched, allowing upstream bug fixes and DeepSeek synchronization to merge seamlessly.

---

## Remote Architecture

| Remote Name | Repository URL | Purpose |
| :--- | :--- | :--- |
| **`origin`** | `https://github.com/Harrysra786/shiva-code.git` | Primary working remote, release tags, and custom branch home. |
| **`upstream`** | `https://github.com/INAC-Sistemas/shiva-code.git` | Upstream parent tracking desktop shell, plugins, and harness updates. |
| **`upstream-deepseek`** *(optional)* | `https://github.com/deepseek-ai/deepseek-harness.git` | Grandparent tracking baseline DeepSeek harness changes. |

---

## Self-Hosting Identity & Operational Context (Dogfooding)

When **ShivaCode (SC)** or any autonomous coding agent opens this repository as its active workspace:
* **Who It Is**: The agent is **ShivaCode (SC)**, an autonomous programming environment built on the Cordis plugin runtime and an Electron desktop shell.
* **Who It Is Working On**: The agent is operating directly on **its own source repository** (`Harrysra786/shiva-code`).
* **Execution Context**: This is an active **self-hosting / dogfooding session**. Every tool, plugin, or prompt enhancement created will augment the agent's own future capabilities.
* **Self-Modification Boundary**: Self-modification must remain additive and non-invasive. New capabilities belong in `plugins/`, `.agents/skills/`, or external MCP servers, guaranteeing the active agent cannot break its own execution loop or lock active binaries while running.

---

## Architectural Invariants (The "Option C" Rules)

To preserve long-term maintainability, all contributors and agents working in this repository must follow these rules:

### Rule 1: No Invasive Edits to Core Dispatch
* **Do NOT modify**:
  * Core runtime packages: `packages/harness-*`, `apps/cli/src/bin.ts`
  * Core JSON-RPC dispatcher loops
  * Low-level tool runner internals
* **Reason**: Upstream frequently refactors dispatcher lanes and type models. Invasive edits here guarantee painful merge conflicts.

### Rule 2: Extend Strictly via the Extension Seams
All new features must be introduced through one of three decoupled interfaces:
1. **Agent Skills**: Place in `.agents/skills/<skill-name>/SKILL.md`. Loaded dynamically at runtime without modifying source code.
2. **Model Context Protocol (MCP) Servers**: Connect external tools, databases, and APIs as MCP servers.
3. **Isolated In-Tree / Out-of-Tree Plugins**:
   * Create dedicated directories under `plugins/<feature-name>` or `desktop/packages/<feature-name>`.
   * Bundle them as self-contained npm packages or register them with the built-in marketplace (`dshmarket`).

### Rule 3: Governed Desktop Builds & Auto-Updates
* When building production installers, verify `desktop/package.json` and `desktop/electron-builder.yml`:
  * Ensure update feeds point to `Harrysra786/shiva-code` releases (or configure `publish: never` for offline/manual distributions).
  * Isolate custom brand assets under dedicated configuration files.

---

## Operational Workflows

### 1. Daily Development Cadence

* **Core Harness & Agent Work (CLI Mode)**:
  ```bash
  # Run the harness CLI directly via TSX (no Electron build required):
  npm run dsh

  # Run test suite:
  npm test
  ```

* **Desktop UI & Client Development**:
  ```bash
  # Start desktop in Vite HMR development mode (instant live reload):
  cd desktop
  npm run dev
  ```

* **Packaged Desktop Distribution**:
  ```bash
  # Build a production Windows x64 executable (.exe):
  cd desktop
  npm run package:win
  ```

### 2. Upstream Synchronization Routine

To sync bug fixes and new features from `INAC-Sistemas/shiva-code` without clobbering custom modules:

```bash
# 1. Fetch latest upstream changes
git fetch upstream master

# 2. Check incoming commit log
git log HEAD..upstream/master --oneline

# 3. Merge upstream into local master
git merge upstream/master

# 4. Verify lockfiles and integrity
npm run pack:plugins:check
npm test

# 5. Push tested merge to origin
git push origin master
```

---

## Summary Checklist for New Custom Features

- [ ] Is this feature packaged as an isolated skill, MCP tool, or standalone plugin?
- [ ] Are core harness files (`packages/harness-*`, `apps/cli/src`) unmodified?
- [ ] Does `npm test` and `npm run dsh` execute cleanly?
- [ ] Does `cd desktop && npm run dev` load without dependency cycle warnings?
