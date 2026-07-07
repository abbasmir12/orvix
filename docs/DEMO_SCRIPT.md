# Demo Script — 2:30–2:50

**Format:** record raw footage first (terminal + browser), then cut/speed-ramp the waiting
parts in editing and voice over the final edit. Don't attempt one live real-time take — actual
Qwen calls take real seconds-to-minutes per agent turn and won't fit a 3-minute video without
dead air.

This cut walks the runtime-choice screen, the planning screen, and the execution cockpit's
panels, and names the Orvix Map and Orvix Book on camera in plain language — because those are
the things that make this an "agent society" instead of a chatbot with extra steps. To fit
that in 2:30–2:50, narration is fast and tight throughout — there's no slack beat to cut for
time except the ones flagged at the bottom.

## Before you record

- [ ] Confirm the Alibaba Cloud ECS instance is up: `curl http://<ecs-ip>:8787/health` returns
      `"provider": "Alibaba Cloud ready"` and `"qwen": "configured"`.
- [ ] Maximize/settle the terminal window *before* hitting record — don't resize on camera.
- [ ] Pre-clear `~/.orvix/cli.json`'s remembered connection once, then do one real "first
      connect" take so the SetupWizard's live health-check is genuinely proving the connection
      on camera, not replaying a cached success.
- [ ] Run the weather-dashboard mission once, start to finish, off-camera first. Note
      timestamps of: the three-card runtime screen, the planning rail's stages ticking over,
      the Agent Network panel filling in, a live tool-call in the turns feed, a Book entry, a
      PR flipping to Approved, the finished app. Editing is just assembling those clips in
      order.
- [ ] Have the finished weather app already built and ready to open in a browser tab.
- [ ] Rehearse the owner-channel beat as a second short run — this is the best differentiator
      to show judges, don't cut it for time.

## The script

### 0:00–0:16 — Hook: the actual concept (16s)

> "Orvix isn't one model answering one prompt. Give it a mission, and it builds a team of AI
> agents just for that job — then those agents build in parallel, talk to each other, get
> reviewed, and ship working code. Nobody wrote them a task list, and the team didn't exist
> until this mission asked for it."

**On screen:** Orvix logo / cockpit idle, or a quick title card.

### 0:16–0:40 — Where it runs: local or the cloud (24s)

> "First choice: where does it run? You can run Orvix entirely on your own laptop — nothing
> leaves your machine. Or you point it at a server running anywhere, like this one on Alibaba
> Cloud, so anyone on your team can use the same running instance over the internet. I'll
> connect to the Alibaba Cloud one."

**On screen:** the setup screen with its three cards — Demo, Local runtime, Alibaba Cloud
runtime. Highlight each briefly, land on "Alibaba Cloud runtime," paste/confirm the ECS URL,
health check passes live. Keep this moving — it should feel like one smooth motion, not three
separate pauses.

### 0:40–0:52 — Give it the mission (12s)

> "I'll ask for a weather dashboard — search, favorites, loading and error states, responsive
> design, wired to the OpenWeather API. That's the entire spec."

**On screen:** type the mission, hit enter, cut straight to the planning screen appearing.

### 0:52–1:10 — The planning screen (18s)

> "This is planning — no code yet. One AI, MasterMind, is reading the mission and writing the
> Orvix Map: a simple plan listing every screen, every file, and every check the finished app
> has to pass. Then a second AI reads that plan and decides how many specialist agents this
> job actually needs, and what each one will own."

**On screen:** the planning console's stage rail ticking through its stages, sped up 2–3x. If
the UI shows the map or the team being decided, hold on that a beat at normal speed.

### 1:10–1:23 — Naming the Book, in plain words (13s)

> "And those agents don't dump everything into one shared chat. They keep a shared notebook —
> the Orvix Book — where they ask each other questions and post updates, out in the open, so
> nobody's working blind."

**On screen:** cut to the `book` activity tab, one real entry visible (a question or an
update).

### 1:23–2:00 — The execution cockpit (37s)

> "Now they're actually building. This is the team — the Agent Network panel — each agent on
> its own branch, working at the same time, not taking turns. This Focus panel shows whatever
> agent I click on: what it's doing, right now. And this feed underneath is real — files being
> read and written, code being committed — not an animation."
>
> "Before anything gets merged, a second AI reviews it against that same plan from earlier."

**On screen:** cockpit left rail + Agent Network panel (roster with roles/status), cut to
Focus panel on a selected agent, cut to the live turns feed (`read_file`/`write_file`/
`commit_changes`), cut to a PR flipping "Changes requested" → "Approved". This is the longest
beat — keep real tool-call and review moments at normal speed, speed-ramp everything else.

### 2:00–2:16 — It actually builds and runs (16s)

> "Once every piece is merged, Orvix builds the real project, tests it, and only calls the
> mission done once a final AI check confirms it actually matches what was asked for."

**On screen:** cut to the finished weather dashboard in a browser — search a city, show the
result, add a favorite.

### 2:16–2:38 — It's not done when it's done (22s)

> "It's never really finished, either. I'll just ask for a dark mode."

**On screen:** type a plain instruction into the CLI prompt bar.

> "MasterMind sends that to whichever agent owns it — and if nobody on the team can do it,
> MasterMind hires a brand new agent, right in the middle of the mission, just for that one
> request."

**On screen:** cut to the routed/reopened PR, or — if you have a take of it — a freshly hired
agent appearing in the Agent Network panel mid-mission. Cut to the app in dark mode.

### 2:38–2:48 — Close (10s)

> "There's more we can't fit in three minutes — how agents avoid stepping on each other's
> files, how a stuck agent always gets rescued. It's all written up in the repo's docs folder.
> Orvix: built on Qwen and Alibaba Cloud."

**On screen:** quick flash of `docs/architecture/diagrams/architecture.png`, then a flash of
the `docs/` folder listing, then the GitHub repo URL as an end card.

## Timing math

16 + 24 + 12 + 18 + 13 + 37 + 16 + 22 + 10 = **168s (2:48)**. Deliver at a brisk, confident
pace (this is a hype reel, not a lecture); if it still runs long, cut in this order:

1. Shorten the close to: *"Full docs are in the repo. Orvix, built on Qwen and Alibaba
   Cloud."* (saves ~5s)
2. Trim the runtime-choice beat to: *"Orvix can run on your own laptop, or on a server anyone
   can reach — like this one, on Alibaba Cloud. I'll connect to that."* (saves ~6s)
3. Cut the Book beat down to one clause folded into the planning beat: *"...and they'll
   coordinate through a shared notebook, not one shared chat."* (saves ~8s) — do this only if
   you must; naming the Book on its own is what makes the coordination idea register instead
   of flying past.

Do not cut: the runtime-choice beat, the planning-screen beat, the Agent Network/Focus panel
beat, or the owner-channel beat. Those four are what separate this from a single-model demo.
