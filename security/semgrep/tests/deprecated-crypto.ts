// SPDX-License-Identifier: Apache-2.0
// ruleid: harness.deprecated-cipher-api
createCipher("aes-256-cbc", key);
// ruleid: harness.deprecated-cipher-api
crypto.createDecipher("aes-256-cbc", key);
// ok: harness.deprecated-cipher-api
createCipheriv("aes-256-gcm", key, iv);

// ruleid: harness.no-ecb-mode
const cipherMode = "aes-256-ecb";
// ok: harness.no-ecb-mode
const authenticatedMode = "aes-256-gcm";
