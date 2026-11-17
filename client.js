window.__ModuleLoader__.load({
  id: 'dsh-plugin-system-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SAMPLE_URL = '/system-monitor/sample'
    const POLL_MS = 1000
    const HISTORY_POINTS = 60
    /** Consecutive failed polls after which stale readings stop being shown. */
    const FAILURE_BLANK = 3

    const css = [
      '.dsh-sysm-root{display:inline-flex;align-items:center;gap:6px;flex:none;max-width:100%;padding:1px 8px;',
      'border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary);font-family:inherit;',
      'font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;transition:opacity .25s}',
      '.dsh-sysm-root[data-online=\'0\']{opacity:.55}',
      '.dsh-sysm-item{display:inline-flex;align-items:center;gap:5px}',
      '.dsh-sysm-label{flex:none}',
      '.dsh-sysm-value{display:inline-block;flex:none;min-width:4.5ch;text-align:right;font-weight:500;',
      'color:var(--dsw-alias-label-primary)}',
      '.dsh-sysm-rate{min-width:10ch}',
      '.dsh-sysm-sub{color:var(--dsw-alias-label-secondary);font-weight:400}',
      '.dsh-sysm-arrow{display:block;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sysm-spark{display:block;color:var(--dsw-alias-label-secondary)}',
    ].join('')

    /** Bytes per second rendered as B/s, KB/s, MB/s, or GB/s. */
    function formatRate(bytesPerSec) {
      if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`
      if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
      if (bytesPerSec < 1024 * 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`
      return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(2)} GB/s`
    }

    /** Byte totals rendered as KB, MB, or GB. */
    function formatBytes(bytes) {
      if (bytes >= 1024 ** 3) return `${trimZero((bytes / 1024 ** 3).toFixed(1))} GB`
      if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
      return `${Math.max(0, Math.round(bytes / 1024))} KB`
    }

    function trimZero(text) {
      return text.endsWith('.0') ? text.slice(0, -2) : text
    }

    /** Small up/down direction glyph drawn as strokes so fonts cannot alter it. */
    function Arrow({ down }) {
      const path = down
        ? 'M6 2v6.3M3.1 5.9 6 8.8 8.9 5.9'
        : 'M6 10.2V3.9M3.1 6.3 6 3.4 8.9 6.3'
      return h('svg', {
        className: 'dsh-sysm-arrow', viewBox: '0 0 12 12', width: 12, height: 12,
        'aria-hidden': true, focusable: 'false',
      }, h('path', {
        d: path, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /** Right-aligned CPU history sparkline; the newest sample is rightmost. */
    function Spark({ values }) {
      const width = 48
      const height = 14
      const pad = 1.5
      const count = values.length
      if (count < 2) {
        return h('svg', {
          className: 'dsh-sysm-spark', viewBox: `0 0 ${width} ${height}`,
          width, height, 'aria-hidden': true, focusable: 'false',
        })
      }
      const step = (width - 2 * pad) / (HISTORY_POINTS - 1)
      const startX = width - pad - step * (count - 1)
      const points = values.map((value, index) => {
        const x = startX + step * index
        const clamped = Math.min(100, Math.max(0, value))
        const y = height - pad - (clamped / 100) * (height - 2 * pad)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      return h('svg', {
        className: 'dsh-sysm-spark', viewBox: `0 0 ${width} ${height}`,
        width, height, 'aria-hidden': true, focusable: 'false',
      }, h('polyline', {
        points: points.join(' '), fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /**
     * One strip item: optional leading glyph (spark/arrows), optional label,
     * fixed-width right-aligned value, optional sub text after the value.
     * The accessible name and hover title carry the full reading.
     */
    function Item({ lead, label, value, valueClass, sub, title }) {
      return h('span', { className: 'dsh-sysm-item', title, 'aria-label': title },
        lead ?? null,
        label === null ? null : h('span', { className: 'dsh-sysm-label' }, label),
        h('span', { className: `dsh-sysm-value ${valueClass ?? ''}`.trim() }, value),
        sub == null || sub === '' ? null : h('span', { className: 'dsh-sysm-sub' }, sub))
    }

    /** Build the dock strip component bound to this plugin context. */
    function makeStrip(ctx, t) {
      const timer = ctx.timer

      function SysMonitorStrip() {
        const [snap, setSnap] = React.useState(null)

        React.useEffect(() => {
          let alive = true
          let previous = null
          let lastApplied = null
          let failures = 0
          const cpuHistory = []

          async function poll() {
            let sample = null
            try {
              const response = await fetch(SAMPLE_URL, { cache: 'no-store' })
              if (response.ok) sample = await response.json()
            } catch {
              sample = null
            }
            if (!alive) return
            if (sample === null || typeof sample.t !== 'number' || sample.cpu === undefined) {
              // Transient failures keep the last readings dimmed; a sustained
              // outage stops displaying possibly minutes-old values.
              failures += 1
              setSnap(current => (failures >= FAILURE_BLANK
                ? {
                    online: false,
                    cpuHistory: [],
                    cpuPercent: null,
                    memPercent: null,
                    memUsedBytes: 0,
                    memTotalBytes: 0,
                    down: null,
                    up: null,
                  }
                : current === null
                  ? { online: false, cpuHistory: [] }
                  : { ...current, online: false }))
              return
            }
            // Drop late responses from an overlapping poll so an older sample
            // cannot rewind the display or the CPU delta baseline.
            if (lastApplied !== null && sample.t <= lastApplied) return
            lastApplied = sample.t
            failures = 0
            if (previous !== null && sample.t > previous.t
              && sample.cpu.total > previous.cpu.total) {
              const totalDelta = sample.cpu.total - previous.cpu.total
              const idleDelta = sample.cpu.idle - previous.cpu.idle
              const cpuPercent = Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100))
              cpuHistory.push(cpuPercent)
              if (cpuHistory.length > HISTORY_POINTS) {
                cpuHistory.splice(0, cpuHistory.length - HISTORY_POINTS)
              }
            }
            previous = sample
            const memPercent = sample.mem.total > 0
              ? ((sample.mem.total - sample.mem.available) / sample.mem.total) * 100
              : null
            setSnap({
              online: true,
              cpuPercent: cpuHistory.length > 0 ? cpuHistory[cpuHistory.length - 1] : null,
              cpuHistory: cpuHistory.slice(),
              memPercent,
              memUsedBytes: Math.max(0, sample.mem.total - sample.mem.available),
              memTotalBytes: sample.mem.total,
              down: sample.net != null && typeof sample.net.down === 'number' ? sample.net.down : null,
              up: sample.net != null && typeof sample.net.up === 'number' ? sample.net.up : null,
            })
          }

          const stopTimer = timer.interval(() => { void poll() }, POLL_MS)
          void poll()
          return () => {
            alive = false
            stopTimer()
          }
        }, [])

        const online = snap !== null && snap.online
        const cpuText = snap !== null && snap.cpuPercent !== null ? `${Math.round(snap.cpuPercent)}%` : '—'
        const memText = snap !== null && snap.memPercent !== null ? `${Math.round(snap.memPercent)}%` : '—'
        const memSub = snap !== null && snap.memTotalBytes > 0
          ? `${formatBytes(snap.memUsedBytes)}/${formatBytes(snap.memTotalBytes)}`
          : ''
        const downText = snap !== null && snap.down !== null ? formatRate(snap.down) : '—'
        const upText = snap !== null && snap.up !== null ? formatRate(snap.up) : '—'

        return h('div', {
          className: 'dsh-sysm-root',
          'data-online': online ? '1' : '0',
          title: t('title'),
          'aria-label': t('title'),
        },
          h('style', null, css),
          h(Item, {
            lead: h(Spark, { values: snap !== null ? snap.cpuHistory : [] }),
            label: t('cpu'), value: cpuText, title: `${t('cpu')} ${cpuText}`,
          }),
          h(Item, {
            label: t('mem'), value: memText, title: `${t('mem')} ${memText}${memSub === '' ? '' : ` (${memSub})`}`,
            sub: memSub === '' ? null : memSub,
          }),
          h(Item, {
            lead: h(Arrow, { down: true }),
            value: downText, valueClass: 'dsh-sysm-rate',
            title: `${t('down')} ${downText}`,
          }),
          h(Item, {
            lead: h(Arrow, { down: false }),
            value: upText, valueClass: 'dsh-sysm-rate',
            title: `${t('up')} ${upText}`,
          }))
      }

      return SysMonitorStrip
    }

    return {
      inject: ['slots', 'locale', 'timer'],
      apply(ctx) {
        const t = ctx.locale.bind('system-monitor')
        ctx.effect(() => {
          const stopLocale = ctx.locale.register('system-monitor', 'en', {
            title: 'System monitor',
            cpu: 'CPU',
            mem: 'MEM',
            down: 'Download',
            up: 'Upload',
          })
          return () => { stopLocale() }
        })
        ctx.effect(() => {
          const stopLocale = ctx.locale.register('system-monitor', 'zh', {
            title: '系统资源监控',
            cpu: 'CPU',
            mem: '内存',
            down: '下载',
            up: '上传',
          })
          return () => { stopLocale() }
        })
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'system-monitor',
            order: 5,
            label: () => t('title'),
          }, makeStrip(ctx, t))))
      },
    }
  },
})
