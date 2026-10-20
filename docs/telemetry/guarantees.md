# Telemetry guarantees

## Known gaps

The leak sentinel compares sanitized telemetry text with known vault values and supported normalized or encoded variants. These include lowercasing combined with whitespace/dash removal, percent encoding, base64 and base64url at all three byte alignments, hex, and HTML numeric entities. Encodings are generated from both the original vault value and its NFKC-normalized form. The combined matcher limits raw vault values; each value expands to about 14 patterns for typical ASCII input, and the total pattern size and scan time are bounded. Patterns shorter than the configured minimum are intentionally omitted.

It does not detect arbitrary encryption, compression, steganography, translations, or transform chains beyond the listed forms. The gate scans each payload's canonical text as a whole, but cannot reconstruct values distributed between separately checked attributes or payloads.
