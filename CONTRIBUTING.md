# Contributing to Duck Lab XR

Thanks for helping. Duck Lab XR is a mixed-reality game and training lab for
Pollen Robotics' Microduck, built with [IWSDK](https://iwsdk.dev) (WebXR),
MuJoCo (WebAssembly) and ONNX Runtime. Bug reports, fixes, playgrounds, docs
and tests are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs and ideas:** open a GitHub issue. For a bug, say what you ran it on
  (Quest model and browser version, or desktop browser), what you did, what you
  expected and what happened. Console errors and a screenshot help.
- **Security problems:** do not open a public issue; see [SECURITY.md](SECURITY.md).
- **Bigger changes** (a new playground, a training change, a new dependency):
  open an issue first so we can agree on the approach.

## Set up

You need Node.js 22.12 or newer (`.nvmrc`; 20.19+ and 24 also work, see
`engines` in `package.json`) and a desktop browser. A Meta Quest 3 is only
needed for mixed reality on a real headset; the dev server ships a headset
emulator (IWER).

```sh
npm install
npm run dev     # IWSDK dev server + a managed browser with the headset emulator
npm run lab     # the trainer engine on http://localhost:8790 (optional)
```

This is an IWSDK app and several things do not work like a plain Vite
project: `iwsdk.config.json` (not `vite.config.ts`) holds the scene and XR
settings, Three.js is imported from `@iwsdk/core`, and components live in
system-free modules. Read [AGENTS.md](AGENTS.md) before changing the app; it
is written for coding agents but is the best short guide for people too.

## Making a change

- Keep changes focused; one topic per pull request.
- Follow the existing patterns: ECS systems with queries, no allocations in
  `update()`, assets through the manifest (`src/assets.ts`), UI in UIKitML
  (`public/ui/`). Match the surrounding code style.
- Comments and docs: short, plain sentences.
- Keep development-only features behind `import.meta.env.DEV`.

## Check your change

Run these before opening a pull request:

```sh
npm run typecheck
npm run build
```

For changes the player can see, run the matching emulator checks against
the dev server started with
`npx @iwsdk/cli dev up --headed --open --allow-browser-automation`. The
README lists the individual checks; `bash tools/test/all.sh` runs all of them
(about 20 minutes). Say in the pull request what you ran, and whether you
tried it on a headset.

## Assets and licences

The code is licensed under the Apache License 2.0. Assets keep their own
licences, listed in [CREDITS.md](CREDITS.md).

- Only add assets you are allowed to redistribute: CC0, CC BY, MIT,
  Apache-2.0 or OFL, with the source and licence added to `CREDITS.md` (and to
  the in-app credit lines when they show in the game).
- No non-commercial or unlicensed assets. The Microduck meshes (CC BY-NC-SA
  4.0) are the one exception, and nothing should depend on them more than it
  does today.
- Never commit scenario packs (they contain a player's room scan), trained
  brains (`public/policies/incoming/`), recordings, `artifacts/`, dev-only
  models, tokens or keys. `.gitignore` covers the usual places; check
  `git status` before you commit.

Unless you say otherwise, a contribution you submit is licensed under the
Apache License 2.0, as section 5 of the licence describes.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests or checks where it makes sense.
3. Run the checks above.
4. Open a pull request that says what changed, why, and how you tested it.
   Add a screenshot or a short clip for visible changes.

Duck Lab XR is an independent fan project, not made or endorsed by Pollen
Robotics.
