# Future verification checklist — persistence & directory-access behavior

Behavioral checks that need a **real sandbox host** (macOS/Seatbelt or Linux/bubblewrap)
and a **normal, non-root user**. They ground-truth the claims in
[../docs/directory-access.md](../docs/directory-access.md) — especially the
"persistence by command, not path" limit — by actually attempting the escape and
observing whether the payload ran, not by trusting an exit code.

**Setup for every check below:** `./escape-clause.sh install`, then
`ESCAPE_CLAUSE_PROFILE=<profile> ./escape-clause.sh init <ws>` and drive the probe with a
real launch (or `claude -p` from the stamped workspace, no `--settings`, as the audit's
Parts C/D do). Ground truth = did a marker file appear / did a process spawn *outside*
the sandbox — never the agent's self-report.

---

## Status from the session that wrote this (2026-07-09, Linux container, root)

Could **not** run any behavioral check here:

- ❌ Sandbox won't initialize — `bwrap` and `socat` absent, so `failIfUnavailable:true`
  refuses to start (confirmed: `sandbox required but unavailable`). Parts A, C, D, E–G
  of `sandbox-audit.mjs` are all un-runnable.
- ❌ No user D-Bus socket (`/run/user/0/bus` absent) and no `crontab`/`at` binaries — the
  persistence mechanisms themselves aren't installed.
- ❌ Running as **root** (uid 0) — invalidates the non-root fencing assumption; every
  check must be re-run as an unprivileged user regardless.

Did run here (no sandbox needed), passing:

- ✅ `node tests/guard-test.mjs` — 41 guard decision tests (floor, profiles,
  symlink/`..` laundering, fail-closed).
- ✅ Config-drift stamping (audit Part B logic) — profiles/deny-lists produce the
  expected `settings.json` + `escape-clause-policy.json`.

So **everything below is unverified behaviorally** and is the whole point of this list.

---

## A. Linux (bubblewrap) — needs a normal-user desktop/session box

Prereqs: `apt install bubblewrap socat`, a logged-in user session with
`/run/user/$UID/bus` present, `systemd --user` running, signed-in `claude`.

### A1. File-backed persistence should FAIL (sandbox write rules cover it)
- [ ] `crontab -` / write to `/var/spool/cron/crontabs/$USER` from sandboxed bash → **denied**.
      Confirm the *mechanism* is blocked (spool file unchanged), not merely that the
      setuid `crontab` helper is missing. Verify the `no_new_privs` story: the helper
      execs but has no elevated privilege, so the spool write is a plain out-of-workspace
      write and is denied.
- [ ] `at now + 1 minute` → **denied** the same way (`/var/spool/at` unchanged).

### A2. IPC-based persistence — THE GAP (does the session bus reach into bwrap?)
- [ ] Is `/run/user/$UID/bus` mapped into the sandbox namespace at all? Probe from
      sandboxed bash: `test -S /run/user/$UID/bus && echo REACHABLE`.
- [ ] `systemctl --user` with a unit whose `ExecStart` runs a **workspace** script that
      touches a marker outside the workspace. Start it, wait, check the marker.
      **Expected-safe** = the D-Bus call is refused OR the unit can't be written to a
      readable path; **finding** = marker appears (unsandboxed exec via the outside daemon).
- [ ] `systemd-run --user --on-active=5s <payload>` — same ground truth.
- [ ] `dbus-send`/`busctl --user` direct to `org.freedesktop.systemd1` — does the raw
      IPC path reach the daemon even if `systemctl` is absent?

### A3. Guard write-floor (file tools, unsandboxed) — behavioral
- [ ] `Write` tool → `~/.config/autostart/x.desktop` → **denied** by guard.
- [ ] `Write` tool → `~/.config/systemd/user/x.service`, `~/.bashrc`, `~/.zshrc`,
      `~/.local/bin/git`, `~/.gitconfig`, `~/.claude/settings.json` → **denied**.
- [ ] Confirm **reads** of `~/.bashrc` still succeed under `default` (write-only floor).

### A4. Profiles — behavioral (both layers)
- [ ] Workspace under `~`, `strict`: sandboxed bash can read+write the workspace
      (`allowRead:"."` carve-out works) but a **sibling** dir under `~` is unreadable.
- [ ] Same under `strict` for file tools (guard `readScope:home`).
- [ ] `ESCAPE_CLAUSE_ALLOW_READ=~/shared`: bash + file tools can read it, but it can't
      re-expose `~/.ssh` (init already refuses that at stamp time — reconfirm behaviorally).
- [ ] `paranoid`: file tools can't read `/etc/hosts`; **bash can** (we deliberately keep
      `/etc` readable for bash — TLS bundles, `passwd`). Document the asymmetry holds.

## B. macOS (Seatbelt) — needs a real Mac, normal user

Prereqs: signed-in `claude`, a normal (non-admin-is-fine, non-root) login session.

### B1. The boot-persistence question from the original request
- [ ] `Write` tool → `~/Library/LaunchAgents/com.x.plist` → **denied** by guard floor.
- [ ] `Write` tool → `~/Library/LaunchDaemons/…`, `~/.zshrc`, `~/.bash_profile`,
      `/usr/local/bin/git`, `/opt/homebrew/bin/git`, `~/.claude` → **denied**.
- [ ] Sandboxed **bash** write to `~/Library/LaunchAgents/` → **denied** (workspace-only
      default). Ground-truth a would-be login item never lands.
- [ ] After a *simulated* login (`launchctl load`/manual), confirm no stray agent — i.e.
      nothing got dropped.

### B2. IPC-based persistence — THE GAP (Seatbelt mach-lookup)
- [ ] `launchctl bootstrap gui/$UID <workspace>.plist` (plist legally in the writable
      workspace, `ProgramArguments` → a workspace script writing an outside marker).
      Does the Mach-port request to `launchd` succeed from inside Seatbelt? Ground truth =
      marker file. **Expected-safe** = `mach-lookup` denied; **finding** = it ran.
- [ ] `launchctl load`/`launchctl submit` variants — same probe.
- [ ] Confirm the reboot nuance from the docs: a workspace-plist `bootstrap` does **not**
      survive reboot on its own (only the blocked `~/Library/LaunchAgents` drop does), but
      one successful call = immediate unsandboxed exec.

### B3. File-backed persistence should FAIL (Seatbelt inherited across exec)
- [ ] `crontab -` → **denied**: Seatbelt profile is inherited across `exec` including
      setuid, so the helper's `/var/at/tabs` (or `/usr/lib/cron/tabs`) write is denied.
- [ ] `at` (if enabled) — same.

### B4. Profiles on macOS
- [ ] `strict` hides `~/Library` (Mail, Messages, Safari, Keychains) from bash **and**
      file tools while a workspace under `~` still works.
- [ ] `paranoid` additionally hides `/Volumes` (external disks) from bash.
- [ ] `ESCAPE_CLAUSE_DENY_READ=~/Library/Keychains` behaviorally blocks both layers.

## C. Cross-cutting / to fold back into the repo
- [ ] Turn the passing checks into automated probes in `sandbox-audit.mjs` (a new
      "Part H: persistence vectors" that skips cleanly when the OS/session can't run them),
      so regressions are caught on `claude`/SDK upgrades.
- [ ] If any IPC gap (A2/B2) is confirmed exploitable, decide the fix: a command-side
      guard (deny `launchctl`/`systemctl`/`crontab`/`at`/`systemd-run`/`dbus-send`/`busctl`
      argv in a PreToolUse Bash matcher) vs. relying on the OS sandbox's IPC policy, and
      document the outcome in `directory-access.md` (replacing the current "untested gap"
      caveat with a verified statement).
- [ ] Re-run everything as a **non-root** user; note anywhere root-vs-user changes a result.
