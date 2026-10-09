// SPDX-License-Identifier: Apache-2.0
import { main } from "./main.js";

process.exitCode = await main(process.argv.slice(2));
