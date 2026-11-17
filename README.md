# dsh-plugin-system-monitor

English | [中文](#中文)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that adds a live resource monitor to the DSH Web GUI: a compact strip under the message composer in every open conversation showing **CPU usage** (with a 60-second history sparkline), **memory usage** (with used/total), and **network download/upload speeds**, refreshed once per second.

## Features

- **Live readings, 1 Hz** — CPU %, MEM % (+ used/total), ↓ download and ↑ upload speeds.
- **Per-platform collectors** — Windows reads `typeperf` (`Network Interface(*)\Bytes Received/sec` / `Bytes Sent/sec`), Linux reads `/proc/net/dev`, macOS reads `netstat -ib`; Linux memory uses `MemAvailable` from `/proc/meminfo`.
- **Lazy sampling** — nothing runs while no strip is visible: the host samples on demand, and a Windows collector idles out after 60 seconds without a request.
- **Honest degradation** — placeholders (`—`) while a collector warms up; a sustained failure blanks stale readings instead of leaving minutes-old numbers on screen.
- **Native look** — DSH theme tokens and typography; light and dark themes; localized UI (English / 简体中文).
- **Same-origin only** — the sampling route answers `GET /system-monitor/sample` with `Cache-Control: no-store` and refuses non-local readers.

## Requirements

- DeepSeek Harness with the Web GUI (desktop or `dsh web`).
- Windows, Linux, or macOS. Network readings need the platform counters to be readable; CPU and memory readings work regardless. On Windows, `typeperf.exe` must be available (it ships with the OS).

## Install

1. Clone or download this repository.
2. In the DSH Web GUI, open **Plugins** → **Add plugin** and select this directory (the one containing `package.json`).
3. Keep the plugin enabled. The strip appears below the composer in any open session.

Alternatively, from a repository checkout DSH profile you can add the row through the plugin manager (`install_bundle` with this directory), the supported automation path in this repository's delivery workflow.

## Usage

Open or create any session — the strip renders under the composer input box:

- `CPU ▁▂▅ 23%` — usage plus a short trend sparkline (hover: same reading).
- `MEM 41% (9.8/16 GB)` — usage, available memory accounted the way the kernel reports it.
- `↓ 1.2 MB/s` / `↑ 56 KB/s` — download (left) and upload (right), each with a hover title naming the direction.

CPU needs two samples to compute a delta (about one second); the first network reading appears once the platform collector emits its first sample. When a value is momentarily unavailable it shows `—`.

## How it works

| Piece | Role |
|---|---|
| `index.js` | Host half: registers `GET /system-monitor/sample` on the DSH web server; reads `node:os` CPU tick totals and memory per request; runs the platform network collector; reader checks (loopback/listen origin + Origin agreement). |
| `client.js` | Browser half: a `conversation.composer.dock` slot entry that polls once per second, renders with theme tokens, drops out-of-order responses, and blanks after 3 consecutive failures. |
| `locale/*.json` | Bilingual plugin metadata (Plugin Manager title/description). |
| `icon.svg` | Original artwork for the plugin row. |

No configuration, no external services, no data leaves the machine: the browser half only asks the same DSH server that serves the page.

## Development

Plain JavaScript on both halves — no build step. Check syntax before iterating:

```sh
node --check index.js
node --check client.js
```

Install the local directory as a bundle to see changes live; a module change needs the plugin row restarted (disable → enable in Plugins). See [CONTRIBUTING.md](CONTRIBUTING.md) for the patch conventions.

## License

[MIT](LICENSE) © 2026 Dong Yanbin

# 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在 DSH 网页界面的会话输入框下方，实时显示系统资源占用——**CPU**（附 60 秒历史走势火花线）、**内存**（附已用/总量）与**网络下行/上行速度**，每秒刷新一次。

## 功能

- 1 Hz 实时读数：CPU %、内存 %（已用/总量）、↓ 下载与 ↑ 上传速度。
- 分平台采集：Windows 读取 `typeperf`，Linux 读取 `/proc/net/dev`，macOS 读取 `netstat -ib`；Linux 内存来自 `/proc/meminfo` 的 `MemAvailable`。
- 按需采样：无人查看不运行；Windows 采集器 60 秒无请求即退出。
- 如实降级：预热期显示 `—`；持续失败则清空旧值，不残留过期数据。
- 原生观感：走 DSH 主题令牌，浅色/深色自适应，界面中英双语。
- 仅同源读取：`GET /system-monitor/sample` 带 `no-store`，拒绝非本机读取方。

## 安装

1. 克隆或下载本仓库。
2. 在 DSH 网页界面打开 **插件** → **添加插件**，选择本目录（含 `package.json` 的这一层）。
3. 保持插件启用即可，任意会话输入框下方出现该条。

## 使用说明

打开任意会话：`CPU` 附走势火花线；`内存 41% (9.8/16 GB)`；`↓/↑` 分别为下载（左）与上传（右），悬停可见方向名称（下载/上传）。CPU 需要两帧样本计算差值（约一秒）；网络首帧在采集器就绪后出现；暂不可用时显示 `—`。

## 许可证

[MIT](LICENSE) © 2026 Dong Yanbin
