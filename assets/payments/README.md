# Vipps QR

The workshop supplied Vipps number **47322** and `Vipps_QR.pdf`. Its QR contains
exactly these 32 ASCII bytes:

```text
https://qr.vipps.no/vp/swDrxGWcp
```

Source PDF SHA-256:
`8ede38c6ae1e9643479c2eb103371206e9ab3d761e85328e69e447eeb766d618`.

The link opens the recipient only, with a freeform amount (checked by the owner on a
phone). The PDF's NOK 150 membership text is not part of the shop flow. Keep the
opaque URL; never append amount or message parameters. Payment stays self-reported
and is never verified by the website.

## Assets

- `static/payments/vipps-47322.svg`: vector QR, black on opaque white.
- `static/payments/vipps-47322.png`: 492 × 492 px, for print/export.

Both encode the URL with error correction H, a four-module quiet zone and no logo.
Keep the white background and quiet zone when displaying or printing. The website
shows the SVG only in checkout, after the checkout is saved durably, with localized
alt text, the readable Vipps number and the exact amount beside it
(`src/lib/CheckoutPage.svelte`). Confirmation-attempt and registered states hide
both QR and link; the full rules are in [page-checkout.md](../../docs/page-checkout.md)
and [checkout-recovery.md](../../docs/checkout-recovery.md).

## Rebuild

No application dependency is required. From the repository root:

```sh
python3 -m venv /tmp/ampoteket-vipps-build
/tmp/ampoteket-vipps-build/bin/python -m pip install segno==1.6.6
/tmp/ampoteket-vipps-build/bin/python assets/payments/build.py
```
