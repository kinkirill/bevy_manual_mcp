# Third-party notices

This project's own source code is licensed under the MIT License (see `LICENSE`).
It additionally redistributes or derives data from the following third-party
projects. Their notices are reproduced below.

---

## Bevy website content (`vendor/bevy-website/`)

The Markdown and Rust source files under `vendor/bevy-website/` are a trimmed
copy of <https://github.com/bevyengine/bevy-website> - the Bevy Book, migration
guides, release notes and learning-code-examples. Only `.md` and `.rs` files are
kept; all media assets are omitted.

Licensed under the MIT License:

```
MIT License

Copyright (c) 2020 Bevy Engine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Bevy engine and rustdoc-derived index

The search index distributed through this project's GitHub Releases is derived
from rustdoc HTML published on <https://docs.rs/bevy> and from the Bevy engine
source. Bevy is dual-licensed under your choice of either:

- MIT License - Copyright (c) 2020 Bevy Engine
- Apache License, Version 2.0 (<http://www.apache.org/licenses/LICENSE-2.0>)

The index contains derived API metadata (paths, signatures, documentation
strings) for the purpose of answering questions about Bevy's public API. It is
not a copy of the engine source. Full license texts:

- <https://github.com/bevyengine/bevy/blob/main/LICENSE-MIT>
- <https://github.com/bevyengine/bevy/blob/main/LICENSE-APACHE>

---

## Runtime dependencies

Dependencies declared in `package.json` (`@modelcontextprotocol/sdk`, `cheerio`,
`flexsearch`, `zod`) are fetched from npm and carry their own licenses, not
redistributed here.
