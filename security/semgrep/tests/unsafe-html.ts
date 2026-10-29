// SPDX-License-Identifier: Apache-2.0
// ruleid: harness.no-unsafe-html
element.innerHTML = userInput;
// ruleid: harness.no-unsafe-html
element.outerHTML = userInput;
// ruleid: harness.no-unsafe-html
element.insertAdjacentHTML("beforeend", userInput);
// ruleid: harness.no-unsafe-html
document.write(userInput);
// ok: harness.no-unsafe-html
element.textContent = userInput;
