# mdwrkcom

The `mdwrkcom` repo is the source-of-truth home for `@mdwrk/mdwrkcom-content-pack`.

It owns the mdwrk.com first-party content tree, markdown data, packaged public assets, and generated discovery artifacts. The deployable site host lives separately in `mdwrk-com`.

## Contents

- `packages/content/mdwrkcom-content-pack` contains the published content-pack package.

## Commands

```bash
npm install
npm run build
npm run typecheck
npm run test
```

## Split Boundary

- Reusable page/site generation packages belong in `mdwrk-pages`.
- The deployable public site host belongs in `mdwrk-com`.
- This repo owns only the first-party mdwrk.com content-pack source.
- Theme, editor, renderer, preview, and shell token contracts are implemented upstream; this repo should consume them rather than redefining them.
