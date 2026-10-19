# Telemetry guarantees

## Known gaps

The leak sentinel compares sanitized telemetry text with known vault values and supported normalized or encoded variants. It is a fail-closed export gate, not a general content classifier; matching is subject to the configured minimum value length, pattern-size limit, and scan budget.

It does not detect arbitrary encryption, compression, steganography, translations, or values split across multiple attributes. The gate scans each payload's canonical text as a whole, but cannot reconstruct values distributed between separately checked attributes or payloads.
