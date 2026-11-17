# Contributing

Thanks for your interest in improving dsh-plugin-system-monitor.

## Ground rules

- One topic per pull request; keep the diff to that topic.
- Both halves stay plain JavaScript with no build step. `index.js` is the host half (Node), `client.js` is the browser half; changes must pass `node --check`.
- Keep behavior honest: if a reading cannot be sampled, degrade it visibly (`—`) instead of showing a stale value.
- Preserve the documented contract of `GET /system-monitor/sample` (same-origin; `no-store`); coordinate breaking shape changes through a CHANGELOG entry before merging.
- Localizations for new UI strings go through the Client locale service with both `en` and `zh` dictionaries.

## Development loop

1. Clone the repository.
2. Install the directory as a local DSH bundle (Plugins → Add plugin) for iteration; restart the plugin row (disable → enable) whenever you change module code.
3. Verify on all three platforms you can access before touching a collector; note the others in your PR description as untested.
4. Update `CHANGELOG.md` under an `Unreleased` heading for user-visible changes.

## Reporting issues

Include: DSH version, OS, what the strip showed (including `—` placeholders), whether CPU/MEM kept working when network did not, and the output of one `GET /system-monitor/sample` (it contains no secrets).
