import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Progress } from '../types'

const PLUGIN = 'progress-eta'
const TOOL_NAME = 'set_progress'
const TOOL = `mcp__${PLUGIN}__${TOOL_NAME}`

const MINUTE = 60_000
// The countdown ticks every second, and only while a bar with an ETA is up.
// It redraws the band alone; the model is never woken by it.
const REDRAW_MS = 1_000
// A reminder rides along with a tool result the main agent already gets, and
// never more often than this since the last update or the last reminder.
const REMIND_AFTER_MS = 10 * MINUTE
// Sooner once the ETA has passed, since the estimate is plainly wrong then.
const REMIND_OVERDUE_MS = 5 * MINUTE

const progress = atom({ plugin: 'progress-eta', key: 'progress' } as const, null, {
  shape: 'progress-1',
})
const tick = atom({ plugin: 'progress-eta', key: 'tick' } as const, 0)

const DESCRIPTION = [
  'Sets or updates the progress bar with an ETA shown to the user above the prompt.',
  'Use it when you are orchestrating multi-step or long-running work (subagents, sessions, builds):',
  'set it when the work starts, update it when a milestone completes or your estimate changes,',
  'and clear it when the work is done or abandoned. Keep updates meaningful, not every step.',
  'percent is overall completion 0-100; between updates the bar advances on its own toward 100% as the ETA runs out.',
  'eta_minutes is your best estimate of minutes remaining;',
  'omit it to keep the current ETA, or pass null for no ETA. label names the overall task',
  '(kept from the last call when omitted). note is a short status line such as "3 of 8 threads done".',
].join(' ')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    percent: { type: 'number', minimum: 0, maximum: 100, description: 'Overall completion, 0-100.' },
    eta_minutes: {
      type: ['number', 'null'],
      minimum: 0,
      description: 'Estimated minutes remaining. Omit to keep the current ETA; null removes it.',
    },
    label: { type: 'string', description: 'Short name of the overall task.' },
    note: { type: 'string', description: 'Short current status, e.g. "3 of 8 threads done".' },
    clear: { type: 'boolean', description: 'True removes the progress bar.' },
  },
  additionalProperties: false,
}

type Args = {
  percent?: unknown
  eta_minutes?: unknown
  label?: unknown
  note?: unknown
  clear?: unknown
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const short = (value: string, max: number) => {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export const formatMinutes = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

export const etaText = (p: Progress, now: number) => {
  if (p.percent >= 100) return 'done'
  if (p.etaAt === null) return 'no ETA'
  const left = p.etaAt - now
  return left >= 0 ? `~${formatMinutes(left)} left` : `overdue by ${formatMinutes(-left)}`
}

// Gradient stops, left to right; the last one also colors the label and percent.
const RUNNING = ['#6D5BFF', '#3B82F6', '#22D3EE']
const OVERDUE = ['#F59E0B', '#F97316', '#EF4444']
const DONE = ['#10B981', '#34D399', '#6EE7B7']
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
// The fill is drawn in this many color bands, so a wide bar stays a few nodes.
const BANDS = 12

const mix = (from: string, to: string, t: number) => {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const out = [0, 1, 2].map(i => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t))
  return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

const colorAt = (stops: string[], t: number) => {
  const span = (stops.length - 1) * Math.min(1, Math.max(0, t))
  const i = Math.min(stops.length - 2, Math.floor(span))
  return mix(stops[i] as string, stops[i + 1] as string, span - i)
}

export type Segment = { text: string; color: string; isTrack: boolean }

// A full-width bar: the fill in gradient bands with a sub-cell leading edge,
// then a dim track.
export const gradientBar = (percent: number, columns: number, stops: string[]): Segment[] => {
  const eighths = Math.round((Math.min(100, Math.max(0, percent)) / 100) * columns * 8)
  const full = Math.floor(eighths / 8)
  const edge = EIGHTHS[eighths % 8] as string
  const segments: Segment[] = []
  const band = Math.max(1, Math.ceil(columns / BANDS))
  for (let start = 0; start < full; start += band) {
    const length = Math.min(band, full - start)
    segments.push({ text: '█'.repeat(length), color: colorAt(stops, (start + length / 2) / columns), isTrack: false })
  }
  if (edge !== '') segments.push({ text: edge, color: colorAt(stops, full / columns), isTrack: false })
  const used = full + (edge === '' ? 0 : 1)
  if (used < columns) segments.push({ text: '█'.repeat(columns - used), color: '', isTrack: true })
  return segments
}

// Readable on light and dark backgrounds alike.
const TRACK = 'rgba(128, 128, 128, 0.22)'

// The fill's color bands: each takes the gradient's color at its own place
// along the whole bar, so a short fill shows only the gradient's start.
export const fillBands = (percent: number, stops: string[]) => {
  const reach = Math.min(100, Math.max(0, percent)) / 100
  const count = Math.max(1, Math.round(BANDS * 2 * reach))
  return Array.from({ length: count }, (_, i) => colorAt(stops, ((i + 0.5) / count) * reach))
}

const clockFace = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(h)}:${two(m)}:${two(s)}`
}

// What the bar shows: the last reported percent, moving toward 100% as the
// ETA runs out, so the fill keeps pace with the countdown. 0% with 14 minutes
// left reads 50% seven minutes later. It holds at 99% past the ETA until the
// agent reports the work done.
export const shownPercent = (p: Progress, now: number) => {
  if (p.percent >= 100) return 100
  if (p.etaAt === null || p.etaAt <= p.updatedAt) return p.percent
  const elapsed = Math.min(1, Math.max(0, (now - p.updatedAt) / (p.etaAt - p.updatedAt)))
  return Math.min(99, p.percent + (100 - p.percent) * elapsed)
}

// The live countdown the band shows, to the second.
export const countdown = (p: Progress, now: number) => {
  if (p.percent >= 100) return 'done'
  if (p.etaAt === null) return 'no ETA'
  const left = p.etaAt - now
  return left >= 0 ? `${clockFace(left)} left` : `+${clockFace(-left)} over`
}

export const register: Register = on => {
  let remindedAt = 0

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'progress-clear',
      description: 'Remove the progress bar',
    })
    $.clock.every(REDRAW_MS, () => {
      void (async () => {
        const p = await read($, progress)
        if (p !== null && p.etaAt !== null && p.percent < 100) await update($, tick, n => n + 1)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'progress-clear' }, async $ => {
    await update($, progress, () => null)
    return { text: 'Progress bar cleared.' }
  })

  on('tool.call', { tool: 'mcp__progress-eta__set_progress' }, async ($, e) => {
    const args = e as unknown as Args
    const now = await $.clock.now()

    if (args.clear === true) {
      await update($, progress, () => null)
      return { result: 'Progress bar cleared.' }
    }

    const previous = await read($, progress)
    if (!isNumber(args.percent)) {
      return { deny: 'set_progress needs percent (a number from 0 to 100), or clear: true.' }
    }
    if (args.eta_minutes !== undefined && args.eta_minutes !== null && !(isNumber(args.eta_minutes) && args.eta_minutes >= 0)) {
      return { deny: `set_progress: eta_minutes must be a number of minutes, 0 or more, or null; got ${JSON.stringify(args.eta_minutes)}.` }
    }

    const label =
      typeof args.label === 'string' && args.label.trim() !== ''
        ? short(args.label, 80)
        : previous?.label ?? 'Working'
    const etaAt =
      args.eta_minutes === undefined
        ? previous?.etaAt ?? null
        : args.eta_minutes === null
          ? null
          : now + (args.eta_minutes as number) * MINUTE
    const next: Progress = {
      label,
      percent: Math.min(100, Math.max(0, args.percent)),
      note: typeof args.note === 'string' && args.note.trim() !== '' ? short(args.note, 120) : null,
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
      etaAt,
    }
    await update($, progress, () => next)
    remindedAt = 0

    return {
      result: `Progress bar set: ${label}, ${Math.round(next.percent)}%, ${etaText(next, now)}.`,
    }
  })

  // The reminder: no timer and no turn of its own. When the main agent is
  // already working and gets a tool result, a stale bar adds one line to it.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === TOOL || e.agentId !== undefined || ran.deny !== undefined) return ran

    const p = await read($, progress)
    if (p === null || p.percent >= 100) return ran

    const now = await $.clock.now()
    const isOverdue = p.etaAt !== null && now > p.etaAt
    const quietFor = now - Math.max(p.updatedAt, remindedAt)
    if (quietFor < (isOverdue ? REMIND_OVERDUE_MS : REMIND_AFTER_MS)) return ran

    remindedAt = now
    const why = isOverdue
      ? `Its ETA passed ${formatMinutes(now - (p.etaAt as number))} ago.`
      : `It was last updated ${formatMinutes(now - p.updatedAt)} ago.`
    const reminder =
      `The progress bar the user sees reads "${p.label}: ${Math.floor(shownPercent(p, now))}%, ${etaText(p, now)}". ${why} ` +
      `If progress or your estimate has changed, update it with ${TOOL}; if the work is done, clear it. ` +
      `If it is still accurate, carry on. Do not mention this reminder to the user.`

    return { ...ran, context: [...(ran.context ?? []), reminder] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, progress)
    if (p === null || e.props.hasSurvey) return next(e)

    await read($, tick)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)
    const isDone = p.percent >= 100
    const isOverdue = !isDone && p.etaAt !== null && now > p.etaAt
    const palette = isDone ? DONE : isOverdue ? OVERDUE : RUNNING
    const columns = Math.max(16, (e.props.bodyColumns ?? 60) - 1)
    const shown = shownPercent(p, now)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" flexShrink={1} gap={1}>
            <Text bold color={palette[palette.length - 1]} wrap="truncate-end">
              {p.label}
            </Text>
            {p.note !== null && (
              <Text dimColor wrap="truncate-end">
                {p.note}
              </Text>
            )}
          </Box>
          <Button
            key="clear"
            label="×"
            role="dismiss"
            plain
            dimColor
            onPress={() => update($, progress, () => null)}
          />
        </Box>
        {e.surface === 'terminal' ? (
          // Character cells: block glyphs, the track in the same glyph dimmed.
          <Box flexDirection="row">
            {gradientBar(shown, columns, palette).map(({ text, color, isTrack }) =>
              isTrack ? <Text dimColor>{text}</Text> : <Text color={color}>{text}</Text>,
            )}
          </Box>
        ) : (
          // The apps lay Boxes out natively: a solid track with the fill on it,
          // the fill a row of color bands so it reads as one gradient.
          <Box flexDirection="row" width="100%" height={1} backgroundColor={TRACK}>
            {/* Widths take whole percents only; flexGrow shares split the row
                to any fraction, so the fill glides with the countdown. */}
            {shown > 0 && (
              <Box flexDirection="row" flexGrow={shown} height={1}>
                {fillBands(shown, palette).map(color => (
                  <Box flexGrow={1} height={1} backgroundColor={color} />
                ))}
              </Box>
            )}
            {shown < 100 && <Box flexGrow={100 - shown} height={1} />}
          </Box>
        )}
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={palette[palette.length - 1]}>
            {Math.floor(shown)}%
          </Text>
          <Text color={isOverdue ? 'warning' : undefined} dimColor={!isOverdue}>
            {countdown(p, now)}
          </Text>
        </Box>
      </Box>
    )
  })
}
