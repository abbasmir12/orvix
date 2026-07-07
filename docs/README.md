# Orvix Documentation

## Core concepts

| Doc | What's in it |
| --- | --- |
| [`orvix-map/`](orvix-map/) | The shared build contract every agent/reviewer/gate reads from: structure, draft/review/lock lifecycle |
| [`orvix-book/`](orvix-book/) | The shared ledger: entry types, signal routing, what each agent actually sees per turn |
| [`planning/`](planning/) | The 7-stage planning pipeline that produces the map and org chart |
| [`collaboration/`](collaboration/) | How agents negotiate: dependencies, file ownership, merge conflicts, revision cycles, the wake-up pass |
| [`owner-channel/`](owner-channel/) | How a human steers a mission mid-flight, traced end to end to the scheduler code that picks it up |

## Running it

| Doc | What's in it |
| --- | --- |
| [`architecture/`](architecture/) | System diagram, module map, mission lifecycle sequence, design principles |
| [`SETUP.md`](SETUP.md) | Local setup, and deploying the API to an Alibaba Cloud ECS instance (repo fetch, npm build, `ORVIX_API_TOKEN`, connecting the CLI) |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Proof of the live Alibaba Cloud deployment: exact code that calls Alibaba Cloud Model Studio, the health-check evidence, how the CLI connects to it |
| [`env-reference/`](env-reference/) | Every environment variable, what it defaults to, when to touch it |
| [`cli/`](cli/) | CLI flags, the SetupWizard, cockpit keybindings, the prompt bar / owner channel, slow-connection settings |
| [`architecture/diagrams/architecture.mmd`](architecture/diagrams/architecture.mmd) / `.png` | The architecture diagram source and rendered image |

Start with `SETUP.md` if you're trying to run this. Start with `architecture/` for the
system shape, then the core-concepts docs above for how the pieces actually coordinate.
