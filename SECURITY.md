# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues. Use GitHub's
private vulnerability reporting instead (the **Security** tab of this
repository, then **Report a vulnerability**), or email dev@bruna.world.
Include what is affected, how to reproduce it, and what an attacker could do
with it.

You should hear back within a week. Once a fix is ready we will credit you in
the release notes, unless you prefer not to be named.

## Supported versions

Duck Lab XR has no releases yet: fixes go to the `main` branch.

## How the pieces are meant to be exposed

- **The game** is a static website. Physics and the duck's brains run in the
  player's browser.
- **The trainer engine** (`npm run lab`, `tools/lab/server.mjs`) runs on the
  player's own computer. It listens on 127.0.0.1 only, accepts only localhost
  `Host` headers, and answers only its own page and the Duck Lab XR site's
  origins.
- **Pairing** goes through a small rendezvous (`tools/link/rendezvous-server.mjs`)
  that only passes a WebRTC offer and answer between a headset and a trainer
  page on the same network; everything else flows directly between the two
  devices.
- **Tokens:** no token is stored in the code. The game keeps a player's
  Hugging Face token in the tab's session storage only; the trainer sends a
  write token to the Hub once per publish and does not save it.
- **Development-only features** (the dev server's upload and telemetry
  routes, test hooks, URL flags) are behind `import.meta.env.DEV` and are not
  part of a production build.

Reports about any of these, or about scenario packs (which contain a scan of
the player's room) leaking anywhere, are especially welcome.

Duck Lab XR is developed by Bruna Worlds (BRUNA GOODS LLC).
