---
"pi-permission-ai-guard": minor
---

**The screen recognizes seven more shells.** `fish`, `mksh`, `yash`, `ash`, `pdksh`, `csh`, and `tcsh` run `-c` strings and heredoc/stdin input as programs, so the closed deny rules now read those places under the new names exactly as they already did under `sh`/`bash`/`zsh`/`dash`/`ksh`. The C-shells are a different grammar, but the deny rules match literal words (`rm -rf /`, `dd of=`) that spell the same there, so a misparse over-blocks rather than under-blocks: `fish -c 'rm -rf /'` and `curl … | fish` are denied where before they passed to the model. The two shell-name lists (screen and fact walker) are one shared set, so they cannot disagree about what runs. Deliberately still outside the screen, pinned by tests: `busybox -c` (applet dispatch, not a shell), `pwsh` (PowerShell, which the shell reader cannot parse), and non-shell `-c` carriers (`python3`, `git`, package managers).
