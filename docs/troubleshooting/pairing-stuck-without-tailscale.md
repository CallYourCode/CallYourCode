# Pairing stuck after `cyc pair` (Local mode, no Tailscale)

## Symptom

`cyc pair` → **Local** opens `http://localhost:10100/?engine=…#pair=…`, and the
app sits on the pairing / connecting screen forever. It never reaches the chat.

`cyc doctor` passes and every service is running, so nothing looks broken.

## How to recognise it

Look at the logs in `~/.callyourcode/logs/`:

```sh
grep -c rtc.dc.open   ~/.callyourcode/logs/app.log   # 0 = never connected
grep rtc.dial.fail    ~/.callyourcode/logs/app.log | tail -3
```

```
app rtc.dial.fail ... reason=timeout pc=new ice=new opened=false
app rtc.failed ... how=relay err=timeout why="the DataChannel dial failed; ..."
```

`engine.log` shows that pairing **auth succeeds**. The failure comes after it:

```
engine relay.auth ok=true reason=pairing
engine relay.offer c=rc…
[rtc] remote-set id=…
[rtc] pc-state=connecting        <- never reaches "connected"
```

`turn.log` only ever shows `turn listening … ext=` (empty `ext`) and never
records an allocation.

Check what the installer wrote:

```sh
grep -v SECRET ~/.callyourcode/turn.env
# TURN_HOST=<Your-Mac>.local
# TURN_EXTERNAL_IP=
```

If `TURN_HOST` is a `.local` name and `TURN_EXTERNAL_IP` is empty, this is
your problem.

## Root cause

The install assumes Tailscale. `scripts/install.sh` sets:

- `TURN_HOST` to the tailnet MagicDNS name (`tailscale status --json`), and if
  that is missing, falls back to `hostname`
- `TURN_EXTERNAL_IP` to `tailscale ip -4`, and if that is missing, leaves it empty

Without Tailscale, `TURN_HOST` becomes `<Your-Mac>.local`. On macOS that mDNS
name can resolve **only to IPv6** (`::1`, `fe80::…`):

```sh
dscacheutil -q host -a name "$(scutil --get LocalHostName).local"
```

The bundled TURN server listens on IPv4 only (`0.0.0.0:3478`). As a result:

1. The browser and the engine both get `stun:/turn:<mac>.local:3478` and can't
   reach it, so neither side gets any srflx or relay candidates.
2. Chrome hides its host candidates behind random mDNS names, which the engine
   can't use. The engine's loopback host candidate doesn't help the browser.
3. ICE has no working candidate pair, the 10 s DataChannel dial times out, and
   the app retries forever. It looks like it is "stuck at pairing".

The WebRTC code is fine. `bun test src/transport/relaylink.test.ts` in
`engine/agent-engine` passes. Only the ICE server address is wrong.

## Fix (Local mode: the browser runs on the same machine as the engine)

In Local mode the app server only listens on `127.0.0.1:10100`, so the
browser is on this machine. Point TURN at loopback. That address stays the
same when your Wi-Fi or DHCP address changes.

1. Back up the files:

   ```sh
   mkdir -p ~/cyc-backup
   cp ~/.callyourcode/turn.env ~/Library/LaunchAgents/com.callyourcode.*.plist ~/cyc-backup/
   ```

2. Edit `turn.env`:

   ```sh
   sed -i '' -e 's/^TURN_HOST=.*/TURN_HOST=127.0.0.1/' \
             -e 's/^TURN_EXTERNAL_IP=.*/TURN_EXTERNAL_IP=127.0.0.1/' \
             ~/.callyourcode/turn.env
   ```

3. Edit the launchd plists. The installer also bakes `TURN_HOST` into them:

   ```sh
   for s in agent-engine app-server turn; do
     plutil -replace EnvironmentVariables.TURN_HOST -string 127.0.0.1 \
       ~/Library/LaunchAgents/com.callyourcode.$s.plist
   done
   plutil -replace EnvironmentVariables.TURN_EXTERNAL_IP -string 127.0.0.1 \
     ~/Library/LaunchAgents/com.callyourcode.turn.plist
   ```

4. Reload the services. `cyc start` only runs `launchctl kickstart`, and that
   fails once `cyc stop` has booted the services out. Reload them explicitly:

   ```sh
   for s in turn voice-engine app-server agent-engine; do
     launchctl bootout   gui/$(id -u)/com.callyourcode.$s 2>/dev/null
     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.callyourcode.$s.plist
   done
   ```

5. Verify:

   ```sh
   tail -2 ~/.callyourcode/logs/turn.log     # ... ext=127.0.0.1
   cyc doctor                                # all PASS
   grep rtc.dc.open ~/.callyourcode/logs/app.log | tail -1
   ```

   Any open app tab retries on its own and should log:

   ```
   rtc.ice state=connected
   rtc.dc.open pc=connected ice=connected
   ```

   If the tab is still spinning, refresh it or run `cyc pair` again.

### Using a phone on the same Wi-Fi instead

Loopback only works for a browser on this machine. A phone also needs the app
server reachable from the LAN (`APP_HOST`). Once it is, set `TURN_HOST` and
`TURN_EXTERNAL_IP` to the machine's LAN IPv4 (`ipconfig getifaddr en0`)
instead of `127.0.0.1`, then repeat steps 3–5. You'll have to redo this if
DHCP gives the machine a new address. Tailscale is the more robust option.

## Caveats

- **Re-running `cyc install` undoes this fix.** Without Tailscale, it rewrites
  `turn.env` and the plists back to `<mac>.local`. Repeat the fix after every
  reinstall.
- **`cyc stop` followed by `cyc start` fails** with
  `FAILED: launchctl kickstart -k gui/<uid>/com.callyourcode.turn`. Use the
  `launchctl bootstrap` loop from step 4 instead.

## Possible permanent fixes (for maintainers)

- `install.sh`: when Tailscale is absent, fall back to an IPv4 address
  (`127.0.0.1` for Local-only installs, or the primary LAN IPv4) instead of
  `hostname`. At minimum, don't use a `.local` name that may resolve IPv6-only.
- TURN server: also listen on `::` (IPv6), or resolve `TURN_HOST` to IPv4
  before handing it to clients.
- `cyc doctor`: warn when `TURN_HOST` doesn't resolve to an address the TURN
  server listens on, or when `turn.log` has never recorded an allocation.
- `cyc start`: `launchctl bootstrap` services that aren't loaded, not only
  `kickstart` them.
