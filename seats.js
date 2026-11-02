'use strict'

/**
 * Seat map analysis: finds groups of adjacent free seats inside a zone.
 *
 * Orientation of the Vista seat map (from the renderer of the app,
 * seat-picker/positioning/screen.js + seat.js): by default the screen is at
 * the bottom and `rowNumber` runs from top to bottom. So a *higher* rowNumber
 * is closer to the screen. Front to back = rowNumber descending.
 * The Kinepolis row labels follow the same rule: label 1 = front row.
 *
 * The zone is given in fractions, not in row numbers. So the same config also
 * works in a screen with a different number of rows:
 *   rowsFrom/rowsTo  0 = screen, 1 = back row
 *   colsFrom/colsTo  0 = left, 1 = right
 */

const AVAILABLE = 'Available'

/** Rows with seats, front (at the screen) first. */
function rowsFrontToBack(area) {
    return area.rows.filter(r => r.seats.length > 0).sort((a, b) => b.number - a.number)
}

/**
 * Drawing order, taken from the app itself.
 *
 * Kinepolis sets `seatMap.screenPosition: "Top"` in the CMS configuration. In
 * `seat-picker/positioning/seat.js` that inverts both the rows and the columns:
 *   columnIndex = columnCount - columnNumber,  rowIndex = rowCount - rowNumber
 * That is a half turn, not a mirror. With the screen at the top, row 1 sits
 * directly below the screen and seat 1 runs from right to left -- the same as
 * in the app and on the website.
 */
const screenAtTop = cfg => (cfg && cfg.screenPosition ? cfg.screenPosition : 'top') === 'top'

function displayRows(area, screenTop) {
    const front = rowsFrontToBack(area)
    return screenTop ? front : front.reverse()
}

function displayCols(area, screenTop) {
    const cols = Array.from({ length: area.columnCount }, (_, i) => i + 1)
    return screenTop ? cols.reverse() : cols
}

/** Maximal runs of consecutive column numbers. */
function runs(cols) {
    const out = []
    for (const c of [...cols].sort((a, b) => a - b)) {
        const last = out[out.length - 1]
        if (last && c === last[last.length - 1] + 1) last.push(c)
        else out.push([c])
    }
    return out
}

/**
 * The centre block of a row: the block between the aisles that contains the
 * centre line of the screen. So we do not need to hard-code aisles.
 */
function centreBlock(row, area) {
    const blocks = runs(row.seats.map(s => s.position.columnNumber))
    const mid = (1 + area.columnCount) / 2
    let best = blocks[0]
    let bestDist = Infinity
    for (const b of blocks) {
        const dist = mid < b[0] ? b[0] - mid : mid > b[b.length - 1] ? mid - b[b.length - 1] : 0
        if (dist < bestDist) {
            bestDist = dist
            best = b
        }
    }
    return best
}

const ZONE_DEFAULTS = {
    minAdjacent: 3,
    rowsFrom: 0.45,
    rowsTo: 0.9,
    colsFrom: 0.28,
    colsTo: 0.72,
    // true = only the block between the aisles; false = the side blocks too,
    // where colsFrom/colsTo sets the width. With true, the column window can
    // never make the zone wider than the centre block.
    centreBlockOnly: true,
    screenPosition: 'top',
}

/**
 * Which seats belong to the zone? Returns the column interval per row, so we
 * can draw it on the map and explain it in the log.
 */
function zoneOf(layout, zoneCfg) {
    const z = { ...ZONE_DEFAULTS, ...(zoneCfg || {}) }
    const perRow = []
    for (const area of layout.areas) {
        const rows = rowsFrontToBack(area)
        rows.forEach((row, i) => {
            const depth = (i + 0.5) / rows.length
            if (depth < z.rowsFrom || depth > z.rowsTo) return
            const inWindow = c => {
                const f = (c - 0.5) / area.columnCount
                return f >= z.colsFrom && f <= z.colsTo
            }
            // Without the centre block limit, all seats of the row inside the
            // column window count. Aisles still break a group further on,
            // because those columns have no seat.
            const candidates = z.centreBlockOnly
                ? centreBlock(row, area)
                : row.seats.map(st => st.position.columnNumber).sort((a, b) => a - b)
            const cols = candidates.filter(inWindow)
            if (cols.length) {
                const seatAt = new Map(row.seats.map(s => [s.position.columnNumber, s]))
                perRow.push({
                    areaNumber: area.number,
                    rowNumber: row.number,
                    rowLabel: row.label,
                    from: cols[0],
                    to: cols[cols.length - 1],
                    fromLabel: seatAt.get(cols[0]).label,
                    toLabel: seatAt.get(cols[cols.length - 1]).label,
                })
            }
        })
    }
    return { z, perRow }
}

/**
 * Finds groups of at least `minAdjacent` adjacent free seats inside the zone.
 * An aisle, a sold seat, a broken seat or a blocked seat breaks a group.
 */
function findGroups(layout, availabilities, zoneCfg) {
    const status = new Map(availabilities.map(a => [a.seatId, a.status]))
    const { z, perRow } = zoneOf(layout, zoneCfg)
    const seatAt = new Map()
    for (const area of layout.areas) {
        for (const row of area.rows) {
            for (const s of row.seats) {
                seatAt.set(`${area.number}/${row.number}/${s.position.columnNumber}`, s)
            }
        }
    }

    const groups = []
    for (const zr of perRow) {
        const free = []
        for (let c = zr.from; c <= zr.to; c++) {
            const s = seatAt.get(`${zr.areaNumber}/${zr.rowNumber}/${c}`)
            if (s && status.get(s.id) === AVAILABLE) free.push(c)
        }
        for (const run of runs(free)) {
            if (run.length < z.minAdjacent) continue
            const first = seatAt.get(`${zr.areaNumber}/${zr.rowNumber}/${run[0]}`)
            const last = seatAt.get(`${zr.areaNumber}/${zr.rowNumber}/${run[run.length - 1]}`)
            groups.push({
                areaNumber: zr.areaNumber,
                rowLabel: zr.rowLabel,
                count: run.length,
                cols: run,
                fromLabel: first.label,
                toLabel: last.label,
                seatIds: run.map(c => seatAt.get(`${zr.areaNumber}/${zr.rowNumber}/${c}`).id),
            })
        }
    }
    groups.sort((a, b) => b.count - a.count)
    return { groups, zone: { ...z, rows: perRow.map(r => r.rowLabel) } }
}

const describeGroups = (groups, max = 4) => {
    const txt = groups
        .slice(0, max)
        .map(g => `row ${g.rowLabel}: ${g.fromLabel}-${g.toLabel} (${g.count})`)
        .join(', ')
    return groups.length > max ? `${txt}, +${groups.length - max} more` : txt
}

/**
 * ASCII map, useful to check the zone. Screen at the bottom, as the app draws
 * it. Seats inside the zone get their own symbol, so the band stands out:
 *
 *   O free in the zone   = sold in the zone
 *   . free               # sold         x broken     H blocked
 */
function renderMap(layout, availabilities, zoneCfg) {
    const status = new Map(availabilities.map(a => [a.seatId, a.status]))
    const { perRow } = zoneOf(layout, zoneCfg)
    const inZone = new Map(perRow.map(r => [`${r.areaNumber}/${r.rowNumber}`, r]))
    const glyph = { Available: '.', Sold: '#', Broken: 'x', House: 'H' }
    const zoneGlyph = { Available: 'O', Sold: '=', Broken: 'x', House: 'H' }
    const top = screenAtTop(zoneCfg)
    const lines = []
    for (const area of layout.areas) {
        const cols = displayCols(area, top)
        const screen = [
            `${' '.repeat(9)}${'SCREEN'.padStart(Math.floor(area.columnCount / 2) + 3)}`,
            `${' '.repeat(9)}${'-'.repeat(area.columnCount)}`,
        ]
        if (top) lines.push(...screen)

        // A seat label ruler: the column numbers from the API are not the
        // numbers printed on the seats, and those are the ones you want to read.
        const widest = area.rows.reduce((a, r) => (r.seats.length > a.seats.length ? r : a), area.rows[0])
        const labelAt = new Map(widest.seats.map(s => [s.position.columnNumber, s.label]))
        let ruler = ''
        for (const c of cols) {
            const l = labelAt.get(c)
            ruler += l && Number(l) % 5 === 0 ? String(Number(l) % 10) : ' '
        }
        lines.push(`${' '.repeat(8)} ${ruler}   (seat number, multiples of 5)`)

        for (const row of displayRows(area, top)) {
            const zr = inZone.get(`${area.number}/${row.number}`)
            const byCol = new Map(row.seats.map(s => [s.position.columnNumber, s]))
            let line = ''
            for (const c of cols) {
                const s = byCol.get(c)
                if (!s) {
                    line += ' '
                    continue
                }
                const st = status.get(s.id)
                const z = zr && c >= zr.from && c <= zr.to
                line += (z ? zoneGlyph : glyph)[st] || '?'
            }
            lines.push(`row ${String(row.label).padStart(3)} |${line}|${zr ? ' <- zone' : ''}`)
        }
        if (!top) lines.push(...[...screen].reverse())
    }
    return lines.join('\n')
}

/**
 * Draws the seat map with only the watched seats on it, without availability.
 * Meant to show at startup which seats the script watches. It costs no API
 * call, because the seat map is cached.
 *
 * `colour` turns on ANSI colours (only useful on a terminal).
 */
function renderZonePlan(layout, zoneCfg, colour = false) {
    const { z, perRow } = zoneOf(layout, zoneCfg)
    const inZone = new Map(perRow.map(r => [`${r.areaNumber}/${r.rowNumber}`, r]))
    const green = t => (colour ? `\x1b[32m${t}\x1b[0m` : t)
    const dim = t => (colour ? `\x1b[90m${t}\x1b[0m` : t)

    const top = screenAtTop(zoneCfg)
    const lines = []
    for (const area of layout.areas) {
        const cols = displayCols(area, top)
        const screen = [
            `${' '.repeat(9)}${dim('SCREEN'.padStart(Math.floor(area.columnCount / 2) + 3))}`,
            `${' '.repeat(9)}${dim('-'.repeat(area.columnCount))}`,
        ]
        if (top) lines.push(...screen)

        const widest = area.rows.reduce((a, r) => (r.seats.length > a.seats.length ? r : a), area.rows[0])
        const labelAt = new Map(widest.seats.map(s => [s.position.columnNumber, s.label]))
        let ruler = ''
        for (const c of cols) {
            const l = labelAt.get(c)
            ruler += l && Number(l) % 5 === 0 ? String(Number(l) % 10) : ' '
        }
        lines.push(`${' '.repeat(8)} ${dim(ruler)}`)

        for (const row of displayRows(area, top)) {
            const zr = inZone.get(`${area.number}/${row.number}`)
            const byCol = new Map(row.seats.map(s => [s.position.columnNumber, s]))
            let line = ''
            for (const c of cols) {
                if (!byCol.has(c)) line += ' '
                else if (zr && c >= zr.from && c <= zr.to) line += green('O')
                else line += dim('·')
            }
            const tail = zr ? `  seat ${zr.fromLabel}-${zr.toLabel}` : ''
            lines.push(`row ${String(row.label).padStart(3)} |${line}|${tail}`)
        }
        if (!top) lines.push(...[...screen].reverse())
    }
    return { text: lines.join('\n'), zone: z, rows: perRow }
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

/**
 * Colours from Kinepolis itself, not invented:
 *
 *   #75d4fa  free seat     -- CMS: themes.Default.seatMapRules[0].available.normal.color
 *                            (also for wheelchair and companion)
 *   #f8e71c  free sofa     -- same, .available.sofa.color
 *   #484a52  taken         -- design token color-grey-800; the CMS has
 *                            `unavailable: null`, so the app falls back to this token
 *   #1e2123  background    -- read from the app itself; the tokens
 *                            background.screen (#0e0e0f) and color-grey-1000
 *                            (#1e2129) are close but not equal
 *   #1e2129  card/panel    -- token background.card, also color-grey-1000
 *   #878c99  muted text    -- color-grey-600
 *   #e6e7eb  text          -- color-grey-300
 *   #ffa300  accent        -- token notification.warning, used here for the outline
 *
 * The app draws seats as icons (`normal-seat`, `normal-seat-house`). We keep
 * it to small rectangles with the same fill colours.
 */
const PALETTE = {
    bg: '#1e2123',
    panel: '#1e2129',
    text: '#e6e7eb',
    dim: '#878c99',
    zoneFill: 'rgba(117,212,250,0.10)',
    zoneLine: '#75d4fa',
    group: '#ffa300',
    screen: '#e6e7eb',
    seat: {
        Available: '#75d4fa',
        AvailableZone: '#75d4fa',
        Sofa: '#f8e71c',
        Sold: '#484a52',
        Broken: '#323642',
        House: '#5a5d66',
    },
}

const CELL = 17
const GAP = 2.2
const PAD = { left: 52, right: 52, top: 16, bottom: 58 }

const esc = t =>
    String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/**
 * Draws one screen as an SVG fragment. The seats sit on an even grid, as in
 * the app: it scales the area from `area.boundary` over `columnCount` x
 * `rowCount` equal cells.
 */
function renderArea(area, status, zoneRows, groups, y0, screenTop) {
    // Without availability we draw only the zone: watched seats on, the rest
    // dimmed. That is the image for the start message.
    const zoneOnly = status.size === 0
    const rows = displayRows(area, screenTop)
    const zone = new Map(zoneRows.map(r => [r.rowNumber, r]))
    const parts = []
    const width = area.columnCount * CELL
    const SCREEN_SPACE = 34

    // x of a column number, with the same mirroring as the app when the screen is at the top.
    const xOf = c => PAD.left + (screenTop ? area.columnCount - c : c - 1) * CELL
    // A column interval [from..to] as a rectangle, regardless of mirroring.
    const spanOf = (from, to) => ({
        x: Math.min(xOf(from), xOf(to)),
        width: (to - from + 1) * CELL,
    })

    const rowsTop = y0 + (screenTop ? SCREEN_SPACE : 0)
    const yOf = i => rowsTop + i * CELL

    // Zone band per row, below the seats.
    for (const [i, row] of rows.entries()) {
        const zr = zone.get(row.number)
        if (!zr) continue
        const sp = spanOf(zr.from, zr.to)
        parts.push(
            `<rect x="${sp.x - 1}" y="${yOf(i) - 1}" width="${sp.width + 2}" ` +
                `height="${CELL + 2}" fill="${PALETTE.zoneFill}"/>`
        )
    }
    // One frame around the whole zone, so the band reads as one unit.
    const zrs = rows.map((r, i) => ({ zr: zone.get(r.number), i })).filter(x => x.zr)
    if (zrs.length) {
        const from = Math.min(...zrs.map(x => x.zr.from))
        const to = Math.max(...zrs.map(x => x.zr.to))
        const sp = spanOf(from, to)
        const first = Math.min(...zrs.map(x => x.i))
        const last = Math.max(...zrs.map(x => x.i))
        parts.push(
            `<rect x="${sp.x - 3}" y="${yOf(first) - 3}" width="${sp.width + 6}" ` +
                `height="${(last - first + 1) * CELL + 6}" rx="5" fill="none" ` +
                `stroke="${PALETTE.zoneLine}" stroke-dasharray="4 3"/>`
        )
    }

    for (const [i, row] of rows.entries()) {
        const zr = zone.get(row.number)
        const y = yOf(i)
        for (const seat of row.seats) {
            const c = seat.position.columnNumber
            const st = status.get(seat.id) || 'Sold'
            const inZone = zr && c >= zr.from && c <= zr.to
            const isSofa = String(seat.type).startsWith('Sofa')
            const fill = zoneOnly
                ? inZone
                    ? PALETTE.seat.AvailableZone
                    : PALETTE.seat.Sold
                : st !== 'Available'
                  ? PALETTE.seat[st] || PALETTE.seat.Sold
                  : isSofa
                    ? PALETTE.seat.Sofa
                    : PALETTE.seat.Available
            const x = xOf(c)
            parts.push(
                `<rect x="${(x + GAP).toFixed(1)}" y="${(y + GAP).toFixed(1)}" ` +
                    `width="${(CELL - 2 * GAP).toFixed(1)}" height="${(CELL - 2 * GAP).toFixed(1)}" ` +
                    `rx="2.5" fill="${fill}"/>`
            )
            if (st === 'Broken' && !zoneOnly) {
                const a = x + CELL / 2 - 3
                const b = y + CELL / 2 - 3
                parts.push(
                    `<path d="M${a} ${b} l6 6 M${a + 6} ${b} l-6 6" stroke="${PALETTE.dim}" ` +
                        `stroke-width="1.2" fill="none"/>`
                )
            }
        }
        // Row label on the left and on the right.
        const ty = y + CELL / 2 + 4
        parts.push(
            `<text x="${PAD.left - 10}" y="${ty}" text-anchor="end" font-size="11" ` +
                `fill="${zr ? PALETTE.text : PALETTE.dim}">${esc(row.label)}</text>`,
            `<text x="${PAD.left + width + 10}" y="${ty}" font-size="11" ` +
                `fill="${zr ? PALETTE.text : PALETTE.dim}">${esc(row.label)}</text>`
        )
    }

    // Outline the groups: that is what this is about.
    const rowIndex = new Map(rows.map((r, i) => [r.label, i]))
    for (const g of groups) {
        const i = rowIndex.get(g.rowLabel)
        if (i == null) continue
        const sp = spanOf(g.cols[0], g.cols[g.cols.length - 1])
        parts.push(
            `<rect x="${sp.x - 1.5}" y="${yOf(i) - 1.5}" width="${sp.width + 3}" ` +
                `height="${CELL + 3}" rx="4" fill="none" stroke="${PALETTE.group}" stroke-width="1.8"/>`
        )
    }

    // The screen: at the top or at the bottom, as in the app.
    const sy = screenTop ? y0 + 16 : yOf(rows.length) + 22
    const bend = screenTop ? 9 : -9
    parts.push(
        `<path d="M${PAD.left} ${sy} Q${PAD.left + width / 2} ${sy + bend} ${PAD.left + width} ${sy}" ` +
            `stroke="${PALETTE.screen}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
        `<text x="${PAD.left + width / 2}" y="${screenTop ? sy - 9 : sy + 18}" text-anchor="middle" ` +
            `font-size="10" letter-spacing="3" fill="${PALETTE.dim}">SCREEN</text>`
    )
    return { svg: parts.join('\n'), height: rows.length * CELL + 46 + (screenTop ? SCREEN_SPACE : 0), width }
}

/**
 * Builds an SVG of one or more screenings, stacked.
 * `items` = [{ title, subtitle, layout, availabilities }].
 */
function renderSvg(items, zoneCfg) {
    const blocks = []
    let y = PAD.top
    let maxWidth = 0

    for (const item of items) {
        const status = new Map(item.availabilities.map(a => [a.seatId, a.status]))
        const { perRow } = zoneOf(item.layout, zoneCfg)
        const { groups } = findGroups(item.layout, item.availabilities, zoneCfg)

        blocks.push(
            `<text x="${PAD.left}" y="${y + 14}" font-size="14" font-weight="600" ` +
                `fill="${PALETTE.text}">${esc(item.title)}</text>`
        )
        if (item.subtitle) {
            blocks.push(
                `<text x="${PAD.left}" y="${y + 31}" font-size="11.5" ` +
                    `fill="${PALETTE.dim}">${esc(item.subtitle)}</text>`
            )
        }
        y += item.subtitle ? 44 : 28

        const screenTop = screenAtTop(zoneCfg)
        for (const area of item.layout.areas) {
            const zoneRows = perRow.filter(r => r.areaNumber === area.number)
            const areaGroups = groups.filter(g => g.areaNumber === area.number)
            const r = renderArea(area, status, zoneRows, areaGroups, y, screenTop)
            blocks.push(r.svg)
            y += r.height
            maxWidth = Math.max(maxWidth, PAD.left + r.width + PAD.right)
        }
        y += 26
    }

    // Legend. For a zone-only image, everything about sales is left out.
    const zoneOnly = items.every(i => !i.availabilities || !i.availabilities.length)
    const legend = zoneOnly
        ? [
              ['Watched', PALETTE.seat.AvailableZone],
              ['Outside the zone', PALETTE.seat.Sold],
          ]
        : [
              ['Free', PALETTE.seat.Available],
              ['Taken', PALETTE.seat.Sold],
              ['Broken', PALETTE.seat.Broken],
              ['Blocked', PALETTE.seat.House],
          ]
    let lx = PAD.left
    const ly = y + 6
    for (const [label, colour] of legend) {
        blocks.push(
            `<rect x="${lx}" y="${ly - 9}" width="12" height="12" rx="2.5" fill="${colour}"/>`,
            `<text x="${lx + 18}" y="${ly + 1}" font-size="11" fill="${PALETTE.dim}">${esc(label)}</text>`
        )
        lx += 30 + label.length * 6.4
    }
    if (!zoneOnly) {
        blocks.push(
            `<rect x="${lx}" y="${ly - 9}" width="12" height="12" rx="2.5" fill="none" ` +
                `stroke="${PALETTE.group}" stroke-width="1.8"/>`,
            `<text x="${lx + 18}" y="${ly + 1}" font-size="11" fill="${PALETTE.dim}">` +
                `group that triggers an alert</text>`
        )
    }
    y = ly + 22

    const width = Math.max(maxWidth, lx + 240)
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(y)}" ` +
        `viewBox="0 0 ${Math.round(width)} ${Math.round(y)}" font-family="ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif">\n` +
        `<rect width="100%" height="100%" fill="${PALETTE.bg}"/>\n` +
        blocks.join('\n') +
        `\n</svg>\n`
    )
}

module.exports = {
    findGroups,
    describeGroups,
    renderMap,
    renderSvg,
    renderZonePlan,
    zoneOf,
    ZONE_DEFAULTS,
}
