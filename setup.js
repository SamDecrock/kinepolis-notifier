#!/usr/bin/env node
'use strict'

/**
 * Interactive wizard: fills in config.json and secrets.json.
 *
 *   node setup.js
 *
 * Looks up the film at Kinepolis. Lets you pick the language version, the
 * cinema and optionally an attribute (IMAX, 70mm, ...). Asks for the seat zone
 * and the Pushover keys. Then writes everything. Existing values are the
 * defaults, so you can run it again to change one thing.
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { stdin, stdout } = require('process')
const { getAuthToken } = require('./kinepolis-api')
const { lookupFilms, describeFilm, fmtDate } = require('./lookup')

const HERE = __dirname
const CONFIG_PATH = path.join(HERE, 'config.json')
const SECRETS_PATH = path.join(HERE, 'secrets.json')
const STATE_PATH = path.join(process.env.STATE_DIR || HERE, 'state.json')

const DEFAULT_CONFIG = {
    intervalSeconds: 600,
    requestGapMs: 2100,
    filter: { label: '', siteIds: [], filmIds: [], requiredAttributeIds: [] },
    seats: {
        enabled: true,
        minAdjacent: 3,
        rowsFrom: 0.45,
        rowsTo: 1.0,
        colsFrom: 0.28,
        colsTo: 0.72,
        centreBlockOnly: true,
        screenPosition: 'top',
        maxChecks: 30,
    },
}

const readJson = (p, fallback) => {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {
        return fallback
    }
}

const bold = t => `\x1b[1m${t}\x1b[0m`
const dim = t => `\x1b[90m${t}\x1b[0m`

// Own question function with a line buffer. readline drops lines that arrive
// while no question is open (for example during an API call). Then pasting or
// typing ahead fails. Here the lines wait for their turn.
const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdout.isTTY })
const lines = []
let waiting = null
let closed = false
rl.on('line', l => (waiting ? waiting(l) : lines.push(l)))
rl.on('close', () => {
    closed = true
    if (waiting) waiting(null)
})
function nextLine() {
    if (lines.length) return Promise.resolve(lines.shift())
    if (closed) return Promise.resolve(null)
    return new Promise(r => (waiting = l => ((waiting = null), r(l))))
}

/** Question with a default value. Enter = default. */
async function ask(question, def) {
    const hint = def !== undefined && def !== '' && def !== null ? dim(` [${def}]`) : ''
    stdout.write(`${question}${hint}: `)
    const l = await nextLine()
    if (l === null) throw new Error('input closed')
    if (!stdout.isTTY) stdout.write(`${l}\n`)   // echo piped input, for the log
    const a = l.trim()
    return a === '' ? def : a
}

async function askYesNo(question, def = true) {
    for (;;) {
        const a = String(await ask(`${question} (y/n)`, def ? 'y' : 'n'))
        if (/^(y|yes|j|ja)$/i.test(a)) return true
        if (/^(n|no|nee)$/i.test(a)) return false
        console.log('  Answer with y or n.')
    }
}

async function askNumber(question, def, { min = -Infinity, max = Infinity } = {}) {
    for (;;) {
        const a = Number(await ask(question, def))
        if (Number.isFinite(a) && a >= min && a <= max) return a
        console.log(`  Enter a number between ${min} and ${max}.`)
    }
}

/** Pick one item from a numbered list. */
async function pickOne(question, items, render, defIndex = 0) {
    items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}. ${render(it)}`))
    for (;;) {
        const n = Number(await ask(question, defIndex + 1))
        if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]
        console.log(`  Pick a number from 1 to ${items.length}.`)
    }
}

/** Pick zero or more items from a numbered list: "1 3" or "1,3". Empty = none. */
async function pickMany(question, items, render, defIndexes = []) {
    items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}. ${render(it)}`))
    const def = defIndexes.map(i => i + 1).join(' ')
    for (;;) {
        const raw = String(await ask(`${question} (numbers, empty = none)`, def || undefined) || '')
        const nums = raw.split(/[\s,;]+/).filter(Boolean).map(Number)
        if (nums.every(n => Number.isInteger(n) && n >= 1 && n <= items.length)) {
            return [...new Set(nums)].map(n => items[n - 1])
        }
        console.log(`  Only numbers from 1 to ${items.length}.`)
    }
}

const splitKeys = v => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map(s => s.trim()).filter(Boolean)

async function main() {
    console.log(bold('\nKinepolis notifier — setup\n'))
    const cfg = { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, {}) }
    cfg.filter = { ...DEFAULT_CONFIG.filter, ...(cfg.filter || {}) }
    cfg.seats = { ...DEFAULT_CONFIG.seats, ...(cfg.seats || {}) }
    const secrets = readJson(SECRETS_PATH, {})

    // --- token (cached in state.json when that file exists) -------------------
    const state = readJson(STATE_PATH, {})
    process.stdout.write(dim('Connecting to Kinepolis… '))
    const auth = await getAuthToken(state.auth)
    console.log(dim('ok'))

    // --- 1. film ------------------------------------------------------------
    console.log(bold('\n1. Which film?'))
    let film = null
    while (!film) {
        const term = await ask('Title (or part of it)')
        if (!term) continue
        process.stdout.write(dim('Searching… '))
        const { films } = await lookupFilms(auth.token, term)
        console.log(dim(`${films.length} found`))
        const playing = films.filter(f => f.plays)
        if (!playing.length) {
            console.log(films.length ? '  Found, but without planned screenings. Try something else.' : '  Nothing found.')
            continue
        }
        console.log(dim('  Note: each language version is a separate film (original version and dubbed version have different ids).'))
        film = await pickOne(
            'Which one?',
            playing,
            f => {
                // Matches Kinepolis API data (Dutch attribute names), so keep it as it is.
                const lang = f.attributes.filter(a => /versie|ondertiteling/i.test(a.name)).map(a => a.name).join(', ')
                return `${f.title}  ${dim(`${f.id} · ${fmtDate(f.first)} to ${fmtDate(f.last)} · ${f.sites.length} cinemas${lang ? ' · ' + lang : ''}`)}`
            },
            Math.max(0, playing.findIndex(f => cfg.filter.filmIds.includes(f.id)))
        )
    }
    console.log(`\n${describeFilm(film)}\n`)

    // --- 2. cinema ------------------------------------------------------------
    console.log(bold('2. Which cinema?'))
    const curSites = film.sites.map((s, i) => (cfg.filter.siteIds.includes(s.id) ? i : -1)).filter(i => i >= 0)
    const sites = await pickMany('Cinemas', film.sites, s => `${s.name} ${dim(s.id)}`, curSites.length ? curSites : [0])
    if (!sites.length) {
        console.log('  At least one cinema is needed. The first one is used.')
        sites.push(film.sites[0])
    }

    // --- 3. attributes ------------------------------------------------------
    console.log(bold('\n3. Only certain screenings?'))
    console.log(dim('  For example only IMAX, or only the Dutch subtitled version. All selected attributes must be present.'))
    const curAttrs = film.attributes.map((a, i) => (cfg.filter.requiredAttributeIds.includes(a.id) ? i : -1)).filter(i => i >= 0)
    const attrs = film.attributes.length
        ? await pickMany('Required attributes', film.attributes, a => `${a.name} ${dim(a.id)}`, curAttrs)
        : []

    // --- 4. seats -----------------------------------------------------------
    console.log(bold('\n4. Seats'))
    console.log(dim('  With the seat check on, you only get a message when seats next to each other become free in a good zone.'))
    cfg.seats.enabled = await askYesNo('Seat check on', cfg.seats.enabled)
    if (cfg.seats.enabled) {
        cfg.seats.minAdjacent = await askNumber('How many seats next to each other', cfg.seats.minAdjacent, { min: 1, max: 20 })
        const preset = await pickOne(
            'Which zone',
            [
                { name: 'middle to back, centre block (default)', rowsFrom: 0.45, rowsTo: 1.0, colsFrom: 0.28, colsTo: 0.72, centreBlockOnly: true },
                { name: 'middle of the hall (not the back row)', rowsFrom: 0.4, rowsTo: 0.9, colsFrom: 0.28, colsTo: 0.72, centreBlockOnly: true },
                { name: 'everywhere, also front and sides', rowsFrom: 0, rowsTo: 1, colsFrom: 0, colsTo: 1, centreBlockOnly: false },
                { name: 'keep current setting', keep: true },
            ],
            z => z.name,
            3
        )
        if (!preset.keep) Object.assign(cfg.seats, { rowsFrom: preset.rowsFrom, rowsTo: preset.rowsTo, colsFrom: preset.colsFrom, colsTo: preset.colsTo, centreBlockOnly: preset.centreBlockOnly })
        console.log(dim('  Check the zone afterwards with: node notifier.js --map'))
    }

    // --- 5. notifications --------------------------------------------------------
    console.log(bold('\n5. Pushover'))
    console.log(dim('  Find the keys on https://pushover.net: the user key on your dashboard, the API token under your own application.'))
    const token = await ask('Application token', secrets.PUSHOVER_TOKEN)
    const users = splitKeys(await ask('User key(s) that receive the messages (comma-separated)', splitKeys(secrets.PUSHOVER_USER).join(',')))
    const admins = splitKeys(await ask('User key(s) for error messages about the notifier itself', splitKeys(secrets.PUSHOVER_ADMIN).join(',') || users[0]))
    cfg.intervalSeconds = await askNumber('Check interval in minutes', Math.round(cfg.intervalSeconds / 60), { min: 2, max: 1440 }) * 60

    // --- write ------------------------------------------------------------
    cfg.filter = {
        label: `${film.title} · ${sites.map(s => s.name.replace(/^Kinepolis /, '')).join('/')}${attrs.some(a => a.name === 'IMAX') ? ' IMAX' : ''}`,
        siteIds: sites.map(s => s.id),
        filmIds: [film.id],
        requiredAttributeIds: attrs.map(a => a.id),
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4) + '\n')
    const newSecrets = { ...secrets, PUSHOVER_TOKEN: token || '', PUSHOVER_USER: users, PUSHOVER_ADMIN: admins }
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(newSecrets, null, 2) + '\n', { mode: 0o600 })
    try {
        fs.chmodSync(SECRETS_PATH, 0o600)
    } catch {}

    console.log(bold('\nDone.'))
    console.log(`  ${cfg.filter.label}`)
    console.log(`  film ${film.id} · cinema ${cfg.filter.siteIds.join(', ')}${attrs.length ? ` · only ${attrs.map(a => a.name).join(' + ')}` : ''}`)
    console.log(`  ${cfg.seats.enabled ? `${cfg.seats.minAdjacent}+ seats next to each other` : 'no seat check'} · every ${cfg.intervalSeconds / 60} min · ${users.length} recipient(s)`)
    console.log(`  written: ${path.basename(CONFIG_PATH)}, ${path.basename(SECRETS_PATH)}`)
    if (fs.existsSync(STATE_PATH) && state.showtimes && Object.keys(state.showtimes).length) {
        const wipe = await askYesNo('\nstate.json contains screenings from the previous setup. Clear it, so the first run becomes the new baseline', true)
        if (wipe) {
            fs.writeFileSync(STATE_PATH, JSON.stringify({ firstRun: true, showtimes: {}, auth: state.auth || null }, null, 1))
            console.log('  state.json cleared (token kept)')
        }
    }
    console.log(`\nStart:  node notifier.js --loop      ${dim('or once: node notifier.js')}`)
    console.log(`Test:   node notifier.js --testpush  ${dim('sends one message with the seat map')}\n`)
    rl.close()
}

main().catch(err => {
    console.error(`\nFailed: ${err.message}`)
    rl.close()
    process.exit(1)
})
