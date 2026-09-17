# Product scanner

One buyer scanner dialog in the shared locale layout (home, catalog, product and
cart, both languages), plus staff scanners that reuse its camera session. A QR code
is only an identifier: **scanning never adds to the basket, navigates or registers
a purchase by itself.**

## 1. Selected approach

A small Svelte camera/session controller wraps the explicit
`barcode-detector/ponyfill` export with `formats: ['qr_code']`. That gives the same
ZXing-C++/WebAssembly decoder on every browser, with no reliance on native iOS
detection. Camera ownership, frame capture, confirmation and basket changes are
application code; Ampoteket implements no QR recognition itself.
[barcode-detector](https://github.com/Sec-ant/barcode-detector#ponyfill)

Pin `barcode-detector` **3.2.2** with its exact dependency `zxing-wasm` **3.1.3**.
Keep that pair; a newer standalone WASM is not an upgrade path.

Alternatives considered:

- **Native BarcodeDetector:** not available everywhere.
- **Nimiq qr-scanner:** `pause()` stops the stream after 300 ms; confirmation needs longer.
- **STRICH:** the paid fallback. Trial it on the same labels and phones only if
  repeatable failures or camera maintenance justify the subscription.
- **Barqode, html5-qrcode, @zxing/library:** stale or maintenance-only.

The ponyfill does not lift browser camera restrictions or set an iOS version floor.
Request the rear camera as an *ideal* preference, video only, after an explicit user
action. Use muted inline (`playsinline`) video and handle rejected playback.

## 2. Boundaries and dependency delivery

camera/session → decoder adapter → shared scanner UI → strict code parser → public
catalog lookup → existing basket operation. The decoder only turns an image into
text and geometry:

```ts
type QrDetection = {
  value: string;
  corners: { x: number; y: number }[]; // normalized to the decoded crop
};

type QrDecoder = {
  decode(frame: ImageData): Promise<QrDetection[]>;
  dispose(): void;
};
```

- Decoding runs in a dedicated module worker. `dispose()` terminates it and rejects
  any pending request. Initialization and each decode have a 15-second deadline.
- Third-party imports live inside that worker, loaded only after the user opens
  scanning. Page loads and SSR never start the camera, import the decoder or fetch WASM.
- Replacing the decoder must not touch URL validation, product lookup, quantity
  validation, cart locking or checkout. A commercial SDK with its own camera
  controller may also need a new session adapter.
- Vite emits the 3.1.3 **reader** WASM as a same-origin asset. The worker fetches
  it, checks its SHA-256 against `ZXING_WASM_SHA256` and passes the bytes to
  `prepareZXingModule`. Any other WASM lookup fails closed; there is no CDN fallback.
- On upgrade, change the lockfile and WASM hash together, confirm they match
  ([version matching](https://github.com/Sec-ant/zxing-wasm#configuring-wasm-serving)),
  and repeat the decoder and phone cases. Network traces must show only same-origin
  WASM and no third-party decoder request.

## 3. State and camera lifecycle

```text
CLOSED → STARTING → SCANNING
                       ↓ accepted detection; close gate synchronously
                  FROZEN / RESOLVING
                       ↓ product returned
                  CONFIRMING
                       ├─ Add succeeds → SCANNING
                       ├─ Scan → SCANNING
                       └─ Add fails → retain confirmation and explain

Any open state → close/navigation → CLOSED
Camera interruption/background → suspended/retry state
```

| Concern | During confirmation | When closed or recovering |
|---|---|---|
| Visible frame | Show a still of the frame that decoded. | Remove the still and free it. |
| Decode loop | Suspended; at most one decode in flight. | Cancel scheduling; ignore late results. |
| Camera tracks | Keep the live stream running underneath. | Stop every track and detach the video. |

- **Target:** decode the marked inner 80% of a centre square (up to 768 px). With
  several codes, take the one nearest the centre by geometry; if nearly tied, wait.
  Never rely on decoder result order. The still shown is the frame that decoded.
- **Gate:** close the acceptance gate synchronously before lookup. Results from an
  earlier session, cancelled lookup or unmounted component are ignored. Lookups are
  cancellable; unknown and unavailable are different states.
- **Confirmation:** `ProductPurchase` (shared with the product page) owns quantity,
  validation and the basket write; checkout and storage locks still apply. If a
  write may have succeeded but read-back failed, keep the confirmation, disable Add
  and send the buyer to the basket. Only Add or Scan resumes scanning; no timer does.
- **Repeat suppression:** ignore the last payload until it is absent for three
  fresh frames spanning 600 ms. Scan again allows a deliberate repeat.
- **Lifecycle:** on page hide, release the camera but keep any confirmation, and
  offer resume on return. Handle ended/muted tracks and stalled playback. Stop a
  stream that arrives from a late `getUserMedia()` after close. Unmount removes
  listeners, frames, lookups and images.

Placement:

- One visible buyer trigger: a header-menu row above 40rem, or a floating Scan
  button at phone widths (on the home page it appears once the hero's Scan button
  slides under the header). None on checkout, help or admin pages, and no page-level
  triggers. Without JavaScript the trigger is hidden. Only deliberate activation
  opens it; `?scan=1` does nothing. Placement details: [design system](design-system.md#4-layout).
- The dialog is a shared `Dialog` with `preventScroll={false}`. It fits a 360×640
  phone without interior scrolling. Close, Escape or backdrop release the camera like
  navigation; only an Add in flight blocks closing. Focus returns to the trigger.
  The product name links to its localized details page.
- `AdminProductScanner` (admin product list and stock corrections page) uses the same
  session and parser, matches loaded staff products (including inactive ones), and
  opens or selects the product without any stock change. Admin order receiving has
  its own camera control that identifies order lines and still needs an explicit
  quantity and submission; see [admin orders](page-admin-orders.md).

## 4. QR input is an identifier

New labels encode **`ampoteket.no/p/CODE`** (one path parameter, e.g.
`ampoteket.no/p/AMP-00123`). Older `https://ampoteket.no/p/CODE` labels still work.
Never add a query, locale, price, name, placement or stock. Codes are never reused.

Camera payloads:

- Add `https://` only to the exact scheme-less label prefix, then parse with `new URL(...)`.
- Require the canonical HTTPS origin, no credentials, exactly `/p/` plus one code
  matching `[A-Z0-9][A-Z0-9-]{0,39}`, and no query or fragment.
- Reject foreign hosts, protocol-relative input, userinfo, extra segments, encoded
  path tricks and malformed URLs. The current dev origin is not an allowed label origin.

Manual entry in the dialog works without camera, permission or WASM. It accepts
either label address or a bare code, trimmed and case-insensitive, using the same
parser (Find stays disabled until valid). Bare codes may omit the hyphen (`res00026`)
via the exact-first fallback in [catalog matching](page-catalog.md#3-url-and-matching-rules);
scanned and pasted addresses use exact lookup. Manual paths never loosen what the
camera accepts.

Resolve the code only through `amp_catalog(p_code)`. Never navigate to, fetch,
prefetch or link the scanned URL. All product facts come from that response. A valid
but unknown code is a normal result.

Printed labels keep the human-readable code and a quiet zone of at least four QR
modules on every side, clear of text, cut marks, tape and drawer edges.

## 5. Physical acceptance record

The owner used the scanner successfully on an iPhone (2026-09-20), but model,
versions and individual cases were not recorded. Every case below is **not run**.
Android and older/slower phones have no coverage. Do not describe phone acceptance
as complete from desktop automation or one iPhone; narrowing supported devices is a
separate, recorded decision.

Setup:

- Use a trusted HTTPS origin the phone can reach, on disposable stock. Never use
  production credentials. Record the origin and build.
- `bun run development` injects a loopback API URL the phone cannot reach. Instead
  run `./scripts/seed-test.sh --count 30 --api-port 54329`, then start Vite with
  `PUBLIC_SUPABASE_URL=https://dev.ampoteket.no` and the seed's public key, and open
  `https://dev.ampoteket.no/en/p` over the tailnet (Caddy proxies the API). Payment
  rehearsals also need the seed's server-only checkout key and an exact HTTPS
  `CHECKOUT_ALLOWED_ORIGIN`; see [README](../README.md).
- `./scripts/test-web.sh --scanner` leaves synthetic labels in
  `test-results/scanner/` (40 mm is not the agreed size). Printed trials use real
  Admin → Product labels exports at 100%.
- Prepare two known products, an unknown code, a free and a priced item, plus a
  malformed product URL and an unrelated HTTPS site. Test Safari, then iOS Chrome if
  used (it does not replace Android). Record PASS, FAIL or NOT RUN per case and
  browser, with label size, printer, lighting and distance.

Open cases (each must hold on the phone):

- **P01** Every page with a trigger shows the same confirmation; camera starts only after opening.
- **P02** Ten alternating scan → Add cycles change the basket once each and resume scanning.
- **P03** A label held still does not repeat; Scan again does.
- **P04** With several labels in view, the centred one wins, not decoder order.
- **P05** Rapid labels and Add taps give one confirmation and no duplicate write.
- **P06** The frame stays frozen through lookup and a 15 s wait; Scan resumes without a new prompt.
- **P07** Denied camera: manual entry works, and allowing later recovers without losing the basket.
- **P08** Backgrounding while scanning, resolving or confirming releases the camera; no stale result or automatic Add.
- **P09** Lock/unlock in the same states gives a clear resume path.
- **P10** Closing during permission, decoding or slow lookup leaves no late confirmation; reopening gives one session.
- **P11** Delayed/failed lookup is cancellable; unavailable differs from unknown.
- **P12** A failed or uncertain basket write keeps the confirmation; uncertain writes disable Add and require review.
- **P13** Malformed, unknown, unrelated, query/fragment and bare-text payloads are rejected with no request to the scanned URL.
- **P14** Printed labels on real drawers scan in normal and dim light, at angles and real distances; the system camera offers the product page.
- **P15** Orientation, long names, keyboard, VoiceOver, both languages and colour schemes: no horizontal scroll, trapped focus or clipped controls.
- **P16** Scan → basket → checkout → Vipps → register, also with free items and an interrupted registration: saved amount, one registration, no repayment request.
- **P17** Repeated open/close and an interrupted WASM load recover; decoder loads only from this origin.
- **P18** One trigger at phone and desktop widths, hidden during text entry and under dialogs; focus restored; phone cart shortcut when nonempty.
- **P19** Admin scanner opens active and inactive products without basket change; no buyer trigger on checkout or admin pages.

Network/storage fault injection may need a developer alongside the phone tester.
Automated checkout tests support these cases but cannot prove camera, lock screen,
real labels or Vipps app switching. Status lives in [VALIDATION.md](../VALIDATION.md).
