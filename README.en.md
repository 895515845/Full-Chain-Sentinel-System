# Full Chain Sentinel System

**English** | [简体中文](README.md)

Zhigong Shanfang Lab. An **authorized penetration-testing agent** built on the [pi](https://github.com/earendil-works/pi) agent harness, with a bilingual Chinese/English web console (Chinese by default) and a containerized workspace.

## Authorized use

This project is an offensive security tool. **Use it only against targets for which you hold written authorization.**

- Unauthorized penetration testing, vulnerability scanning, password cracking, or intrusion against systems you do not own or have permission to test is illegal in mainland China and most other jurisdictions (see Article 27 of the Cybersecurity Law of the PRC and Articles 285, 286, and 287-2 of the Criminal Law of the PRC; this paragraph is not legal advice).
- On first entering the console you must accept "I promise to use this only for authorized and lawful penetration testing". A hash of the acceptance and the statement is stored in the local configuration directory. Updating the statement or switching accounts requires accepting it again.
- Agent behavior cannot be fully controlled: in Auto mode the model can run arbitrary commands. **You are responsible for any business interruption, data damage, unauthorized access, or other consequences caused by using this project.** The authors and contributors accept no liability.
- Use it within the authorized scope and in an isolated environment. Obtain written authorization and agree on a time window before testing production systems.

This project is released under the MIT License, without warranty of any kind.

## Features

- **Methodology-driven penetration workflow**: reconnaissance → enumeration → vulnerability mapping → validation → exploitation → post-exploitation → reporting. System prompts emphasize scope, evidence retention, and minimal impact.
- **Bilingual web console** ([packages/web](packages/web/README.md)): Chinese by default. English can be selected from the sidebar, the sign-in page, and the consent page; server messages, errors, and reports are localized too. Includes streaming chat and reasoning, tool execution cards, a session tree, file and subagent dialogs, and project selection.
- **Three execution modes**: Approval (default; every bash command can be edited before it is allowed or rejected), Auto, and AI Approval (a Gatekeeper model returns `ALLOW` / `BLOCK` for each command; failures and timeouts fail open). The approval chain covers bash and Android shell commands (`droid_shell`). Frida, packet capture, APK analysis, and the file panel call the container directly and bypass approval.
- **Containerized workspace**: one Kali container per project, with reconnaissance, enumeration, web exploitation, password, and internal-network tools. The container network mode is configured under Settings → Environment (host by default).
- **Vulnerability hub**: `vuln_submit` records validated findings, requires a CVSS score, preserves raw packets verbatim, keeps an operator review timeline, and exports a Markdown report per project.
- **API modeling and POC library**: reconstruct a target site as an OpenAPI 3.0 document; subscribe to, search, and reference Nuclei POCs.
- **Android device plugin**: install the custom DroidBridge APK on a rooted test device to let it connect back. Provides shell, file upload/download, screenshots, logcat, tcpdump capture, Frida dynamic instrumentation, and APK static analysis.
- **iOS device plugin**: install the `SentinelBridge` deb on a rootless or rootful jailbroken device; its local control page takes a wss URL and token. Provides shell, file pull/push, app inventory, HTTP logs, packet capture, Frida, decryption, and IPA pull.
- **Asset discovery plugin** (Settings → Asset discovery): integrates **FOFA**, **360 Quake**, and **QiAnXin Hunter**. The agent uses `fofa_search` / `quake_search` / `hunter_search` with each platform's own query syntax to discover public assets (domains, IPs, ports, titles, services, fingerprints). Raw responses are written to the project's `evidence/asset/`, and every query is logged. All three support a **custom base URL** (a reverse-proxy prefix; leave it empty for the official URL). The console appends each platform's API path and re-validates after saving, so a failed validation unmounts the tool. **A platform is mounted only when it is enabled, has a key, and passes validation**; otherwise the agent cannot see that tool at all. Queries are sent directly by the console process; keys never enter the container, bash audit, or Gatekeeper decisions.
- **Web search plugin** (Settings → Web search): integrates **Tavily**. The agent uses `web_search` (public web search) and `web_extract` (page text extraction) for target intelligence such as leaked documents, public reports, and technical articles. Multiple keys form a pool; the console rotates them according to remaining quota and switches when a key is exhausted. Query history is stored in `websearch.db`, and raw responses go to the project's `evidence/search/`. Tools are mounted only when Permissions → Web search is enabled and the pool contains a validated key. Keys are stored in plaintext in the local `websearch.json` (0600) and never enter the container or bash audit.
- **Custom MCP plugins** (Settings → MCP): add, edit, test, and remove MCP servers (`http`, `sse`, or `stdio`) from the console. Tools are exposed as `mcp__<server>__<tool>` and remain subject to the Permissions → MCP master switch, where each server can be enabled or disabled individually. The configuration is owned by Sentinel (`mcp-servers.json`, 0600); **pi's native `mcp.json` is not read**, so servers absent from the list are invisible to the agent. **stdio servers execute directly on the console host** (outside the container and without bash approval), so every one requires an explicit risk acknowledgement before it can be saved.

- **Community plugin center** (Settings → Plugins): plugins are delivered as Docker images and can run locally or on your own VPS. The console connects outbound to plugin hosts, so a local deployment works without a public IP or a reverse tunnel. Each plugin is an MCP server, with tools named `mcp__<plugin>__<tool>` and subject to the Permissions → MCP master switch. Installation displays the network mode and capabilities declared by the manifest; `host` networking and `privileged` require separate confirmation. Tool calls are audited rather than individually blocked, and a plugin can be disabled from the plugin page. A plugin package is a zip containing `plugin.json`, a Dockerfile, and the build context at the root or one directory deep. After upload under Settings → Plugins, the plugin host builds and runs it locally; no image registry is required, and `source` must be public. See [docs/plugin-center.md](docs/plugin-center.md) and [docs/plugin-authoring.md](docs/plugin-authoring.md). A plugin can also ship its own frontend (`ui.entry`): click "Open UI" in the plugin drawer and the console loads `/ui/` from the image in a full-screen iframe with `sandbox="allow-scripts"`. A postMessage bridge lets it call its own tools, read artifacts, and read/write configuration and plugin-scoped storage. The iframe is an opaque origin and cannot read console cookies or the DOM. See [docs/plugin-ui.md](docs/plugin-ui.md).
- **OpenAI-compatible endpoints**: supports self-hosted endpoints such as vLLM, one-api, and new-api, configured directly in the UI.
- **Sessions as audit records**: reuses pi's JSONL session tree, retaining commands, output, and model decisions.

## Quick start

### Releases

Install Docker first. Docker installation itself is not covered here.

```sh
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh --mirror Aliyun
```


```sh
root@VM-0-11-ubuntu:~# tar -xzvf sentinel-web-linux-x64.tar.gz
sentinel-web/
sentinel-web/sentinel-web

root@VM-0-11-ubuntu:~# cd sentinel-web/

root@VM-0-11-ubuntu:~/sentinel-web# ls
sentinel-web

root@VM-0-11-ubuntu:~/sentinel-web# chmod +x sentinel-web
root@VM-0-11-ubuntu:~/sentinel-web# ./sentinel-web

```
Windows (requires Docker Desktop; run in PowerShell):

Download `sentinel-web-windows-x64.zip` from Releases (recommended) or the single-file `sentinel-web-windows-x64.exe`. The zip unpacks to the console `sentinel-web.exe` plus a `replayd/` folder (the release asset carries the platform suffix, the executable inside is `sentinel-web.exe`):

```powershell
.\sentinel-web.exe
```

`replayd/` holds the Linux binaries of the packet-replay service that the console pushes into the project containers on first use, so they must sit next to the executable. The bare `.exe` also runs: the replay toolset then reports that it cannot find the binary — drop `replayd/` next to the exe, or point `SENTINEL_REPLAYD_DIR` at its directory.

The executable is unsigned, so SmartScreen may block it once; choose "More info → Run anyway". Windows does not include `openssl` by default, so the first start falls back to plaintext HTTP and logs a warning. To keep HTTPS, install OpenSSL or provide certificates with `--tls-cert/--tls-key`. Containers use host networking by default; if Docker Desktop does not support host networking, switch to bridge networking under Settings → Environment and recreate the containers.

**Windows notes:** running the console on Windows is not recommended. Install [Win32OpenSSL](https://slproweb.com/products/Win32OpenSSL.html) and add `C:\Program Files\Git\usr\bin\` to the system `PATH`; otherwise HTTPS access will not work reliably.

Console release assets: `sentinel-web-linux-x64.tar.gz`, `sentinel-web-linux-arm64.tar.gz`, `sentinel-web-darwin-arm64.tar.gz`, `sentinel-web-darwin-x64.tar.gz`, `sentinel-web-windows-x64.zip`, `sentinel-web-windows-x64.exe` (console only, no container binaries), plus the DroidBridge APK. The four tar.gz archives and the Windows zip all carry `replayd/` (linux amd64 and arm64) for the in-container packet replay.

The first run requires creating an account and password.

![](images/Pasted%20image%2020261017122835.png)
Make sure all testing is local or covered by proper legal penetration-testing authorization, and accept the risks of generative AI, or you cannot enter the platform.

After entering the platform, deploy the container first:
![](images/Pasted%20image%2020261017123006.png)
Wait for it to finish:
![](images/Pasted%20image%2020261017123905.png)

Full Chain Sentinel (PCSS) isolates work by project. For safety, each project gets its own Kali container.
Host networking is recommended; otherwise listening operations will not work against public networks.


### From source

Requires Node.js >= 22.19.0.

```bash
npm install --ignore-scripts
npm run build:offline  # all backend packages and coding-agent (offline; the model catalog is committed)
npm run build:web      # web console and frontend assets
npm run start:web
```

`npm run build` builds only the backend packages; the console additionally requires `npm run build:web`.

At startup the log prints the entry address, such as `https://<address>:<port>/<random-string>`. The default listener is `0.0.0.0`. The random entry string and cookie validation block scanners: requests without the entry string receive an ordinary 404, and the string changes on every start. Copy the complete address from the log.

HTTPS uses a self-signed certificate by default. On first start, the console generates one with the local `openssl` (stored under `tls/` in the configuration directory; the SAN covers localhost and all current interface IPs) and reuses it afterward. The browser will warn that the certificate is untrusted; choose "Advanced → Continue", or import `tls/cert.pem` into the system trust store. If a network change alters the LAN IP and the certificate no longer matches, reissue it with `--tls-regen`.

First-visit flow:

1. Set the console password (scrypt hash, stored in the local configuration directory).
2. Read and accept the authorized-use consent.
3. Configure an endpoint (Base URL / API Key / model ID) under "Model settings" in the left sidebar.

Startup flags and environment variables:

| Flag | Environment variable | Description |
| --- | --- | --- |
| `--host <address>` | `SENTINEL_HOST` | Listen address, default `0.0.0.0` |
| `--port <port>` | `SENTINEL_PORT` | Listen port, default `7777` |
| `--cwd <directory>` | `SENTINEL_CWD` | Working directory, default the current directory |
| `--gate-token <string>` | `SENTINEL_GATE_TOKEN` | Fixed entry string; random per start by default |
| `--no-gate` | — | Disable the random entry and serve from `/` (local debugging only) |
| `--no-tls` | `SENTINEL_TLS=0` | Disable HTTPS and fall back to plaintext HTTP (self-signed HTTPS is the default) |
| `--tls-cert` / `--tls-key` | — | Use the given certificate and private key (as a pair; takes precedence over auto-generation) |
| `--tls-regen` | — | Regenerate the self-signed certificate (after an IP change or a browser domain mismatch) |
| `--no-consent` | — | Skip the first-use authorization consent (automation environments) |
| `--check` | — | Run startup checks and print the report without starting the service |

The plugin host is a subcommand of the same binary and has separate flags:

```sh
./sentinel-web plugin-host --local                    # default: 127.0.0.1 on a random port, auto-discovered by the console
./sentinel-web plugin-host --listen 0.0.0.0:7800      # listen externally; runs in remote mode automatically
```

| Flag | Environment variable | Description |
| --- | --- | --- |
| `--local` | — | Listen on the loopback address only (default) |
| `--listen <address:port>` | — | Listen address, for example `0.0.0.0:7800`; a non-loopback address selects remote mode |
| `--mode <local\|remote>` | — | Override the locality decision |
| `--data-dir <directory>` | `SENTINEL_PLUGIN_HOST_DIR` | Data directory, default `~/.sentinel/plugin-host` |
| `--tls-cert <pem>` / `--tls-key <pem>` | — | Provide an HTTPS certificate directly (as a pair; not allowed in local mode) |
| `--rotate-token` | — | Regenerate the access token; the old token stops working immediately |

Notes:

- Startup prints the token and data directory. The token is stored in `host.json` (0600) in the data directory and is entered when adding a remote host in the console.
- The plugin host itself serves HTTP only. The console rejects non-loopback `http://` addresses; public deployments must sit behind an HTTPS reverse proxy such as Caddy or nginx.
- `--local` is only a default. Once `--listen` is provided, the host listens on that address and infers the mode from it.
- The plugin host and the main console can run on the same machine or on different machines. A remote host cannot install plugins marked `locality: local-only`.

## Repository layout

The repository keeps the upstream pi monorepo package layout. Package names still use the upstream `@earendil-works/*` scope; renaming is handled separately.

| Package | Description |
| --- | --- |
| [packages/web](packages/web) | Full Chain Sentinel web console: HTTP + WebSocket service and frontend |
| [packages/coding-agent](packages/coding-agent) | Agent CLI and runtime |
| [packages/agent](packages/agent) | Tool invocation and state management |
| [packages/ai](packages/ai) | Multi-provider LLM API |
| [packages/tui](packages/tui) | Terminal UI library |
| [packages/durable](packages/durable) | Session, task, and document runtime |
| [packages/mcp](packages/mcp) · [packages/protocol](packages/protocol) | MCP and protocol layer |
| [packages/droid-apk](packages/droid-apk) | Android DroidBridge APK (Kotlin) |
| [packages/web/ios](packages/web/ios) | iOS SentinelBridge deb (Swift) and Sileo repository |
| [docker](docker) | Workspace container image (Kali + toolchain) |

## Development

```bash
./test.sh                   # all non-e2e tests
npm run check               # biome + dependency/import/entry-graph checks + tsc + webui + browser smoke
npm run build:offline       # full build, offline, without regenerating the model catalog
```

This repository does not run CI (only the release workflow). Run `npm run check` and `./test.sh` yourself before committing.

Run a single test from the package root:

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<name>.test.ts
```

`packages/ai/src/providers/data/` is generated by `generate-models` and pinned in the repository. The model-id type union is derived from it, so pinning keeps `tsc` and tests stable when vendors rotate models (a fresh clone can also typecheck offline). To update the catalog, run `npm run generate:models` (requires network) and commit the changes. Refreshing changes the `generatedAt` timestamp in `.manifest.json`; that is expected. The release workflow still refreshes it, so release artifacts carry the latest catalog.

Workspace container:

```bash
docker build -t sentinel:latest docker/
```

The base image and apt/pip/npm/go mirrors are configured under Settings → Environment in the console, or overridden on the command line with `--build-arg`.

## Security boundaries

**Console**: Docker is a hard dependency. Each project has a Kali container (`sentinel:latest`). The agent's bash commands **run inside the container** (`docker exec`), the project directory is bind-mounted at `/work`, and the container **runs as root**. Container networking defaults to **host** (the container uses the host network stack, so reverse shells, payload servers, local labs, internal networks, and VPNs behave realistically). Switch to **bridge** under Settings → Environment → Container network. Both modes keep `NET_RAW`; `NET_ADMIN` is granted only in bridge mode. If Docker checks report a blocking issue, the console refuses `prompt`, `compact`, and persistent goals.

**The container constrains commands, not the whole process**: the console and agent processes run as the starting user on the host. Only commands enter the container.

- The approval chain covers bash, Android shell (`droid_shell`), and iOS shell (`ios_shell`); subagent bash uses the same chain. **read/edit/write, the file panel, MCP tools, codemode, and tools that call the container directly (Frida, packet capture, APK analysis, and similar) bypass the gate.** Engagement-task bash has a separate regex blacklist, a 20-second timeout, and a 40-command budget, and also bypasses approval.
- `read/edit/write` access the host filesystem directly. The project directory is only the base for relative paths; absolute paths are unrestricted. MCP stdio servers are host subprocesses.
- AI Approval (the Gatekeeper) judges only six classes of destructive operations. Failures, timeouts, and unparseable replies fail open. It is **not a sandbox and does not prevent data leakage**.
- The container runs as root with no resource limits and no cap-drop / seccomp / read-only hardening. All sessions and concurrent tasks in a project share one container.
- The console loads `settings.json`, `.pi/extensions`, and `AGENTS.md` from the project directory without a project-trust confirmation step. Do not use an untrusted directory as a project. MCP servers are not loaded this way: they come only from Settings → MCP. Neither `.pi/mcp.json` in the project nor `mcp.json` in the configuration directory is read.
- **Custom MCP stdio servers execute directly on the console host**: outside the container and without bash approval or Gatekeeper review, so each one requires an explicit risk acknowledgement before saving. For HTTP servers that need OAuth login, run `sentinel mcp login` in a terminal.
- **Web search sends search terms and the API key to Tavily**: requests go directly over HTTPS from the console process, bypassing the approval gate and the container. Search content is visible to Tavily. Multiple keys are stored in plaintext in the local `websearch.json` (mode 0600) and are never displayed in the frontend. Query history and raw responses stay local (`websearch.db` and the project's `evidence/search/`).
- **Asset discovery sends queries and the API key to third-party platforms** (FOFA / 360 Quake / QiAnXin Hunter): queries go directly over HTTPS from the console process, bypassing the approval gate and the container, but target domains, IPs, and other query content are visible to those platforms. Keys are stored in plaintext in the local configuration directory's `assets.json` (mode 0600) and are never displayed in the frontend. Query history and raw responses stay local (`assets.db` and the project's `evidence/asset/`). With a custom base URL, the API key and query content are sent to that address, so only use a trusted reverse proxy.

For the complete boundaries and configuration, see [packages/web/README.md](packages/web/README.md#安全提示).

In Auto mode the model can run arbitrary commands, and persistent goals have no dangerous-command blacklist in Auto mode either. Use it only against **authorized targets in an isolated environment**. If you need unattended operation without allowing everything, use AI Approval. Console login, the random entry string, and the authorization consent prevent misuse and scanning; they are not isolation.

Report security issues through a repository issue. Do not include directly exploitable details in a public issue.

## Upstream and license

This project is a derivative work (fork) of [pi](https://github.com/earendil-works/pi). **It is not an official upstream project** and is not affiliated with the upstream team.

The upstream code is released under the MIT License, copyright Mario Zechner. The full license is in [LICENSE](LICENSE). This repository retains that license and copyright notice and adds penetration-testing system prompts, the web console, the containerized workspace, and the Android device plugin.

- Upstream repository: https://github.com/earendil-works/pi
- Copyright for the additions in this repository belongs to the project authors and is also released under MIT.
- Exception: [packages/coding-agent/examples/extensions/doom-overlay/doom/](packages/coding-agent/examples/extensions/doom-overlay/doom/) contains GPLv2 DOOM binaries and corresponding source. It is not MIT-licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What does "full chain" mean?

Security-service penetration testing usually falls into three categories:

**1. Web penetration testing 2. Mini-program penetration testing 3. App penetration testing**

This project connects all three, so one platform covers every task.

How are the three connected? Ask what penetration testing actually tests. Many people misunderstand this: about 90% of penetration testing targets the server backend. The backend exists to present something to the frontend, so connecting the three is only a matter of the delivery vehicle:

**Web**: the frontend runs in a browser.

**Mini-programs**: the frontend runs in a mini-program container.

**Apps**: the frontend runs in a UI framework.

In essence, Web, mini-programs, and apps are the same.

## Usage

Create a project before using the console; otherwise it cannot be used.
![](images/Pasted%20image%2020261017124002.png)

![](images/Pasted%20image%2020261017124018.png)


A few common scenarios:

1. **Web testing**
   Use the input box directly.

2. **Mini-programs**
   Select a preset agent, decompile the WeChat mini-program with a tool such as Tscan, and upload the result with the attachment control at the lower left.

3. **Apps**
   Configure your Android device under Android devices in the left sidebar, install the target app on the device, and select "Android" in that conversation's chat box. The toggle is per conversation: enabling it in one chat does not mount Android tools in another.

![](images/Pasted%20image%2020261017124047.png)

The design goal is to use fewer tools and less context. If you do not enable the "Android" toggle for a conversation, Android-related tool calls and prompts are not inserted there.

## Android setup

You need a rooted device (a virtual machine is also fine) with the companion app installed.

![](images/Pasted%20image%2020261017124555.png)


Rooting the phone is outside the scope of this document; the Coolapk community is a good place to learn more. The Android device is the primary reverse-connection platform, so you can deploy the main program on a public server.

<img src="images/Pasted%20image%2020261017124518.png" width="295" alt="Android device configuration" />

## iOS security

iOS support is still under development and testing. Do not use it without some iOS security fundamentals; issues and pull requests are welcome.

You need a jailbroken iPhone with Sileo installed.

Add the package source (use the lowercase repository URL):

```text
https://zgsfsec.github.io/sentinel-ios-repo/
```

<img src="images/IMG_0002.png" width="298" alt="Add the SentinelBridge source in Sileo" />

<img src="images/IMG_0003.png" width="294" alt="Install SentinelBridge in Sileo" />

Then open the following address in Safari on the iPhone:

```text
http://127.0.0.1:9945/setup
```

Create a token on the console's iOS devices page, enter the console wss URL and the token, verify the certificate fingerprint, and save. The local control page stays available and can connect, stop, or reload the bridge at any time.

<img src="images/IMG_0004.png" width="304" alt="SentinelBridge local control page" />

## Engagement mode

For batch testing. It uses a commander architecture for multi-task orchestration and is still experimental; try it at your own risk.

![](images/Pasted%20image%2020261017124651.png)

## Approval

Configure a small model under Settings → Models, for example Qwen. It hooks every bash call. Pay-as-you-go Qwen API access is recommended; do not use CodingPlan models because CodingPlan has rate limits.

https://www.qianwenai.com/models/qwen-flash

Using a small model to supervise a large one minimizes the impact on production environments.

The "Approval" item in the sidebar has two tabs. "AI Approval" is the Gatekeeper decision log (verdict, reason, duration, model). "Auto Approval" is the log of calls that no one judged: Auto mode, manual allow/block in Approval mode, and tools not covered by the Gatekeeper (read / edit / write, or when the MCP switch is off). Every bash, MCP, and plugin call leaves one record. Together the two tabs cover every call exactly once and support filtering by project, session, source, time, and keyword.

![](images/Pasted%20image%2020261017125228.png)

## POC feeds

You can run your own Nuclei POC feed service and add it under Settings → POC feeds. The main use case is n-day testing. A built-in Nuclei POC feature was not originally planned, but custom API routes in frameworks such as Jeecg Boot and RuoYi made it worthwhile.

On your remote server, periodically package all Nuclei POCs into a zip and synchronize it remotely.

You can also synchronize the official Nuclei POCs directly.

![](images/Pasted%20image%2020261017125244.png)

## Plugin center

### How to use it

Full Chain Sentinel abstracts a "plugin" so different plugins can run on different hosts.

For example, if Sentinel is deployed locally but you need public-network capabilities such as a public MSF, copy Sentinel to your VPS and run:

```
./sentinel-web plugin-host --listen 0.0.0.0:7800
```

Then add it under Settings → Plugins.

<img src="images/Pasted%20image%2020261017233410.png" alt="Plugin center" width="900" />

### How to develop plugins

On the plugin development documentation page, copy the full text, give it to an AI, and describe what you need.

<img src="images/Pasted%20image%2020261017233500.png" alt="Plugin development documentation" width="900" />

You can also refer to the example plugin "memshell-party" in this repository.

## How to run persistently

`screen -R sentinel` is recommended.

![](images/Pasted%20image%2020261017133338.png)

Then press Ctrl+A, type `d`, and detach. Learn more about screen as needed.

## Full Chain Sentinel community

When joining the group, include "全链哨兵" in your greeting.

<img src="images/Pasted%20image%2020261017125335.png" width="294" alt="Community group QR code" />

<img src="images/Pasted%20image%2020261017125351.png" width="340" alt="Community group QR code" />


## Acknowledgements

https://github.com/earendil-works/pi

https://github.com/ReaJason/MemShellParty
