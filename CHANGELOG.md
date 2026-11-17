# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-17

### Added

- Live strip below the message composer in every open conversation: CPU usage with a 60-second history sparkline, memory usage with used/total bytes, and network download/upload speeds, refreshed once per second.
- Host-side sampling route `GET /system-monitor/sample` (same-origin only, `Cache-Control: no-store`).
- Network rate collection per platform: resident `typeperf` collector on Windows (`Network Interface(*)\Bytes Received/sec` / `Bytes Sent/sec`), `/proc/net/dev` on Linux, `netstat -ib` on macOS; Linux memory reads `MemAvailable` from `/proc/meminfo`.
- Lazy sampling: nothing runs while no strip is displayed; the Windows collector exits after 60 seconds without a request and restarts on demand with a 3-second backoff.
- Degradation paths: cold-start placeholders (`—`), sustained-failure blanking after 3 failed polls, stale-network `—` while CPU and memory keep working.
- Localized UI (English/Chinese) through the DSH Client locale service; DSH theme-token styling for light and dark themes.
- Original SVG icon and bilingual plugin metadata (title/description) in `locale/en.json` and `locale/zh.json`.
