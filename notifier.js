#!/usr/bin/env node
'use strict'

/**
 * Notifier for new Kinepolis screenings and seats that become free.
 *
 * Each run compares the current screenings with the previous run and reports:
 *   - new screening      : a showtime id that we did not know yet
 *   - new screening day  : a date on which the film was not scheduled yet
 *   - good seats free    : a group of adjacent free seats in the zone from
 *                          config.seats (see seats.js)
 *
 * A screening where only single or bad seats become free does not produce a
 * message. That is exactly the noise we do not want.
 *
 *
 * Usage:
 *   node notifier.js --find <title>   find the film id for config.json (or run: node setup.js)
 *   node notifier.js                  run once (for cron)
 *   node notifier.js --loop           keep running, interval from config
 *   node notifier.js --map [day|id]   seat maps as text, with the zone marked
 *   node notifier.js --testpush       send one test message with a seat map
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { api, getAuthToken, setThrottle } = require('./kinepolis-api')
const { findGroups, describeGroups, renderMap, renderSvg, renderZonePlan } = require('./seats')
const { lookupFilms, describeFilm } = require('./lookup')

const HERE = __dirname
// In a container, the state, the seat map cache and the log are on a volume (STATE_DIR).
// Locally they are next to the script.
const DATA_DIR = process.env.STATE_DIR || HERE
const CONFIG_PATH = path.join(HERE, 'config.json')
const STATE_PATH = path.join(DATA_DIR, 'state.json')
const LAYOUTS_PATH = path.join(DATA_DIR, 'layouts.json')
// LOG_FILE=0 disables the log file (in a container, stdout is sufficient).
const LOG_PATH = process.env.LOG_FILE === '0' ? null : path.join(DATA_DIR, 'notifier.log')

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

function log(msg) {
    const line = `${new Date().toISOString()} ${msg}`
    console.log(line)
    if (!LOG_PATH) return
    try {
        fs.appendFileSync(LOG_PATH, line + '\n')
    } catch {
        /* the log must never break the run */
    }
}

// ---------------------------------------------------------------------------
// config & state
// ---------------------------------------------------------------------------

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        log(`ERROR: ${CONFIG_PATH} does not exist`)
        process.exit(2)
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
}

function loadState() {
    if (!fs.existsSync(STATE_PATH)) return { firstRun: true, showtimes: {}, auth: null }
    try {
        const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
        s.showtimes = s.showtimes || {}
        return s
    } catch (err) {
        log(`state not readable (${err.message}); starting again`)
        return { firstRun: true, showtimes: {}, auth: null }
    }
}

function saveState(state) {
    // Atomic write. Otherwise a crash leaves a partial state file.
    const tmp = STATE_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
    fs.renameSync(tmp, STATE_PATH)
}

/**
 * Seat maps are large (~70 KB) but do not change. A changed screen gets a new
 * id. So we cache them on disk and fetch each one only once.
 */
function loadLayouts() {
    if (!fs.existsSync(LAYOUTS_PATH)) return {}
    try {
        return JSON.parse(fs.readFileSync(LAYOUTS_PATH, 'utf8'))
    } catch (err) {
        log(`layouts.json not readable (${err.message}); fetching again`)
        return {}
    }
}

function saveLayouts(layouts) {
    const tmp = LAYOUTS_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(layouts))
    fs.renameSync(tmp, LAYOUTS_PATH)
}

async function getLayout(token, layoutId, cache) {
    if (cache[layoutId]) return cache[layoutId]
    const { seatLayout } = await api.seatLayout(token, layoutId)
    cache[layoutId] = seatLayout
    saveLayouts(cache)
    log(`seat map ${layoutId} fetched and cached`)
    return seatLayout
}

// ---------------------------------------------------------------------------
// notification channels
// ---------------------------------------------------------------------------

/**
 * Pushover accepts only bitmaps as attachment, not SVG. So we rasterize the
 * seat map with rsvg-convert. If that program is missing, the message goes
 * out without an image. A missed message is worse than a message without an
 * image.
 */
function renderPng(svg, zoom = 1.5) {
    return new Promise(resolve => {
        const tmp = path.join(os.tmpdir(), `kinepolis-${process.pid}-${Date.now()}.svg`)
        try {
            fs.writeFileSync(tmp, svg)
        } catch (err) {
            log(`could not write svg: ${err.message}`)
            return resolve(null)
        }
        execFile(
            'rsvg-convert',
            ['-z', String(zoom), tmp, '-b', '#0e1116'],
            { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
            (err, stdout) => {
                fs.unlink(tmp, () => {})
                if (err) {
                    log(`rsvg-convert failed (${err.message}); message goes out without image`)
                    return resolve(null)
                }
                resolve(stdout)
            }
        )
    })
}

// Pushover rejects attachments above 2.5 MB. Keep a margin, because base64
// makes the sent message a third larger.
const MAX_ATTACHMENT = 2_000_000

/**
 * Pushover sends each request to one user or group key. With several
 * recipients, one request goes out per key. One failing key must not block
 * the others.
 */
async function notifyPushover(token, users, title, body, attachment) {
    const extra =
        attachment && attachment.length
            ? { attachment_base64: attachment.toString('base64'), attachment_type: 'image/png' }
            : {}
    for (const user of users) {
        try {
            const res = await fetch('https://api.pushover.net/1/messages.json', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, user, title, message: body, priority: 1, ...extra }),
            })
            if (!res.ok) {
                const t = await res.text()
                log(`pushover (${maskKey(user)}) returned HTTP ${res.status}: ${t.slice(0, 200)}`)
            }
        } catch (err) {
            log(`pushover (${maskKey(user)}) failed: ${err.message}`)
        }
    }
}

/** Never write a full key to the log file. */
const maskKey = k => (k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '…')

/**
 * Secrets come from secrets.json (not in git) or from the environment.
 * The environment wins, so you can also pass them to a container.
 */
function loadSecrets() {
    let file = {}
    const p = path.join(HERE, 'secrets.json')
    if (fs.existsSync(p)) {
        try {
            file = JSON.parse(fs.readFileSync(p, 'utf8'))
        } catch (err) {
            log(`secrets.json not readable: ${err.message}`)
        }
    }
    // PUSHOVER_USER can be a single key, a comma- or space-separated list,
    // or (in secrets.json) an array.
    const rawUsers = process.env.PUSHOVER_USER || file.PUSHOVER_USER
    const pushoverUsers = (Array.isArray(rawUsers) ? rawUsers : String(rawUsers || '').split(/[\s,;]+/))
        .map(s => String(s).trim())
        .filter(Boolean)

    const rawAdmins = process.env.PUSHOVER_ADMIN || file.PUSHOVER_ADMIN
    const pushoverAdmins = (Array.isArray(rawAdmins) ? rawAdmins : String(rawAdmins || '').split(/[\s,;]+/))
        .map(s => String(s).trim())
        .filter(Boolean)

    return {
        pushoverToken: process.env.PUSHOVER_TOKEN || file.PUSHOVER_TOKEN,
        pushoverUsers,
        pushoverAdmins,
    }
}

async function notify(cfg, title, body, attachment) {
    const sec = loadSecrets()
    if (!sec.pushoverToken || !sec.pushoverUsers.length) {
        log(`WARNING: no PUSHOVER_TOKEN/PUSHOVER_USER; not sent: [${title}]`)
        return
    }
    await notifyPushover(sec.pushoverToken, sec.pushoverUsers, title, body, attachment)
}

/**
 * Problems with the notifier itself go to PUSHOVER_ADMIN, not to the normal
 * recipients. They want to hear about seats, not about tokens.
 */
async function notifyAdmin(title, body) {
    const sec = loadSecrets()
    if (!sec.pushoverToken || !sec.pushoverAdmins.length) {
        log(`no PUSHOVER_ADMIN; not sent: [${title}] ${body}`)
        return
    }
    await notifyPushover(sec.pushoverToken, sec.pushoverAdmins, title, body)
    log(`admin notified: ${title}`)
}

// ---------------------------------------------------------------------------
// fetch screenings
// ---------------------------------------------------------------------------

const textOf = v => (v && typeof v === 'object' ? v.text : v) || ''

// Remember how far ahead the API publishes. Only for the start message: it
// must make clear that new screening days are picked up automatically, and
// must not look as if monitoring stops at the last known day.
let lastHorizon = null

/** The film ids to watch, from config.filter.filmIds (find them with --find). */
function resolveFilmIds(cfg) {
    return new Set((cfg.filter || {}).filmIds || [])
}

/**
 * Fetch all screenings that match the filter, including free seats.
 * Returns an array of flat objects.
 */
async function fetchShowings(token, cfg) {
    const flt = cfg.filter
    const siteIds = flt.siteIds

    // 1. Translate titles to film ids. `film-screening-dates` only knows ids.
    //    Without this step we would have to fetch every screening day
    //    (76 calls instead of a handful).
    const filmIds = resolveFilmIds(cfg)
    if (filmIds.size === 0) {
        log('no film matches the filter')
        const err = new Error('no film matches the filter (film no longer scheduled?)')
        err.filmGone = true
        throw err
    }

    // 2. Which screening days qualify? The API publishes them more than half a
    //    year ahead, so new screening days are picked up automatically.
    const { filmScreeningDates } = await api.filmScreeningDates(token, siteIds)
    const candidateDates = []
    for (const day of filmScreeningDates) {
        const hit = (day.filmScreenings || []).some(
            fs => filmIds.has(fs.filmId) && (fs.sites || []).some(s => siteIds.includes(s.siteId))
        )
        if (hit) candidateDates.push(day.businessDate)
    }
    const published = filmScreeningDates.map(d => d.businessDate).sort()
    lastHorizon = {
        published: published.length,
        until: published[published.length - 1],
    }
    log(
        `${filmIds.size} film id(s), ${candidateDates.length} screening day(s) of ` +
            `${filmScreeningDates.length} published`
    )

    // 2. Free seats (one call for all screenings of these sites).
    const { showtimeAvailabilities } = await api.availability(token, siteIds)
    const availability = new Map(showtimeAvailabilities.map(a => [a.showtimeId, a]))

    // 3. Fetch and filter the screenings per candidate day.
    const out = []
    for (const date of candidateDates) {
        const data = await api.showtimesByDate(token, date, siteIds)
        const rel = data.relatedData || {}
        const films = new Map((rel.films || []).map(f => [f.id, textOf(f.title)]))
        const screens = new Map((rel.screens || []).map(s => [s.id, textOf(s.name)]))
        const attrs = new Map((rel.attributes || []).map(a => [a.id, textOf(a.name)]))

        for (const st of data.showtimes || []) {
            if (!siteIds.includes(st.siteId)) continue
            if (!filmIds.has(st.filmId)) continue
            const title = films.get(st.filmId) || ''

            const attrIds = st.attributeIds || []
            const required = flt.requiredAttributeIds || []
            if (required.length > 0 && !required.every(a => attrIds.includes(a))) continue

            const av = availability.get(st.id)
            out.push({
                id: st.id,
                date,
                startsAt: st.schedule && st.schedule.startsAt,
                filmId: st.filmId,
                title,
                siteId: st.siteId,
                screen: screens.get(st.screenId) || st.screenId,
                attributes: attrIds.map(a => attrs.get(a) || a),
                isSoldOut: Boolean(st.isSoldOut || (av && av.isSoldOut)),
                seatsAvailable: av && av.seatSummary ? av.seatSummary.availableCount : null,
                seatsTotal: av && av.seatSummary ? av.seatSummary.totalCount : null,
                seatLayoutId: st.seatLayoutId || null,
            })
        }
    }
    out.sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))
    return out
}

// ---------------------------------------------------------------------------
// seats per screening
// ---------------------------------------------------------------------------

/**
 * Add `goodGroups` (number of groups of adjacent free seats in the zone) and
 * `goodSeats` (short description) to each screening.
 *
 * This costs one call per screening, so:
 *   - sold out or too few free seats -> no call, 0 groups;
 *   - not more than `maxChecks` calls per run;
 *   - if the call fails, `goodGroups` stays null (= unknown). Later we take
 *     over the previous value, so that no false message is produced.
 */
async function addSeatInfo(token, showings, cfg, state) {
    const sc = cfg.seats || {}
    const seatData = new Map()
    if (sc.enabled === false) return seatData
    const minAdjacent = sc.minAdjacent || 3
    const maxChecks = sc.maxChecks || 30
    const layouts = loadLayouts()

    // Which screenings qualify? Sold out or too few free seats: no group by
    // definition, so no call.
    const candidates = []
    for (const s of showings) {
        if (s.isSoldOut || (s.seatsAvailable != null && s.seatsAvailable < minAdjacent)) {
            s.goodGroups = 0
            s.goodSeats = ''
        } else if (!s.seatLayoutId) {
            s.goodGroups = null
        } else {
            s.goodGroups = null
            candidates.push(s)
        }
    }

    // Cloudflare permits about 45 calls per run (measured 31/10: HTTP 429 on
    // the 46th seat check). Above the budget we rotate: each run starts where
    // the previous run stopped, so each screening gets its turn every few
    // runs. Screenings that are not checked keep goodGroups = null and take
    // over the previous value later.
    const start = candidates.length ? (state.seatCursor || 0) % candidates.length : 0
    const todo = candidates.slice(start).concat(candidates.slice(0, start)).slice(0, maxChecks)
    if (candidates.length > maxChecks) {
        log(`${candidates.length} screenings to check, budget ${maxChecks}: from #${start + 1}, rest next run`)
    }

    let checks = 0
    for (const s of todo) {
        try {
            const layout = await getLayout(token, s.seatLayoutId, layouts)
            const { seatAvailabilities } = await api.seatAvailability(token, s.id)
            checks++
            const { groups } = findGroups(layout, seatAvailabilities, sc)
            s.goodGroups = groups.length
            s.goodSeats = describeGroups(groups)
            // The summary endpoint lags behind (measured 2/11: 398 "free"
            // against 259 really free seats). The seat map is the truth.
            s.seatsAvailable = seatAvailabilities.filter(a => a.status === 'Available').length
            // Memory only. This does not belong in state.json. It would make
            // the file grow with tens of thousands of seats per run.
            seatData.set(s.id, { layout, availabilities: seatAvailabilities })
        } catch (err) {
            log(`seat check of ${s.id} failed: ${err.message}`)
            // With a rate limit, continuing is useless. The rest comes next run.
            if (err.status === 429) {
                log('rate limit: remaining seat checks skipped')
                break
            }
        }
    }
    state.seatCursor = candidates.length ? (start + checks) % candidates.length : 0
    log(`seats checked for ${checks} of ${candidates.length} screening(s)`)
    return seatData
}

/**
 * Make a PNG of the seat maps of the screenings that we report. Then the push
 * message shows at once where those seats are.
 */
const MAX_PLANS = 3   // screenings per seat map image

async function seatImage(showings, seatData, cfg, max = MAX_PLANS) {
    if (!showings.length) return null
    const sc = cfg.seats || {}
    const items = []
    for (const s of showings.slice(0, max)) {
        const d = seatData.get(s.id)
        if (!d) continue
        const { groups, zone } = findGroups(d.layout, d.availabilities, sc)
        const when = s.startsAt ? s.startsAt.replace('T', ' ').slice(0, 16) : s.date
        items.push({
            title: `${s.title} · ${when} · ${s.screen}`,
            subtitle: `${s.seatsAvailable ?? '?'} free · zone rows ${zone.rows[0]}-${zone.rows[zone.rows.length - 1]} · ${describeGroups(groups, 6)}`,
            layout: d.layout,
            availabilities: d.availabilities,
        })
    }
    if (!items.length) return null

    for (const zoom of [1.5, 1.1, 0.8]) {
        const png = await renderPng(renderSvg(items, sc), zoom)
        if (!png) return null
        if (png.length <= MAX_ATTACHMENT) return png
        log(`image too large (${Math.round(png.length / 1024)} kB); trying smaller`)
    }
    return null
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

function describe(s) {
    const when = s.startsAt ? s.startsAt.replace('T', ' ').slice(0, 16) : s.date
    const seats =
        s.isSoldOut || s.seatsAvailable === 0
            ? 'SOLD OUT'
            : s.seatsAvailable != null
              ? `${s.seatsAvailable} free`
              : '?'
    const good = s.goodSeats ? ` · ${s.goodSeats}` : ''
    return `${when} · ${s.screen} · ${seats}${good}`
}

const isOpen = s => !s.isSoldOut && (s.seatsAvailable == null || s.seatsAvailable > 0)

/** Does this screening have a usable seat group? null = not checked. */
const hasGood = s => s.goodGroups != null && s.goodGroups > 0

function diff(current, known) {
    const newShowings = []
    const goodSeats = []

    const knownDates = new Set(Object.values(known).map(s => s.date))

    for (const s of current) {
        const prev = known[s.id]
        if (!prev) {
            // Always report a new screening. That is a different kind of news
            // than "a seat is free", and it is rare.
            newShowings.push({ ...s, newDate: !knownDates.has(s.date) })
            continue
        }
        // Only the transition "no usable seat group" -> "a seat group".
        // prev.goodGroups == null means that we did not know last time.
        // Then we stay silent instead of inventing a message.
        if (prev.goodGroups === 0 && hasGood(s)) goodSeats.push(s)
    }
    return { newShowings, goodSeats }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function summarise(list, max = 12) {
    const lines = list.slice(0, max).map(describe)
    if (list.length > max) lines.push(`… and ${list.length - max} more`)
    return lines.join('\n')
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const dayLabel = d => `${DAYS[new Date(d + 'T12:00:00').getDay()]} ${Number(d.slice(8))}/${Number(d.slice(5, 7))}`

/**
 * New screenings in compact form: one line per screening day with only the
 * times. With a large release (31/10/2026: 36 screenings at once) the full
 * list was a wall of text. The seats are on the seat map anyway.
 *   * = usable seat group in the zone, (sold out) = sold out
 * Pushover cuts off at 1024 characters, so above ~900 the last days are dropped.
 */
function summariseNew(list) {
    if (list.length === 1) return describe(list[0])
    const byDate = new Map()
    for (const s of list) {
        if (!byDate.has(s.date)) byDate.set(s.date, [])
        byDate.get(s.date).push(s)
    }
    const dates = [...byDate.keys()].sort()
    const head =
        `${list.length} new screenings on ${dates.length} screening day(s), ` +
        `${dayLabel(dates[0])} to ${dayLabel(dates[dates.length - 1])}`
    const lines = []
    for (const d of dates) {
        const times = byDate
            .get(d)
            .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))
            .map(s => {
                const t = s.startsAt ? s.startsAt.slice(11, 16) : '?'
                return s.isSoldOut ? `${t} (sold out)` : hasGood(s) ? `${t}*` : t
            })
        lines.push(`${dayLabel(d)}: ${times.join(', ')}`)
    }
    const good = list.filter(hasGood).length
    const foot = good ? `* = seats together in the zone (${good} of ${list.length})` : ''
    let body = head
    for (const [i, l] of lines.entries()) {
        if (body.length + l.length + foot.length > 900) {
            body += `\n… and ${lines.length - i} more screening day(s)`
            break
        }
        body += `\n${l}`
    }
    if (foot) body += `\n${foot}`
    return body
}

async function runOnce(cfg) {
    const state = loadState()

    let auth
    try {
        auth = await getAuthToken(state.auth)
        if (auth.refreshed) log('new GAS token fetched')
    } catch (err) {
        log(`token fetch failed: ${err.message}`)
        runOnce.lastError = `token fetch failed: ${err.message}`
        return 1
    }
    state.auth = { token: auth.token, exp: auth.exp }

    let current
    let seatData = new Map()
    try {
        current = await fetchShowings(auth.token, cfg)
        seatData = await addSeatInfo(auth.token, current, cfg, state)
    } catch (err) {
        log(`fetch failed: ${err.message}`)
        runOnce.lastError = `fetch failed: ${err.message}`
        // The token can be revoked. Force a fresh attempt next run.
        if (err.status === 401) state.auth = null
        if (err.filmGone && !state.filmGoneNotified) {
            // Report once. Stay silent until the film is back.
            state.filmGoneNotified = true
            saveState(state)
            await notifyAdmin(
                `${cfg.filter.label || 'notifier'}: film no longer scheduled`,
                'No film matches the filter any more. I keep checking and do not report this again.'
            )
            return 0
        }
        saveState(state)
        return 1
    }
    if (state.filmGoneNotified) state.filmGoneNotified = false

    const label = cfg.filter.label || 'screenings'
    log(`${current.length} screening(s) for ${label}`)

    const dates = [...new Set(current.map(s => s.date))].sort()
    const now =
        `Now ${current.length} screenings on ${dates.length} screening day(s)` +
        (dates.length ? ` (${dates[0]} to ${dates[dates.length - 1]})` : '') +
        '.'
    const ahead = lastHorizon
        ? `New screening days are added automatically: each run searches all ` +
          `${lastHorizon.published} published screening days, up to ${lastHorizon.until}.`
        : 'New screening days are picked up automatically.'
    await notifyZone(cfg, state, `${now}\n${ahead}`)

    if (state.firstRun) {
        state.showtimes = Object.fromEntries(current.map(s => [s.id, s]))
        state.firstRun = false
        state.lastCheck = new Date().toISOString()
        saveState(state)
        log(`first run: ${current.length} screening(s) saved as baseline`)
        for (const s of current) log(`  existing: ${describe(s)} (${s.goodGroups ?? '?'} seat group(s))`)
        return 0
    }

    // If a seat check was skipped, take over the previous value. Otherwise
    // the next run would see a transition 0 -> n that did not happen.
    for (const s of current) {
        if (s.goodGroups == null) {
            const prev = state.showtimes[s.id]
            if (prev && prev.goodGroups != null) {
                s.goodGroups = prev.goodGroups
                s.goodSeats = prev.goodSeats
                if (prev.seatsAvailable != null) s.seatsAvailable = prev.seatsAvailable
                s.goodStale = true
            }
        }
    }

    const { newShowings, goodSeats } = diff(current, state.showtimes)

    if (newShowings.length) {
        const dates = [...new Set(newShowings.filter(s => s.newDate).map(s => s.date))]
        const title = dates.length
            ? `${dates.length > 1 ? `${dates.length} new screening days` : 'New screening day'} — ${label}`
            : `${newShowings.length}x new screening — ${label}`
        // If a new screening has usable seats at once, the seat map can go
        // with it. But only if all of them fit on the image. With a large
        // release (31/10/2026: 36 new) the image would show the first three
        // at random, and a seat map of an empty screen says nothing. The seat
        // maps then follow with the first real "seats together" message.
        const withGood = newShowings.filter(hasGood)
        const png = withGood.length <= MAX_PLANS ? await seatImage(withGood, seatData, cfg) : null
        let body = summariseNew(newShowings)
        if (withGood.length > MAX_PLANS) body += '\nSeat maps follow with the first change.'
        await notify(cfg, title, body, png)
        log(`NEW: ${newShowings.map(describe).join(' | ')}`)
    }

    if (goodSeats.length) {
        const n = (cfg.seats && cfg.seats.minAdjacent) || 3
        const png = await seatImage(goodSeats, seatData, cfg)
        await notify(cfg, `${n} seats together — ${label}`, summarise(goodSeats), png)
        log(
            `GOOD SEATS: ${goodSeats.map(describe).join(' | ')}` +
                (png ? ` (+ seat map, ${Math.round(png.length / 1024)} kB)` : '')
        )
    }

    if (!newShowings.length && !goodSeats.length) {
        log('no changes')
    }

    // Keep known screenings together with what we saw before. Then a
    // screening that disappears from the API for a while does not count as
    // "new" later.
    const merged = { ...state.showtimes }
    for (const s of current) merged[s.id] = s
    state.showtimes = merged
    state.lastCheck = new Date().toISOString()
    saveState(state)
    return 0
}

/**
 * Fetch the seat status of the screenings that match the filter.
 * Shared by --map and --testpush. Sends nothing.
 */
async function collectSeatData(cfg, flag, limit = Infinity) {
    const state = loadState()
    const auth = await getAuthToken(state.auth)
    if (auth.refreshed) {
        state.auth = { token: auth.token, exp: auth.exp }
        saveState(state)
    }
    const current = await fetchShowings(auth.token, cfg)
    const layouts = loadLayouts()

    const arg = process.argv[process.argv.indexOf(flag) + 1]
    const only = arg && !arg.startsWith('--') ? arg : null
    const list = only ? current.filter(s => s.id === only || s.date === only) : current
    if (only && !list.length) log(`nothing found for "${only}"`)

    const out = []
    for (const s of list) {
        if (out.length >= limit) break
        if (!s.seatLayoutId) continue
        try {
            const layout = await getLayout(auth.token, s.seatLayoutId, layouts)
            const { seatAvailabilities } = await api.seatAvailability(auth.token, s.id)
            out.push({ showing: s, layout, availabilities: seatAvailabilities })
        } catch (err) {
            log(`${s.id}: ${err.message}`)
        }
    }
    return out
}

/** Draw the seat maps as text, to check the zone. */
async function showMaps(cfg) {
    const sc = cfg.seats || {}
    for (const { showing, layout, availabilities } of await collectSeatData(cfg, '--map')) {
        const { groups, zone } = findGroups(layout, availabilities, sc)
        console.log(`\n${describe(showing)}  [${showing.id}]`)
        console.log(
            `zone: rows ${zone.rows.join(',')} | ${groups.length} seat group(s) of ${zone.minAdjacent}+` +
                (groups.length ? `: ${describeGroups(groups, 20)}` : '')
        )
        console.log(renderMap(layout, availabilities, sc))
    }
    console.log('\nlegend: O free in the zone · = sold in the zone · . free · # sold · x broken · H blocked')
    return 0
}

// ---------------------------------------------------------------------------
// --find: look up film ids (logic in lookup.js, shared with setup.js)
// ---------------------------------------------------------------------------

async function findFilms(term) {
    const state = loadState()
    const auth = await getAuthToken(state.auth)
    if (auth.refreshed) {
        state.auth = { token: auth.token, exp: auth.exp }
        saveState(state)
    }
    const { films } = await lookupFilms(auth.token, term, log)
    if (!films.length) {
        console.log(`No film found for "${term}".`)
        return 1
    }
    console.log('')
    for (const f of films) console.log(describeFilm(f))
    console.log(`
In config.json:
  "filmIds": ["<id>"]                 the film (one language version = one id)
  "siteIds": ["KBRU"]                 the cinema
  "requiredAttributeIds": ["0000000056"]   optional, for example only IMAX
Or let the wizard fill it in: node setup.js`)
    return 0
}

/**
 * Short fingerprint of what we watch: screen plus zone settings. This lets
 * the start message go out after a restart with a different zone, and keeps
 * the other 143 runs per day silent.
 */
function zoneSignature(cfg, layouts) {
    const sc = cfg.seats || {}
    const parts = []
    for (const id of Object.keys(layouts).sort()) {
        const { rows } = renderZonePlan(layouts[id], sc, false)
        parts.push(`${id}:${rows.map(r => `${r.rowLabel}/${r.fromLabel}-${r.toLabel}`).join(',')}`)
    }
    return `${sc.minAdjacent || 3}|${parts.join('|')}`
}

/**
 * Send one push message with the seat map and the watched zone on it:
 * on the first run, and after that only when the zone changes.
 */
async function notifyZone(cfg, state, context) {
    const layouts = loadLayouts()
    if (!Object.keys(layouts).length) return

    const sig = zoneSignature(cfg, layouts)
    if (sig === state.zoneSignature) return

    const sc = cfg.seats || {}
    const names = {}
    for (const sh of Object.values(state.showtimes || {})) {
        if (sh.seatLayoutId) names[sh.seatLayoutId] = sh.screen
    }
    const inUse = Object.keys(names).filter(id => layouts[id])
    const ids = inUse.length ? inUse : Object.keys(layouts)

    const items = []
    const lines = []
    for (const id of ids) {
        const { rows } = renderZonePlan(layouts[id], sc, false)
        if (!rows.length) continue
        const seats = rows.reduce((n, r) => n + (r.to - r.from + 1), 0)
        // The seat range differs per row (the screen gets wider to the back),
        // so take the outer limits over all rows.
        const labels = rows.flatMap(r => [Number(r.fromLabel), Number(r.toLabel)]).filter(Number.isFinite)
        const range = labels.length ? `, seats ${Math.min(...labels)}-${Math.max(...labels)}` : ''
        lines.push(
            `${names[id] || id}: ${seats} seats, rows ${rows[0].rowLabel} to ` +
                `${rows[rows.length - 1].rowLabel}${range}`
        )
        // Empty availability = draw only the zone, not the sales.
        items.push({
            title: `Watched zone — ${names[id] || id}`,
            subtitle: `${sc.minAdjacent || 3}+ together · ${seats} seats watched`,
            layout: layouts[id],
            availabilities: [],
        })
    }
    if (!items.length) return

    const png = await renderPng(renderSvg(items, sc), 1.5)
    const body = `${lines.join('\n')}\n\n${context}`
    await notify(cfg, `Monitoring started — ${cfg.filter.label || 'notifier'}`, body, png)
    log(`start message sent${png ? ` with zone map (${Math.round(png.length / 1024)} kB)` : ''}`)
    state.zoneSignature = sig
}

/**
 * Show at start which seats are watched. Uses the cached seat map, so this
 * costs no API call and does not slow down the run. The first time, the cache
 * is still empty. Then the map follows after the first run.
 */
function showWatchedSeats(cfg) {
    const layouts = loadLayouts()
    if (!Object.keys(layouts).length) return

    // The screen name is not in the seat map itself, but it is in the screenings.
    const state = loadState()
    const names = {}
    for (const sh of Object.values(state.showtimes || {})) {
        if (sh.seatLayoutId) names[sh.seatLayoutId] = sh.screen
    }

    // Only the screens where the film plays now. The cache can contain old
    // screens if the film moved. We do not need to draw those.
    const inUse = Object.keys(names).filter(id => layouts[id])
    const ids = inUse.length ? inUse : Object.keys(layouts)

    const colour = Boolean(process.stdout.isTTY)
    for (const id of ids) {
        const { text, zone, rows } = renderZonePlan(layouts[id], cfg.seats || {}, colour)
        if (!rows.length) {
            console.log(`\nNote: the zone from config.seats contains no seat in ${names[id] || id}.`)
            continue
        }
        const seats = rows.reduce((n, r) => n + (r.to - r.from + 1), 0)
        console.log(`\nWatching ${seats} seats in ${names[id] || id} (${id}):`)
        console.log(
            `${zone.minAdjacent}+ together, rows ${rows[0].rowLabel} to ${rows[rows.length - 1].rowLabel}` +
                ` · O = watched, · = outside the zone`
        )
        console.log(text)
    }
}

/**
 * Send one test message with a seat map, to test the full chain without
 * waiting for a real change.
 */
async function testPush(cfg) {
    const sc = cfg.seats || {}
    const data = await collectSeatData(cfg, '--testpush', 1)
    if (!data.length) {
        log('no screening found to test')
        return 1
    }
    const { showing, layout, availabilities } = data[0]
    const { groups, zone } = findGroups(layout, availabilities, sc)
    showing.goodGroups = groups.length
    showing.goodSeats = describeGroups(groups)
    const png = await seatImage([showing], new Map([[showing.id, { layout, availabilities }]]), cfg)
    const body =
        `${describe(showing)}\n\nzone rows ${zone.rows[0]}-${zone.rows[zone.rows.length - 1]}, ` +
        `${groups.length} seat group(s) of ${zone.minAdjacent}+`
    await notify(cfg, `Test — ${cfg.filter.label || 'notifier'}`, body, png)
    log(`test message sent${png ? ` with seat map (${Math.round(png.length / 1024)} kB)` : ' without image'}`)
    return 0
}

async function main() {
    const cfg = loadConfig()
    const flt = cfg.filter || {}
    if (!(flt.filmIds && flt.filmIds.length) && !process.argv.includes('--find')) {
        log('no film configured: set filter.filmIds (find it with --find) or run: node setup.js')
        process.exit(2)
    }
    // Cloudflare rate-limits digital-api. Without a gap, a run with dozens of
    // seat checks hits HTTP 429.
    setThrottle(cfg.requestGapMs == null ? 2100 : cfg.requestGapMs, log)

    if (process.argv.includes('--find')) {
        const i = process.argv.indexOf('--find')
        const term = process.argv.slice(i + 1).filter(a => !a.startsWith('--')).join(' ')
        process.exit(await findFilms(term))
    }
    if (process.argv.includes('--map')) {
        process.exit(await showMaps(cfg))
    }
    if (process.argv.includes('--testpush')) {
        process.exit(await testPush(cfg))
    }
    showWatchedSeats(cfg)

    if (process.argv.includes('--loop')) {
        // POLL_MINUTES (container) takes precedence over intervalSeconds from config.json.
        const interval = (Number(process.env.POLL_MINUTES) * 60 || cfg.intervalSeconds || 600) * 1000
        // After this many failed runs in a row, one message goes to the admin,
        // and one when it works again. In between, only log.
        const alertAfter = Number(process.env.FAIL_ALERT_AFTER || cfg.failAlertAfter || 3)
        const sec = loadSecrets()
        log(
            `loop mode, every ${interval / 1000}s; ${sec.pushoverUsers.length} user key(s), ` +
                `${sec.pushoverAdmins.length} admin key(s), admin alert after ${alertAfter} failures`
        )
        if (!sec.pushoverAdmins.length) log('WARNING: PUSHOVER_ADMIN not set; problems are only logged')
        let failures = 0
        let failedSince = null
        let alerted = false
        let lastError = ''
        for (;;) {
            let rc
            try {
                runOnce.lastError = ''
                rc = await runOnce(cfg)
                if (rc !== 0) lastError = runOnce.lastError
            } catch (err) {
                log(`unexpected error: ${err.stack}`)
                lastError = err.message
                rc = 1
            }
            if (rc === 0) {
                if (alerted) {
                    const min = Math.round((Date.now() - failedSince) / 60_000)
                    await notifyAdmin(`${cfg.filter.label || 'notifier'}: working again`, `Run succeeded after ${min} min of problems.`)
                }
                failures = 0
                failedSince = null
                alerted = false
            } else {
                failures++
                failedSince ??= Date.now()
                if (failures >= alertAfter && !alerted) {
                    alerted = true
                    await notifyAdmin(
                        `${cfg.filter.label || 'notifier'}: problems`,
                        `${failures} runs in a row failed since ${new Date(failedSince).toISOString()}. ` +
                            `Last error: ${lastError || 'see log'}`
                    )
                }
            }
            await new Promise(r => setTimeout(r, interval))
        }
    }
    process.exit(await runOnce(cfg))
}

main().catch(err => {
    log(`unexpected error: ${err.stack}`)
    process.exit(1)
})
