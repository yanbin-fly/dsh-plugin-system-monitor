/**
 * @local/system-monitor — Host half.
 *
 * Serves one same-origin JSON sampling route for the composer-dock strip:
 * CPU tick totals and memory from node:os, plus network rates from a
 * lazily started platform collector. Every value is computed on demand at
 * request time, so nothing samples while no page displays the strip.
 *
 * Route: GET /system-monitor/sample -> {
 *   t: host epoch ms,
 *   cpu: { idle, total, cores },   // accumulated CPU ticks, deltas give usage
 *   mem: { total, available },    // bytes
 *   net: { down, up } | null,      // bytes per second, null when unavailable
 * }
 */

import os from 'node:os'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

export const inject = ['webServer', 'timer']

const SAMPLE_PATH = '/system-monitor/sample'

/** Kill the resident collector after this long without a sampling request. */
const COLLECTOR_IDLE_MS = 60_000
/** Minimum gap between collector spawn attempts, so a broken collector cannot spin. */
const SPAWN_BACKOFF_MS = 3_000
/** A Windows rate sample older than this stops being reported. */
const NET_STALE_MS = 8_000
/** Delta platforms recompute rates at most once per this window across all pollers. */
const NET_MIN_DELTA_MS = 500
/** typeperf prints one sample row per second; empty values are allowed. */
const TYPEPERF_ARGS = [
  '\\Network Interface(*)\\Bytes Received/sec',
  '\\Network Interface(*)\\Bytes Sent/sec',
  '-si', '1',
]

export function apply(ctx) {
  const platform = process.platform

  /** Resident collector child on win32; null whenever it must be restarted. */
  let collector = null
  let collectorBuffer = ''
  /** Instances per counter, parsed from the latest typeperf header row. */
  let collectorInstances = 0
  let lastSpawnAt = 0
  let lastRequestAt = 0
  /** Latest parsed typeperf sample: { at, down, up }. */
  let winSample = null
  /** Previous cumulative counters for delta platforms: { t, rx, tx }. */
  let deltaPrev = null
  /** Latest rates computed on a delta platform: { down, up }. */
  let deltaRates = null

  ctx.effect(() => {
    const unregister = ctx.webServer.register({ kind: 'exact', path: SAMPLE_PATH, resource: sampleResource })
    const stopReaper = ctx.timer.interval(reap, 30_000)
    return () => {
      unregister()
      stopReaper()
      stopCollector()
    }
  })

  /** Listener authority {hostname, port}, cached after the server binds. */
  let listenerAuthorityCache = null

  /** Respond to one GET /system-monitor/sample request. */
  async function sampleResource(request) {
    if (!readerAllowed(request)) {
      return new Response('forbidden\n', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    lastRequestAt = Date.now()
    const cpus = os.cpus()
    let idle = 0
    let total = 0
    for (const cpu of cpus) {
      const times = cpu.times
      idle += times.idle
      total += times.user + times.nice + times.sys + times.idle + times.irq
    }
    const mem = platform === 'linux' ? await linuxMemory() : { total: os.totalmem(), available: os.freemem() }
    const payload = {
      t: Date.now(),
      cpu: { idle, total, cores: cpus.length },
      mem,
      net: await netSnapshot(),
    }
    return new Response(JSON.stringify(payload), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  /**
   * Whether this request may read the sample. The route carries no secrets,
   * but it still refuses non-local readers: the Host header must name the
   * loopback authority or the web server's own bind origin, and a request
   * that carries an Origin must name the same authority (this keeps a
   * rebound domain from reading cross-origin data).
   */
  function readerAllowed(request) {
    const hostHeader = request.headers.get('host')
    if (!hostAllowed(hostHeader)) return false
    const origin = request.headers.get('origin')
    if (origin === null || origin === '') return true
    const originAuthority = urlAuthority(origin)
    const hostAuthority = headerAuthority(hostHeader)
    if (originAuthority === null || hostAuthority === null) return false
    return originAuthority.hostname === hostAuthority.hostname
      && originAuthority.port === hostAuthority.port
  }

  /** Whether the Host header names a loopback address or the listener origin. */
  function hostAllowed(hostHeader) {
    if (hostHeader === null || hostHeader === '') return false
    const authority = headerAuthority(hostHeader)
    if (authority === null) return false
    const listener = listenerAuthority()
    if (listener === null) return false
    const localName = authority.hostname === 'localhost' || isLoopbackLiteral(authority.hostname)
    const listenerName = authority.hostname === listener.hostname
    const defaultPort = listener.port === 80 || listener.port === 443
    const samePort = authority.port === listener.port || (authority.port === null && defaultPort)
    return (localName || listenerName) && samePort
  }

  /** The web server's own origin as {hostname, port}, cached once bound. */
  function listenerAuthority() {
    if (listenerAuthorityCache !== null) return listenerAuthorityCache
    let origin
    try {
      origin = ctx.webServer.getOrigin()
    } catch {
      return null
    }
    listenerAuthorityCache = urlAuthority(origin)
    return listenerAuthorityCache
  }

  /** Split one Host header into {hostname (lowercase, brackets stripped), port}. */
  function headerAuthority(hostHeader) {
    const colon = hostHeader.lastIndexOf(':')
    if (colon !== -1 && !hostHeader.includes(']', colon)) {
      return { hostname: normalizeHostname(hostHeader.slice(0, colon)), port: portOrNull(hostHeader.slice(colon + 1)) }
    }
    return { hostname: normalizeHostname(hostHeader), port: null }
  }

  /** {hostname, port(default-filled)} of one absolute URL, or null. */
  function urlAuthority(value) {
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      return null
    }
    const port = parsed.port === '' ? defaultPortOf(parsed.protocol) : Number(parsed.port)
    return { hostname: normalizeHostname(parsed.hostname), port: port ?? null }
  }

  function normalizeHostname(hostname) {
    return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  }

  function portOrNull(text) {
    if (text === '') return null
    const parsed = Number(text)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }

  function defaultPortOf(protocol) {
    if (protocol === 'https:') return 443
    if (protocol === 'http:') return 80
    return null
  }

  /** IPv4 loopback 127.0.0.0/8 or the IPv6 loopback ::1. */
  function isLoopbackLiteral(hostname) {
    if (/^127(\.\d{1,3}){3}$/.test(hostname)) return true
    return hostname === '::1' || hostname === '0:0:0:0:0:0:0:1'
  }

  /** Latest network rates for this platform, or null when unavailable. */
  async function netSnapshot() {
    try {
      if (platform === 'win32') {
        ensureCollector()
        if (winSample !== null && Date.now() - winSample.at <= NET_STALE_MS) {
          return { down: winSample.down, up: winSample.up }
        }
        return null
      }
      if (platform === 'linux') return deltaRatesFrom(await linuxNetCounters())
      if (platform === 'darwin') return deltaRatesFrom(await darwinNetCounters())
    } catch (error) {
      warn(`net sampling failed: ${text(error)}`)
    }
    return null
  }

  /**
   * Rates from cumulative counters, shared by every poller: a request closer
   * than NET_MIN_DELTA_MS to the previous read reuses the last computed rates.
   */
  function deltaRatesFrom(counters) {
    if (counters === null) return null
    if (deltaPrev === null) {
      deltaPrev = counters
      return roundedRates(deltaRates)
    }
    const elapsed = counters.t - deltaPrev.t
    if (elapsed < NET_MIN_DELTA_MS) return roundedRates(deltaRates)
    const seconds = elapsed / 1000
    deltaRates = {
      down: counters.rx >= deltaPrev.rx ? (counters.rx - deltaPrev.rx) / seconds : 0,
      up: counters.tx >= deltaPrev.tx ? (counters.tx - deltaPrev.tx) / seconds : 0,
    }
    deltaPrev = counters
    return roundedRates(deltaRates)
  }

  function roundedRates(rates) {
    return rates === null ? null : { down: Math.round(rates.down), up: Math.round(rates.up) }
  }

  /** Start the resident typeperf collector when absent and off backoff. */
  function ensureCollector() {
    if (collector !== null) return
    if (Date.now() - lastSpawnAt < SPAWN_BACKOFF_MS) return
    lastSpawnAt = Date.now()
    let child
    try {
      child = spawn('typeperf.exe', TYPEPERF_ARGS, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      warn(`cannot start typeperf: ${text(error)}`)
      return
    }
    collector = child
    collectorBuffer = ''
    collectorInstances = 0
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      collectorBuffer += chunk
      const lines = collectorBuffer.split(/\r?\n/)
      collectorBuffer = lines.pop() ?? ''
      for (const line of lines) ingestTypeperfLine(line)
    })
    child.on('error', (error) => {
      warn(`typeperf failed: ${text(error)}`)
      dropCollector(child)
    })
    child.on('exit', () => { dropCollector(child) })
  }

  /**
   * Parse one typeperf CSV row. Header rows fix the column split — all
   * "Bytes Received/sec" instances come first, then all "Bytes Sent/sec"
   * instances, in the same order, so positional summing stays correct.
   */
  function ingestTypeperfLine(rawLine) {
    const line = rawLine.trim()
    if (line === '') return
    const fields = splitCsvLine(line)
    if (fields.length === 0) return
    if (fields[0] === '(PDH-CSV 4.0)') {
      const dataColumns = fields.length - 1
      collectorInstances = dataColumns > 0 && dataColumns % 2 === 0 ? dataColumns / 2 : 0
      return
    }
    const instances = collectorInstances
    if (instances <= 0 || fields.length !== 2 * instances + 1) return
    let down = 0
    let up = 0
    for (let i = 1; i <= instances; i += 1) down += parseRateField(fields[i])
    for (let i = instances + 1; i <= 2 * instances; i += 1) up += parseRateField(fields[i])
    winSample = { at: Date.now(), down: Math.round(down), up: Math.round(up) }
  }

  /** Split a typeperf CSV row; fields are quoted and never contain quotes. */
  function splitCsvLine(line) {
    return line
      .split('","')
      .map((field, index, all) => {
        let value = field
        if (index === 0 && value.startsWith('"')) value = value.slice(1)
        if (index === all.length - 1 && value.endsWith('"')) value = value.slice(0, -1)
        return value
      })
  }

  /** Rate value to bytes/second; typeperf CSV never groups thousands. */
  function parseRateField(value) {
    if (value === undefined || value === '') return 0
    const parsed = Number.parseFloat(value.replace(/,/g, '.').replace(/\s/g, ''))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  function dropCollector(child) {
    if (collector === child) {
      collector = null
      collectorBuffer = ''
      collectorInstances = 0
      winSample = null
    }
  }

  /** Stop the resident collector when no page has sampled for a while. */
  function reap() {
    if (collector !== null && Date.now() - lastRequestAt > COLLECTOR_IDLE_MS) stopCollector()
  }

  function stopCollector() {
    if (collector === null) return
    const child = collector
    dropCollector(child)
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }

  /** Linux memory with the kernel's own "available" figure. */
  async function linuxMemory() {
    try {
      const text = await readFile('/proc/meminfo', 'utf8')
      let total = null
      let available = null
      for (const line of text.split('\n')) {
        const match = /^(MemTotal|MemAvailable):\s+(\d+)/.exec(line)
        if (match === null) continue
        if (match[1] === 'MemTotal') total = Number(match[2]) * 1024
        else available = Number(match[2]) * 1024
      }
      if (total !== null) return { total, available: available ?? 0 }
    } catch {
      /* fall through to node:os */
    }
    return { total: os.totalmem(), available: os.freemem() }
  }

  /** Cumulative rx/tx bytes across non-loopback /proc/net/dev interfaces. */
  async function linuxNetCounters() {
    const text = await readFile('/proc/net/dev', 'utf8')
    let rx = 0
    let tx = 0
    for (const rawLine of text.split('\n')) {
      const separator = rawLine.indexOf(':')
      if (separator === -1) continue
      const name = rawLine.slice(0, separator).trim()
      if (name === '' || name === 'lo') continue
      const fields = rawLine.slice(separator + 1).trim().split(/\s+/)
      const received = Number(fields[0])
      const sent = Number(fields[8])
      if (Number.isFinite(received)) rx += received
      if (Number.isFinite(sent)) tx += sent
    }
    return { t: Date.now(), rx, tx }
  }

  /** Cumulative rx/tx bytes from one bounded `netstat -ib` run (macOS). */
  async function darwinNetCounters() {
    const output = await collectOutput('netstat', ['-ib'], 3_000)
    if (output === null) return null
    let rx = 0
    let tx = 0
    const seen = new Set()
    for (const rawLine of output.split('\n')) {
      const fields = rawLine.trim().split(/\s+/)
      if (fields.length < 10 || !Number.isFinite(Number(fields[1]))) continue
      const name = fields[0]
      if (seen.has(name)) continue
      seen.add(name)
      if (name === 'lo0' || name.startsWith('lo')) continue
      const received = Number(fields[6])
      const sent = Number(fields[9])
      if (Number.isFinite(received)) rx += received
      if (Number.isFinite(sent)) tx += sent
    }
    return seen.size === 0 ? null : { t: Date.now(), rx, tx }
  }

  /** Run one command, resolve with its stdout when it closes or times out. */
  function collectOutput(command, args, timeoutMs) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(command, args, { windowsHide: true })
      } catch {
        resolve(null)
        return
      }
      let output = ''
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        resolve(value)
      }
      const timer = setTimeout(() => { finish(output) }, timeoutMs)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => { output += chunk })
      child.on('error', () => { finish(null) })
      child.on('close', () => { finish(output) })
    })
  }

  function warn(message) {
    ctx.logger?.warn?.(`[system-monitor] ${message}`)
  }

  function text(error) {
    return error instanceof Error ? error.message : String(error)
  }
}
