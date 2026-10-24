// End-to-end smoke test across all Gamex backend services running via docker compose.
// Usage (from gamex-iac, stack running):  node scripts/smoke-test.mjs
// Requires Node 18+ and the docker CLI (to seed one catalog game; the catalog can only import from RAWG otherwise).

import { createSign, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CATALOG = 'http://localhost:5001/api/v1'
const LIBRARY = 'http://localhost:5002/api/v1'
const MESSAGING = 'http://localhost:5003/api/v1'
const NOTIFICATIONS = 'http://localhost:5004/api/v1'

const env = Object.fromEntries(
  readFileSync(path.join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
)
const privateKey = env.JWT_PRIVATE_KEY.replaceAll('\\n', '\n')

let step = 0
const ok = (message) => console.log(`  ✔ ${++step}. ${message}`)

function fail(message) {
  console.error(`  ✘ ${message}`)
  process.exit(1)
}

async function call(method, url, { token, body, expect } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : null
  if (expect && !expect.includes(response.status)) {
    fail(`${method} ${url} → ${response.status} ${text.slice(0, 300)}`)
  }
  return { status: response.status, json, headers: response.headers }
}

/** Polls until `check` returns a truthy value (or fails after the timeout). */
async function waitFor(description, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise((r) => setTimeout(r, 500))
  }
  fail(`timed out waiting for: ${description}`)
}

function adminToken() {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    sub: randomUUID(), name: 'Smoke Admin', role: 'admin', iss: 'gamex-user-library', aud: 'gamex', iat: now, nbf: now, exp: now + 600,
  })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')
  return `${unsigned}.${signature}`
}

const run = Date.now()
console.log('Gamex end-to-end smoke test')

// 1. Everything is up.
for (const port of [5001, 5002, 5003, 5004]) {
  await waitFor(`health on :${port}`, async () => (await fetch(`http://localhost:${port}/health`).catch(() => null))?.ok, 120_000)
}
ok('all four services are healthy')

// 2. Seed one game in the catalog database (RAWG import needs an API key).
const platformId = randomUUID()
const gameId = randomUUID()
const title = `Smoke Test Game ${run}`
const sql = `
  INSERT INTO platforms (id, name, slug, updated_at) VALUES ('${platformId}', 'PlayStation 5 (smoke)', 'smoke-ps5-${run}', UTC_TIMESTAMP(6));
  INSERT INTO games (id, title, created_at, updated_at) VALUES ('${gameId}', '${title}', UTC_TIMESTAMP(), UTC_TIMESTAMP(6));
  INSERT INTO game_platforms (game_id, platform_id) VALUES ('${gameId}', '${platformId}');
  INSERT INTO game_stats (game_id, owned_count, wishlist_count, for_exchange_count, for_sale_count, want_to_buy_count, updated_at)
    VALUES ('${gameId}', 0, 0, 0, 0, 0, UTC_TIMESTAMP());`
execFileSync('docker', ['compose', 'exec', '-T', 'catalog-db', 'mysql', '-uroot', '-plocaldev', 'games_db', '-e', sql], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] })
ok(`seeded "${title}" in the catalog`)

// 3. Catalog → User Library replica via gamex-catalog-events (admin replay of that game).
await call('POST', `${CATALOG}/admin/catalog-events/replay?gameIds=${gameId}`, { token: adminToken(), expect: [202] })
ok('admin replay accepted (admin JWT validated by the catalog)')

// 4. Two users.
const register = async (displayName) => {
  const { json } = await call('POST', `${LIBRARY}/auth/register`, {
    body: { displayName, email: `${displayName.toLowerCase().replaceAll(' ', '.')}.${run}@example.rs`, password: 'correct horse battery' },
    expect: [201],
  })
  return { id: json.user.id, name: displayName, token: json.accessToken }
}
const seller = await register('Sasa Seller')
const buyer = await register('Bojana Buyer')
ok('registered a seller and a buyer')

// 5. Buyer wishlists the game — retried until the replica has it (game-not-synced 409).
await waitFor('catalog replica in User Library', async () => {
  const { status } = await call('POST', `${LIBRARY}/users/me/library`, {
    token: buyer.token, body: { gameId, platformId, format: 'digital', isWishlist: true }, expect: [201, 409],
  })
  return status === 201
})
ok('catalog event reached the User Library replica; buyer added the game to the wishlist')

// 6. Seller lists a copy for sale.
const { json: entry } = await call('POST', `${LIBRARY}/users/me/library`, {
  token: seller.token, body: { gameId, platformId, format: 'physical', isOwned: true, forSale: true, price: 25, condition: 'good' }, expect: [201],
})
ok('seller listed a physical copy for sale')

// 7. User Library → Game Catalog stats via gamex-library-events.
await waitFor('catalog stats', async () => {
  const { json } = await call('GET', `${CATALOG}/games/${gameId}`, { expect: [200] })
  const s = json.stats
  return s.ownedCount === 1 && s.wishlistCount === 1 && s.forSaleCount === 1
})
ok('catalog stats updated: owned 1, wishlist 1, for sale 1')

// 8. User Library → Notification via gamex-activity-events (wishlist match).
const notificationsOf = async (user) => (await call('GET', `${NOTIFICATIONS}/notifications`, { token: user.token, expect: [200] })).json.items
const wishlistMatch = await waitFor('wishlist_match notification', async () => (await notificationsOf(buyer)).find((n) => n.type === 'wishlist_match'))
if (wishlistMatch.data.sellerName !== seller.name) fail(`unexpected sellerName ${wishlistMatch.data.sellerName}`)
ok('buyer got a wishlist_match notification naming the seller')

// 9. Listing contact token (User Library) → conversation (Messaging).
const { json: listing } = await call('GET', `${LIBRARY}/listings/${entry.entryId}`, { expect: [200] })
const { json: conversation } = await call('POST', `${MESSAGING}/conversations`, {
  token: buyer.token, body: { listingId: entry.entryId, contactToken: listing.contactToken, initialMessage: 'Is it still available?' }, expect: [201],
})
if (conversation.otherUser.id !== seller.id) fail('conversation recipient is not the listing owner')
ok('messaging accepted the contact token and started a conversation with the owner')

// 10. Messaging → Notification (new_message).
const newMessage = await waitFor('new_message notification', async () => (await notificationsOf(seller)).find((n) => n.type === 'new_message'))
if (newMessage.data.senderName !== buyer.name || newMessage.data.gameTitle !== title) fail(`unexpected new_message data ${JSON.stringify(newMessage.data)}`)
ok('seller got a new_message notification with sender name and game title')

// 11. Two-sided completion → transaction.completed → rate_your_partner for both.
await call('POST', `${LIBRARY}/listings/${entry.entryId}/complete`, { token: seller.token, body: { partnerUserId: buyer.id }, expect: [200] })
const { json: completion } = await call('POST', `${LIBRARY}/listings/${entry.entryId}/complete`, { token: buyer.token, body: {}, expect: [200] })
if (!completion.completed) fail('transaction did not complete')
for (const user of [seller, buyer]) {
  await waitFor(`rate_your_partner for ${user.name}`, async () => (await notificationsOf(user)).find((n) => n.type === 'rate_your_partner'))
}
ok('both parties got rate_your_partner notifications')

await call('POST', `${LIBRARY}/users/${seller.id}/ratings`, { token: buyer.token, body: { transactionId: completion.transactionId, score: 5, comment: 'Smooth deal' }, expect: [201] })
const { json: profile } = await call('GET', `${LIBRARY}/users/${seller.id}`, { expect: [200] })
if (profile.ratingCount !== 1) fail('rating not recorded')
ok('buyer rated the seller')

// 12. Completion withdrew the sale offer → catalog stats follow.
await waitFor('for-sale count back to 0', async () => (await call('GET', `${CATALOG}/games/${gameId}`, { expect: [200] })).json.stats.forSaleCount === 0)
ok('completing the deal withdrew the listing; catalog for-sale count is 0 again')

console.log(`\nAll ${step} checks passed in ${((Date.now() - run) / 1000).toFixed(1)}s.`)
