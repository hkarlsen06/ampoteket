"""Rebuild the supplied Vipps QR assets. Requires segno==1.6.6."""

from pathlib import Path

import segno


# Exact bytes decoded from the workshop's Vipps_QR.pdf on 2026-09-19.
PAYLOAD = "https://qr.vipps.no/vp/swDrxGWcp"
OUTPUT = Path(__file__).resolve().parents[2] / "static" / "payments"


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    qr = segno.make_qr(PAYLOAD, error="h", mode="byte", encoding="ascii")
    # Full four-module quiet zone and an opaque white background in both themes.
    qr.save(OUTPUT / "vipps-47322.svg", scale=12, border=4, dark="black", light="white")
    qr.save(OUTPUT / "vipps-47322.png", scale=12, border=4, dark="black", light="white")


if __name__ == "__main__":
    main()
