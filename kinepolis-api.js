'use strict'

/**
 * Client for the Kinepolis "Lumos" API (Vista OCAPI v1).
 *
 * Two hosts, two ways to talk to them:
 *
 *   web.kinepolis.be      serves the GAS token. It sits behind Cloudflare,
 *                         which blocks on TLS fingerprint -> use cycletls.
 *   digital-api.kinepolis.be
 *                         the OCAPI itself. It accepts a plain fetch, as long
 *                         as the token is included.
 *
 * The token is valid for about 12 hours and is cached. So cycletls runs only
 * a few times per day.
 */

const initCycleTLS = require('cycletls')

const GAS_HOST = 'web.kinepolis.be'
const OCAPI_URL = 'https://digital-api.kinepolis.be'
const SALES_CHANNEL = 'mobile-android'

// Chrome 124 fingerprint. Without it, Cloudflare returns 403 on the token host.
const JA3 =
    '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,' +
    '0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0'
const USER_AGENT =
    'Mozilla/5.0 (Linux; Android 9; G8441) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Mobile Safari/537.36'

/** Fetches a fresh GAS token. This takes a moment: cycletls starts its own process. */
async function fetchAuthToken() {
    const url = `https://${GAS_HOST}/gas-token/api/v1/auth-token/sales-channels/${SALES_CHANNEL}/current`
    const cycleTLS = await initCycleTLS()
    try {
        const res = await cycleTLS.get(url, {
            ja3: JA3,
            userAgent: USER_AGENT,
            headers: { Accept: 'application/json' },
        })
        if (res.status !== 200) {
            throw new Error(`GAS token request failed: HTTP ${res.status}`)
        }
        const token = typeof res.body === 'string' ? res.body : res.data
        if (typeof token !== 'string' || !token.startsWith('ey')) {
            throw new Error('GAS token request did not return a JWT')
        }
        return token.replace(/^"|"$/g, '')
    } finally {
        // Without exit() the cycletls process keeps running.
        await cycleTLS.exit().catch(() => {})
    }
}

/** Reads the `exp` claim (unix seconds) from a JWT. */
function tokenExpiry(token) {
    try {
        const payload = token.split('.')[1]
        const json = Buffer.from(payload, 'base64url').toString('utf8')
        return JSON.parse(json).exp || 0
    } catch {
        return 0
    }
}

/**
 * Returns a valid token. Uses the cache when the cached token lasts long enough.
 * `cache` is an object that the caller keeps ({ token, exp }).
 */
async function getAuthToken(cache) {
    const now = Math.floor(Date.now() / 1000)
    // 5 minutes of margin, so a running check does not lose its token halfway.
    if (cache && cache.token && cache.exp > now + 300) {
        return { token: cache.token, exp: cache.exp, refreshed: false }
    }
    const token = await fetchAuthToken()
    return { token, exp: tokenExpiry(token), refreshed: true }
}

class OcapiError extends Error {
    constructor(message, status) {
        super(message)
        this.name = 'OcapiError'
        this.status = status
    }
}

// Cloudflare rate-limits digital-api: 24 calls in a row returned error 1015
// (HTTP 429) with a useless `retry-after: 0`. So we keep a minimum gap between
// requests, plus a backoff when a 429 still happens.
const sleep = ms => new Promise(r => setTimeout(r, ms))
let minGapMs = 0
let lastRequestAt = 0
let onRetry = () => {}

/** Minimum gap between two OCAPI calls (0 = off). */
function setThrottle(ms, notifyFn) {
    minGapMs = Math.max(0, ms || 0)
    if (notifyFn) onRetry = notifyFn
}

const BACKOFF_MS = [3000, 8000, 20000]

async function ocapiGet(token, path) {
    for (let attempt = 0; ; attempt++) {
        const wait = lastRequestAt + minGapMs - Date.now()
        if (wait > 0) await sleep(wait)
        lastRequestAt = Date.now()

        const res = await fetch(OCAPI_URL + path, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        })
        if (res.ok) return res.json()

        const body = await res.text()
        if (res.status === 429 && attempt < BACKOFF_MS.length) {
            const pause = BACKOFF_MS[attempt]
            onRetry(`rate limit on ${path}; waiting ${pause / 1000}s`)
            await sleep(pause)
            continue
        }
        throw new OcapiError(`GET ${path} -> HTTP ${res.status}: ${body.slice(0, 200)}`, res.status)
    }
}

const api = {
    /** All cinemas. */
    sites: token => ocapiGet(token, '/ocapi/v1/sites'),

    /** All films (large: about 690 KB). */
    films: token => ocapiGet(token, '/ocapi/v1/films'),

    /** Films of one cinema. Smaller and faster than the full list. */
    filmsForSite: (token, siteId) => ocapiGet(token, `/ocapi/v1/sites/${siteId}/films`),

    /** Per screening day: which films play at which sites. The cheapest way
     *  to see that a new screening day was added. */
    filmScreeningDates: (token, siteIds) =>
        ocapiGet(token, `/ocapi/v1/film-screening-dates?siteIds=${siteIds.join('&siteIds=')}`),

    /** All screenings on one screening day, with relatedData (screens, attributes, films). */
    showtimesByDate: (token, date, siteIds) =>
        ocapiGet(
            token,
            `/ocapi/v1/showtimes/by-business-date/${date}?siteIds=${siteIds.join('&siteIds=')}`
        ),

    /** Free seats per screening. */
    availability: (token, siteIds) =>
        ocapiGet(token, `/ocapi/v1/showtimes/availability?siteIds=${siteIds.join('&siteIds=')}`),

    /** The seat map itself: rows, columns, labels. It almost never changes and
     *  each version has its own id, so it is safe to cache. */
    seatLayout: (token, seatLayoutId) =>
        ocapiGet(token, `/ocapi/v1/seat-layouts/${seatLayoutId}`),

    /** Status per seat for one screening: Available | Sold | Broken | House. */
    seatAvailability: (token, showtimeId) =>
        ocapiGet(token, `/ocapi/v1/showtimes/${showtimeId}/seat-availability`),
}

module.exports = { api, getAuthToken, fetchAuthToken, tokenExpiry, OcapiError, OCAPI_URL, setThrottle }
