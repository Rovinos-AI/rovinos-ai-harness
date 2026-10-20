# Telemetry guarantees

## Known gaps

The leak sentinel compares sanitized telemetry text with known vault values and supported normalized or encoded variants. These include lowercasing combined with whitespace/dash removal, percent encoding, base64 and base64url at all three byte alignments, hex, and HTML numeric entities. Encodings are generated from both the original vault value and its NFKC-normalized form. The combined matcher has separate limits on raw vault values and the deduplicated expanded patterns (1,000,000 total pattern characters); exceeding either limit switches global scans to per-run matchers. Per-run matcher construction also enforces the pattern-character limit and fails closed if exceeded. Patterns shorter than the configured minimum are intentionally omitted.

It does not detect arbitrary encryption, compression, steganography, translations, or transform chains beyond normalized plaintext forms and a single supported encoding applied to the original or NFKC-normalized value. The gate scans each payload's canonical text as a whole, but cannot reconstruct values distributed between separately checked attributes or payloads.
