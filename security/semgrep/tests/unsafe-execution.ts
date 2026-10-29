// SPDX-License-Identifier: Apache-2.0
// ruleid: harness.no-shell-exec
import { exec as runCommand } from "node:child_process";
import * as child_process from "node:child_process";

// ruleid: harness.no-shell-exec
child_process.exec("ls");
// ruleid: harness.no-shell-exec
child_process.execSync("ls");
// ruleid: harness.no-shell-exec
child_process.spawn("ls", [], { shell: true });
// ok: harness.no-shell-exec
child_process.spawn("ls", [], { shell: false });

// ruleid: harness.no-eval
eval("1 + 1");
// ruleid: harness.no-eval
new Function("return 1")();
// ok: harness.no-eval
JSON.parse("{}");
