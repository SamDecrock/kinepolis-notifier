'use strict'

/**
 * Film lookup: everything you need to watch one film.
 *
 * Shared by `notifier.js --find` (text output) and `setup.js` (the wizard).
 * At Kinepolis, each language version is a separate film with its own id
 * (an original version and a dubbed version are two films). That is why the language is shown.
 */

const { api } = require('./kinepolis-api')

const textOf = v => (v && typeof v === 'object' ? v.text : v) || ''

// Names for attribute ids that are not in the fetched screening day.
// These are the names the Kinepolis API returns (Dutch). Keep them as they are.
const KNOWN_ATTRIBUTES = {
    '0000000036': '2D', '0000000037': '3D', '0000000040': '70mm', '0000000056': 'IMAX',
    '0000000058': 'Laser Ultra', '0000000085': '4DX', '0000000099': 'ScreenX',
    '0000000067': 'Engelse versie', '0000000069': 'Nederlandse versie', '0000000070': 'Franse versie',
    '0000000068': 'Geen ondertiteling', '0000000071': 'Nederlandse ondertiteling',
    '0000000072': 'Franse ondertiteling', '0000000074': 'Engelse ondertiteling',
}
// Content rating ("Goed gezien"), intermission, "long film", CineK: noise for a filter.
const HIDE_ATTRIBUTES = new Set([
    '0000000102', '0000000103', '0000000104', '0000000105', '0000000106', '0000000107',
    '0000000011', '0000000066', '0000000163',
])

const fmtDate = d => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '?')
const fmtRuntime = m => (m ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : '')

/**
 * Finds films by (part of) the title or by id. Returns per film: id, title,
 * release date, runtime, the cinemas where it plays, the period and the
 * attributes that occur on its screenings. Four API calls in total.
 */
async function lookupFilms(token, term, log = () => {}) {
    const needle = String(term || '').toLowerCase().trim()

    const sites = ((await api.sites(token)).sites || []).map(s => ({ id: s.id, name: textOf(s.name) }))
    const siteName = new Map(sites.map(s => [s.id, s.name]))

    const films = ((await api.films(token)).films || []).filter(
        f => !needle || textOf(f.title).toLowerCase().includes(needle) || f.id.toLowerCase() === needle
    )
    if (!films.length) return { films: [], sites }
    const wanted = new Set(films.map(f => f.id))

    // Where and when: one call for all cinemas.
    const { filmScreeningDates } = await api.filmScreeningDates(token, sites.map(s => s.id))
    const plays = new Map()   // filmId -> { sites:Set, first, last, attrs:Set }
    for (const day of filmScreeningDates || []) {
        for (const fs of day.filmScreenings || []) {
            if (!wanted.has(fs.filmId)) continue
            const p = plays.get(fs.filmId) || { sites: new Set(), first: null, last: null, attrs: new Set() }
            for (const st of fs.sites || []) {
                p.sites.add(st.siteId)
                for (const a of st.showtimeAttributeIds || []) p.attrs.add(a)
            }
            if (!p.first || day.businessDate < p.first) p.first = day.businessDate
            if (!p.last || day.businessDate > p.last) p.last = day.businessDate
            plays.set(fs.filmId, p)
        }
    }

    // Attribute names from one screening day (the first day on which a listed film plays).
    const attrName = new Map(Object.entries(KNOWN_ATTRIBUTES))
    const firstPlay = [...plays.values()].sort((a, b) => (a.first < b.first ? -1 : 1))[0]
    if (firstPlay) {
        try {
            const d = await api.showtimesByDate(token, firstPlay.first, [...firstPlay.sites])
            for (const a of (d.relatedData || {}).attributes || []) attrName.set(a.id, textOf(a.name))
        } catch (err) {
            log(`could not fetch attribute names: ${err.message}`)
        }
    }

    const out = films
        .map(f => {
            const p = plays.get(f.id)
            return {
                id: f.id,
                title: textOf(f.title),
                releaseDate: f.releaseDate || null,
                runtimeInMinutes: f.runtimeInMinutes || null,
                plays: Boolean(p),
                sites: p ? [...p.sites].sort().map(id => ({ id, name: siteName.get(id) || '?' })) : [],
                first: p ? p.first : null,
                last: p ? p.last : null,
                // Only attributes with a name. The others are internal flags.
                attributes: p
                    ? [...p.attrs].filter(a => !HIDE_ATTRIBUTES.has(a) && attrName.has(a)).map(id => ({ id, name: attrName.get(id) }))
                    : [],
            }
        })
        .sort((a, b) => a.title.localeCompare(b.title))
    return { films: out, sites }
}

/** One film as a text block, as `--find` shows it. */
function describeFilm(f) {
    const rel = f.releaseDate ? ` · release ${fmtDate(f.releaseDate)}/${f.releaseDate.slice(0, 4)}` : ''
    const len = f.runtimeInMinutes ? ` · ${fmtRuntime(f.runtimeInMinutes)}` : ''
    const lines = [`${f.id}  ${f.title}${rel}${len}`]
    if (!f.plays) {
        lines.push('    no screenings scheduled')
    } else {
        lines.push(`    plays ${fmtDate(f.first)} to ${fmtDate(f.last)} at ${f.sites.map(s => `${s.id} (${s.name})`).join(', ')}`)
        lines.push(`    attributes: ${f.attributes.map(a => `${a.name} (${a.id})`).join(', ') || '-'}`)
    }
    return lines.join('\n')
}

module.exports = { lookupFilms, describeFilm, fmtDate, fmtRuntime, KNOWN_ATTRIBUTES }
