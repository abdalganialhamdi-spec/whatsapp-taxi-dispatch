len=10709
-cause ranking

The string `Invalid account signature` at `validate-connection.js:112` is the **ADV HMAC branch**, not the Curve signature branch:

```js
const advSign = hmacSign(details, Buffer.from(advSecretKey, 'base64'))
if (Buffer.compare(hmac, advSign) !== 0) throw new Boom('Invalid account signature')
```

Meaning: the `advSecretKey` your socket holds ≠ the one the phone used. In the pairing-code flow `advSecretKey` is not random — it is *derived* at the `link_code_companion_reg / companion_finish` step from `HKDF(companionSharedKey ‖ identitySharedKey ‖ random, 'adv_secret')`, where `companionSharedKey` depends on deciphering the primary's ephemeral pub with `derivePairingCodeKey(creds.pairingCode, salt)`. That cipher is **AES-CTR — unauthenticated**. So any code/keypair mismatch produces a garbage shared secret *silently* and the only place it ever surfaces is this HMAC compare. That is the fingerprint you hit.

1. **Stale code1 entered against socket B's pairing state — most likely.** Two live codes for the same number 79s apart; entry 17s after code2. If the phone submitted code1 (old screen/notification/clipboard) against B's pending registration, the derived key diverges and fails exactly here, at exactly this stage. Fits the timeline and the crypto.
2. **Your "3 retries" of `requestPairingCode` on one socket — close second.** Each call re-derives a new `pairingCode`/`random`/`advSecretKey` and sends a new key bundle. The phone pairs against one; `authState.creds` keeps the last. Identical symptom, different trigger. Verify from logs whether more than one code was ever emitted per socket.
3. **Cred/persistence corruption — plausible but secondary.** Disk writes cannot corrupt in-memory `advSecretKey`, so your ungated `saveCreds` is not the direct cause. It *is* the cause if `useMultiFileAuthState()` is called before `freshSession()` wipes the dir, or if the `auth`/`saveCreds` closure is shared across generations — then socket B runs on socket A's `pairingEphemeralKeyPair`. Cheap to rule out; must be ruled out.
4. **Version/browser mismatch — not the cause.** A bad version fails as 405/403/`stream:error` *before* `pair-success`. You reached the ADV check, so the protocol shape was accepted. (Cosmetic: `'20.0.04'` is not a real Ubuntu version; use `Browsers.ubuntu('Chrome')`.)
5. **Account-side pressure — co-factor only.** Throttling shows up as no code, `428`, `connection replaced`, or the phone refusing — never as an HMAC mismatch. It matters only because aggressive server-side expiry of pending registrations makes #1 more likely.

## 2. Yes, the dir is poisoned — quarantine it

Your paradox is explained by `authState.creds.registered = true` being set in the `companion_finish` handler, **before** `pair-success` is validated. So `registered: true` on disk is proof the companion stage ran, not proof of a successful pairing. Your ungated writer then made it durable.

Reusing that dir breaks three ways:

- `requestPairingCode` set `creds.me`. `validateConnection()` branches on `if (!creds.me)`, so the next socket sends a **login node** for a device the server never registered → immediate `401`/`403`, no registration path, no QR.
- `registered: true` makes your `!auth.creds.registered` gate skip the pairing-code request → silent reconnect loop with no code and no QR forever.
- The garbage `advSecretKey`, plus a `registrationId` and pre-keys the server never accepted, persist.

Wipe the **whole directory**, not just `creds.json` (`pre-key-*.json`, `app-state-sync-key-*.json` leak too). Add a boot guard so this state can never be loaded again:

```ts
// registered:true is meaningless on its own — only these prove a completed pairing
const isReallyRegistered = (c: AuthenticationCreds) =>
  !!c.registered && !!c.account?.accountSignature &&
  !!c.signalIdentities?.length && !!c.me?.id?.includes(':')

if (state.creds.registered && !isReallyRegistered(state.creds)) {
  await quarantine(sessionDir)          // mv sessionDir sessionDir.poisoned.<ts>
  throw new Error('half-paired session quarantined, start a fresh pairing')
}
```

Use `isReallyRegistered(...)` instead of `creds.registered` as your pairing-code gate.

## 3. Minimal fix: creds live in memory until the first `open`

`saveCreds` from `useMultiFileAuthState` ignores its argument and writes the live `state.creds` object, so you don't need to buffer deltas — one call after `open` persists everything accumulated (`advSecretKey`, `account`, `signalIdentities`, `me.lid`, `nextPreKeyId`).

```diff
 const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
+let handshakeComplete = false   // true only after the first 'open'
+let credsDirty = false
 
 const s = makeWASocket({
   auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
+  qrTimeout: 180_000,           // 60s can end the socket while the user is typing
   ...
 })
 
-s.ev.on('creds.update', (c) => { if (myGen === gen) saveCreds(c) })
+s.ev.on('creds.update', async () => {
+  if (myGen !== gen) return           // stale generation must never touch disk
+  if (!handshakeComplete) {           // pairing in flight -> memory only
+    credsDirty = true
+    return
+  }
+  await saveCreds()
+})
+
+s.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
+  if (myGen !== gen) return
+  if (connection === 'open') {
+    handshakeComplete = true
+    credsDirty = false
+    await saveCreds()                 // first durable write, fully consistent
+  }
+  if (connection === 'close' && !handshakeComplete) {
+    await quarantine(sessionDir)      // partial pairing state is never reusable
+  }
+})
```

Two changes that must accompany it:

```diff
-// 4s after socket start, 3 retries
-setTimeout(() => requestWithRetries(3), 4000)
+// exactly one code, triggered by the first qr (proves noise handshake done
+// and the server accepted the registration node)
+let codeRequested = false
+s.ev.on('connection.update', async ({ qr }) => {
+  if (!qr || codeRequested || myGen !== gen) return
+  if (isReallyRegistered(state.creds)) return
+  codeRequested = true
+  const code = await s.requestPairingCode(number)   // no retries, ever
+  logger.info({ code, issuedAt: Date.now(), gen }, 'pairing code issued')
+})
```

And handle `515`, or pairing never completes even when the crypto is correct:

```ts
if (statusCode === DisconnectReason.restartRequired) {
  // expected right after a successful pairing — reconnect on the SAME dir, do not wipe
  return start(sessionDir, { gen: ++gen })
}
```

## 4. Single clean attempt

1. Confirm exactly one process and one socket alive (`ps`), then `mv session session.poisoned.<ts> && mkdir session`.
2. Load `useMultiFileAuthState` **after** the wipe, never before.
3. On the phone: back out of any open "Link with phone number" screen, dismiss stale link notifications, and remove any half-linked device entry under Linked devices.
4. Cool down 15–30 min given the day's QR churn; max one attempt per 10 min.
5. Start one socket → wait for the first `qr` → request **one** code → log it with its timestamp.
6. Enter it within 60s of issuance. If nothing happens in 120s: tear down, quarantine, cool down. Never issue a second code on the same socket; never wipe while a code is live.

Real success is this exact log sequence — the first line is the discriminator, because it only prints after both the ADV HMAC and the account signature verified:

```
pairing configured successfully, expect to restart the connection...
connection.update { isNewLogin: true }
close  statusCode 515 (restartRequired)      <- expected, reconnect same dir
opened connection to WA / connection: 'open' <- only now is creds.json written
```

`creds.json` after a real pairing:

| field | real | your fake-registered state |
|---|---|---|
| `me.id` | `963992265248:<device>@s.whatsapp.net` | `963992265248@s.whatsapp.net` |
| `me.name` / `me.lid` | real name / present | `~` / absent |
| `account` | `{details, accountSignature, accountSignatureKey, deviceSignature}` | absent |
| `signalIdentities` | non-empty | absent/empty |
| `platform` | set | absent |
| `pairingCode` | irrelevant/cleared | still set |
| `nextPreKeyId` | ≫1 (pre-keys uploaded) | `1` |
| dir contents | `pre-key-*.json`, `app-state-sync-key-*.json` | creds only |

## 5. Server-side guard: never wipe while a code is live

Key the pairing state by phone number, hold a per-number mutex, and make `freshSession()` reachable only when there is no live code and no live socket.

```ts
type Pair = {
  gen: number; dir: string; code: string; issuedAt: number; expiresAt: number
  sock: WASocket; status: 'starting' | 'code_issued' | 'submitted' | 'open' | 'dead'
}
const pairs = new Map<string, Pair>()
const locks = new Map<string, Promise<any>>()
const CODE_TTL = 90_000

const withLock = <T>(k: string, fn: () => Promise<T>) => {
  const p = (locks.get(k) ?? Promise.resolve()).then(fn, fn)
  locks.set(k, p.catch(() => {}))
  return p
}

app.post('/pair/code', (req, res) => withLock(req.body.number, async () => {
  const number = normalize(req.body.number)
  const cur = pairs.get(number)

  // idempotent: a second press returns the SAME code, no wipe, no new socket
  if (cur && cur.status === 'code_issued' && Date.now() < cur.expiresAt) {
    return res.json({ code: cur.code, reused: true, expiresInMs: cur.expiresAt - Date.now() })
  }
  // code already submitted: pairing handshake in flight, wiping now kills it
  if (cur && (cur.status === 'submitted' || cur.status === 'starting')) {
    return res.status(409).json({ error: 'pairing_in_progress' })
  }
  if (cur && cur.status === 'open') {
    return res.status(409).json({ error: 'already_linked' })
  }
  // only reachable path to a wipe; require ?force=1 to pre-empt anything else
  if (cur && cur.status !== 'dead' && req.query.force !== '1') {
    return res.status(409).json({ error: 'busy', status: cur.status })
  }

  if (cur) { try { cur.sock.end(undefined) } catch {} await quarantine(cur.dir) }
  const p = await startPairing(number)        // wipe + fresh auth state + one code
  pairs.set(number, p)
  res.json({ code: p.code, reused: false, expiresInMs: CODE_TTL })
}))
```

Status transitions: `starting` → `code_issued` on the `requestPairingCode` return; → `submitted` on `connection.update { isNewLogin: true }` (or when `state.creds.advSecretKey` changes, which is your earliest signal that the phone submitted a code); → `open` on `connection: 'open'`; → `dead` on close-without-open, which also quarantines the dir. Add `POST /pair/cancel` as the explicit teardown path so users have a legitimate way to reset instead of double-pressing `/pair/code`.