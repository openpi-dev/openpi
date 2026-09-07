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

## Web production bundle

`web/dist/app.js` and `web/dist/styles.css` contain code from the packages
listed below. This inventory was taken from the Vite production module graph;
build-only packages are not included.

### MIT-licensed packages

Copyright (c) 2026 Meta Platforms, Inc.:

- `@astryxdesign/core@0.5.2`
- `@astryxdesign/theme-neutral@0.5.2`

Copyright (c) Meta Platforms, Inc. and affiliates:

- `@stylexjs/stylex@0.19.0`
- `react@19.2.8`
- `react-dom@19.2.8`
- `scheduler@0.27.0`
- `use-sync-external-store@1.6.0`

Copyright (c) 2023 FormatJS:

- `@formatjs/fast-memoize@3.1.7`
- `@formatjs/icu-messageformat-parser@3.5.17`
- `@formatjs/icu-skeleton-parser@2.1.11`

Copyright (c) 2011-present i18next:

- `i18next@26.4.1`

Copyright (c) 2015-present i18next:

- `react-i18next@17.0.13`

Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com>:

- `eventsource-parser@4.1.0`

Copyright (c) Espen Hovlandsdal:

- `react-markdown@10.1.0`

Copyright (c) 2019 Paul Henschel:

- `zustand@5.0.15`

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com>
(<https://sindresorhus.com>):

- `escape-string-regexp@5.0.0`
- `is-plain-obj@4.1.0`

Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>:

- `inline-style-parser@0.2.7`

Copyright (c) 2014 Stefan Thomas:

- `extend@3.0.2`

Copyright (c) 2017 Menglin "Mark" Xu <mark@remarkablemark.org>:

- `style-to-object@1.0.14`

Copyright (c) 2020 Menglin "Mark" Xu <mark@remarkablemark.org>:

- `style-to-js@1.1.21`

Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com>:

- `remark-parse@11.0.0`

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>:

- `bail@2.0.2`, `ccount@2.0.1`, `mdast-util-to-string@4.0.0`
- `unified@11.0.5`, `unist-util-is@6.0.1`, `unist-util-position@5.0.0`
- `unist-util-visit@5.1.0`, `vfile@6.0.3`

Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com>:

- `longest-streak@3.1.0`, `trim-lines@3.0.1`

Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>:

- `comma-separated-tokens@2.0.3`, `hast-util-whitespace@3.0.0`
- `mdast-util-to-hast@13.2.1`, `rehype-sanitize@6.0.0`
- `space-separated-tokens@2.0.2`, `trough@2.2.0`
- `unist-util-stringify-position@4.0.0`, `unist-util-visit-parents@6.0.2`

Copyright (c) 2017 Titus Wormer <tituswormer@gmail.com>:

- `mdast-util-newline-to-break@2.0.0`, `remark-breaks@4.0.0`

Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>:

- `estree-util-is-identifier-name@3.0.0`
- `mdast-util-gfm-autolink-literal@2.0.1`
- `mdast-util-gfm-strikethrough@2.0.0`, `mdast-util-gfm-table@2.0.0`
- `mdast-util-gfm-task-list-item@2.0.0`, `micromark-extension-gfm@3.0.0`
- `micromark-extension-gfm-autolink-literal@2.1.0`
- `micromark-extension-gfm-strikethrough@2.1.0`
- `micromark-extension-gfm-task-list-item@2.1.0`

Copyright (c) 2021 Titus Wormer <tituswormer@gmail.com>:

- `micromark-extension-gfm-footnote@2.1.0`

Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com>:

- `devlop@1.1.0`

Copyright (c) Titus Wormer <tituswormer@gmail.com>:

- `decode-named-character-reference@1.3.0`, `hast-util-sanitize@5.0.2`
- `hast-util-to-jsx-runtime@2.3.6`, `markdown-table@3.0.4`
- `mdast-util-find-and-replace@3.0.2`, `mdast-util-from-markdown@2.0.3`
- `mdast-util-gfm@3.1.0`, `mdast-util-gfm-footnote@2.1.0`
- `mdast-util-to-markdown@2.1.2`, `micromark@4.0.2`
- `micromark-core-commonmark@2.0.3`, `micromark-extension-gfm-table@2.1.1`
- `micromark-factory-destination@2.0.1`, `micromark-factory-label@2.0.1`
- `micromark-factory-space@2.0.1`, `micromark-factory-title@2.0.1`
- `micromark-factory-whitespace@2.0.1`, `micromark-util-character@2.1.1`
- `micromark-util-chunked@2.0.1`, `micromark-util-classify-character@2.0.1`
- `micromark-util-combine-extensions@2.0.1`
- `micromark-util-decode-numeric-character-reference@2.0.2`
- `micromark-util-decode-string@2.0.1`, `micromark-util-html-tag-name@2.0.1`
- `micromark-util-normalize-identifier@2.0.1`
- `micromark-util-resolve-all@2.0.1`, `micromark-util-sanitize-uri@2.0.1`
- `micromark-util-subtokenize@2.1.0`, `remark-gfm@4.0.1`
- `remark-rehype@11.1.2`, `vfile-message@4.0.3`

Copyright (c) Titus Wormer:

- `html-url-attributes@3.0.1`

Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>:

- `property-information@7.2.0`

`mdast-util-phrasing@4.1.0` retains both of its notices:

- Copyright (c) 2017 Titus Wormer <tituswormer@gmail.com>
- Copyright (c) 2017 Victor Felder <victor@draft.li>

The MIT terms for the packages above are:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### ISC-licensed packages

Copyright (c) 2021, Andrea Giammarchi, @WebReflection:

- `@ungap/structured-clone@1.4.0`

Copyright (c) 2026 Lucide Icons and Contributors:

- `lucide-react@1.39.0`

The ISC terms for these packages are:

> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
> REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
> AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
> INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
> LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
> OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
> PERFORMANCE OF THIS SOFTWARE.

Some Lucide icons are derived from Feather and retain this additional notice:

> Copyright (c) 2013-present Cole Bemis
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### BSD-3-Clause package

`intl-messageformat@11.2.14` retains this notice:

> Copyright (c) 2023, Oath Inc.
>
> Redistribution and use of this software in source and binary forms, with or
> without modification, are permitted provided that the following conditions
> are met:
>
> - Redistributions of source code must retain the above copyright notice,
>   this list of conditions and the following disclaimer.
> - Redistributions in binary form must reproduce the above copyright notice,
>   this list of conditions and the following disclaimer in the documentation
>   and/or other materials provided with the distribution.
> - Neither the name of Oath Inc. nor the names of its contributors may be used
>   to endorse or promote products derived from this software without specific
>   prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
> ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
> LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
> INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
> CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
> ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.
