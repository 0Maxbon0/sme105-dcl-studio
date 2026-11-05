# Read-only forensic derivatives

Derived without changing original owner files. Source ZIP:
`/home/maxim/Downloads/sme105-phone-diagnostics-20261105-165356.zip`
SHA256 `852d3dcfd47c9876d28c9606ce5c38bbf6bdbf4723237347444c5e17ed1375d9`.

- `main-koer.txt.gz`: exact `bridge-raw.txt` lines 58920–91791, including original host UTC/monotonic stamps and bridge text. No credentials included.
- `koeo.txt.gz`: original KOEO arm through END, beginning 16:30:57.261Z. Demonstrates the same result-phase bit without a validated operator cue.
- `iat.csv`: ACT and IACT rows only from `/home/maxim/Downloads/eec-iv-live (5).csv`, retaining time, PID, raw and value. ACT reaches 37.8 at 16.564338 s; IACT first reaches 474 at 42.888280 s. Difference 26.323942 s. Owner reports the connector event; these files do not independently time that physical action or prove fallback/calibration.

Run `node scripts/verify-preserved-koer.mjs` to validate the original ZIP hash and exact main derivative, decode every RX byte, and regenerate `artifacts/koer-forensic-verification.json`. Normal `npm test` uses these small sanitized derivatives so tests remain portable without the owner's complete private export.

Timestamp caution: published first-DTC UTCs refer to the containing frame-sync RX line. Actual slot-15 word receipts occur later and are separately retained (`receivedAt`, `rxTimeUs`). Host receipt batching is not a synchronized ECU clock. Both bases remain visible in evidence.
