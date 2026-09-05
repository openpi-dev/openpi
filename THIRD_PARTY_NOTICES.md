# Third-Party Notices

## OAuth model providers

`extensions/ai-providers/` adapts protocol and OAuth details from
[`oh-my-pi`](https://github.com/can1357/oh-my-pi) (Antigravity Cloud Code
Assist and Cursor AgentService). The upstream project is distributed under the
MIT License. Its copyright notice states `Copyright (c) 2025 Mario Zechner`,
`Copyright (c) 2025-2026 Can Bölük`, and `Copyright (c) 2026 Stencil Labs, Inc.`;
the complete license text is included at
[`extensions/ai-providers/LICENSE.upstream`](extensions/ai-providers/LICENSE.upstream).
The local Antigravity message conversion is adapted from the same project's
pi-ai 0.84.1 Google conversion implementation so the installed extension does
not depend on a non-public Pi runtime module.

Cursor support in this package is chat-only: it does not copy or execute
Cursor-native coding tools.

## Sessions extension

`extensions/sessions/` is adapted from
[`jayshah5696/pi-agent-extensions`](https://github.com/jayshah5696/pi-agent-extensions),
version 0.5.2.

The upstream project is distributed under the MIT License. Its notice states
`Copyright (c) 2026`; the complete license text is included at
[`extensions/sessions/LICENSE.upstream`](extensions/sessions/LICENSE.upstream).

OpenPI is distributed under the MIT License; see [`LICENSE`](LICENSE). Portions
identified in this notice retain their original copyright notices and license
terms. The project-wide MIT license does not replace or remove those notices.
