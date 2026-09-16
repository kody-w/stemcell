# stemcell

**The RAPP brainstem, wherever you need it.** One genome (a `soul.md`, `agents/*_agent.py`, `SKILL.md` skills, memory keyed by `user_guid`), any body, the same wire. A stem cell is pluripotent: it becomes whatever tissue the organism needs and it keeps growing. So does this brainstem.

```
                          ┌──────────────── the genome ────────────────┐
                          │ soul.md · agents/*_agent.py · SKILL.md     │
                          └──────┬──────────┬──────────┬──────────┬────┘
                                 ▼          ▼          ▼          ▼
   body:                       http        sdk       headless    studio / directline
   what it is:            a running     Copilot SDK  a shared   a Copilot Studio harness agent
                          brainstem     in-process   runtime    (deployed from the same genome)
                                 │          │          │          │
                                 └──────────┴────┬─────┴──────────┘
                                                 ▼
                       POST /chat {user_input, session_id, user_guid} → {response, session_id, ...}
                       POST /chat/stream → {"type":"delta"|"agent"|"done"|"error"}   (the RAPP wire)
```

Built on [copilot-harness-sdk](https://github.com/kody-w/copilot-harness-sdk): it opens the harness underneath each body and normalizes the event stream; stemcell adds the genome, the RAPP wire on top, the Studio projection, the friend, and the growth loop.

## Bodies

| Spec | Body | What answers | Verified |
| --- | --- | --- | --- |
| `http://host:port` | `http` | a brainstem already running (the grail on :7071, the lab on :7081, a Tier 2 Azure Function, a LAN twin); the request and the frames pass through untouched | 4/4 proof turns on two live brainstems |
| `sdk` / `sdk:<genome dir>` | `sdk` | the Copilot SDK inside this process: `soul.md` is the system message (runtime mode `empty`, so none of your own Copilot CLI config leaks in), every `agent.py` is a custom tool whose `perform()` runs in python with the grail's import shims, skill folders load natively | 4/4 proof turns, agents executed, memory written and recalled |
| `headless:<host:port>[:<genome>]` | `headless` | the same, against a `copilot --headless --port N` runtime shared by many users | persona turn and an agent execution against `copilot --headless --port 4399` |
| `studio:<environmentId>/<schemaName>` | `studio` | a Copilot Studio GitHub Copilot harness agent over the Agentic Runtime `/3p` route with a delegated Entra token (public-client app holding `CopilotStudio.Copilots.Invoke`; MSAL cache file so only the first run signs in) | 4/4 proof turns on `rapp_Stemcell` deployed from the grail genome; Hacker News and memory ran on the friend (friend log shows the calls) |
| `directline:<environmentId>/<schemaName>` | `directline` | the same agent over no-auth agentic Direct Line (final-only answers; agent published with No Authentication) | not run in this session |

```bash
npm install -g github:kody-w/stemcell        # or clone + npm install; needs Node 20.19+/22.12+ and python3 for agents
stemcell genome                              # what the genome on disk contains (default: ~/.brainstem/src/rapp_brainstem)
stemcell chat sdk "Use the HackerNews agent: top 2 stories, one line each"
stemcell chat http://localhost:7071 "Who are you?"
stemcell chat studio:<envId>/<schema> "Use the hello-world skill to greet me"      # ENTRA_CLIENT_ID + ENTRA_TENANT_ID
stemcell serve sdk --port 7123               # the RAPP wire + the grail's own chat page, in front of any body
stemcell prove http://localhost:7071 sdk studio:<envId>/<schema> --out proofs/today.json   # same turns on every body
```

```js
import { shapeshift } from 'stemcell';
const b = await shapeshift('sdk');                                   // any body spec
const { response } = await b.chat({ user_input: 'hi', session_id: 'u1', user_guid: 'twin-1' });
for await (const f of b.stream({ user_input: 'hi' })) if (f.type === 'delta') process.stdout.write(f.text);
```

`serve` also answers the routes the grail's page calls on load (`/login/status`, `/models`, `/agents`, `/voice`, …) so `ui/index.html`, copied verbatim from the grail, works in front of a Studio agent or an in-process SDK exactly as it does in front of the grail. `/health` carries a random `instance` token: a host must never identify its child by port.

## Copilot Studio: project, phone a friend, grow

Copilot Studio cannot run `agent.py` and cannot write new agents. stemcell projects the genome onto a harness agent and gives it a **friend**: any brainstem that can.

```bash
# the friend: any RAPP-wire brainstem on a public URL (here: the grail behind stemcell serve + a Cloudflare quick tunnel)
stemcell serve http://localhost:7071 --port 7131 &
cloudflared tunnel --url http://127.0.0.1:7131 &        # prints https://<random>.trycloudflare.com

# project the genome onto Copilot Studio with the friend wired in (harness only, never classic; via copilot-harness-sdk's deploy script)
stemcell studio deploy --name "RAPP Stemcell" --schema rapp_Stemcell --environment https://<org>.crm.dynamics.com/ \
  --friend https://<random>.trycloudflare.com \
  --token-command "az account get-access-token --resource https://<org>.crm.dynamics.com/ --query accessToken -o tsv"
```

What lands in the agent:

| Genome | Studio component |
| --- | --- |
| `soul.md` + capability routing | `agentSettings.instructions` (+ greeting) |
| every `SKILL.md` | an `InlineAgentSkill`, the file verbatim |
| every `agent.py` | a capability card (`InlineAgentSkill`: contract + "run it through the friend"); with no friend, a reasoning-only skill carrying the code |
| the friend | **Phone a friend**: a `WorkflowTool` on a connectionless agent flow (`Request` → `Http POST <friend>/chat` → `Response`), the same shape copilot-harness-sdk proves with its weather flow, so no custom connector and no maker-portal connection is needed |

The instructions tell the agent: route every agent request through the friend, and **if the user asks for something no skill or agent can do, phone the friend with "Use LearnNew to create a new agent that …", then phone again with the original request.** The friend (a grail brainstem carries `LearnNew`) writes the new `agent.py` and answers with it on the second call.

### The growth loop

```bash
stemcell grow --friend http://localhost:7071 --friend-public https://<random>.trycloudflare.com \
  --name "RAPP Stemcell" --schema rapp_Stemcell --environment https://<org>.crm.dynamics.com/ --watch --every 30
```

Proof (16 Sep 2026, one environment, `rapp_Stemcell`, 10 components at first deploy): the Studio body was asked to convert 100 °C with "a dedicated unit-conversion agent you do not have yet". It phoned the friend twice (`LearnNew` wrote `unit_converter_agent.py` on the grail; the second call answered 212 °F). `stemcell grow` re-projected and redeployed: 11 components, `skill.unitconverter` present, flow updated in place; the grown body then answered 37 °C → 98.6 °F through the new agent (`proofs/studio-grown.json`). With `grow --watch` running, a second ask ("an agent that counts days until a date") produced `days_until_agent.py` on the friend; the watcher pulled it and redeployed on its own: 12 components, `skill.daysuntil` present. Nobody opened the portal. The quality of a learned agent is `LearnNew`'s business: the Studio body reported that the days-until agent echoed on its first run and handed the user the fix path.

`grow --watch` polls the friend's `/agents`. When a new agent appears there (because the Studio body asked the friend to learn it, or because anyone taught the friend directly), it pulls the file through `/agents/export/<file>` into the genome, re-projects, and redeploys the Studio agent through the same harness-only script (update in place; stale components removed). The capability the Studio body could not perform becomes one of its own components without anyone opening the portal. `grow --learn "converts Celsius to Fahrenheit"` runs one cycle and asks the friend to learn first; `--dry-run` skips the deploy.

## Self-growth: the Studio body grows without a friend

Copilot Studio cannot write agents, but a harness agent can author a capability and, through Dataverse, write it into its own bot record. `--self-grow` gives the agent three tools, all agent flows on the environment's existing Dataverse connection, nothing outside the tenant:

| Tool | What it does | Status |
| --- | --- | --- |
| **Grow a new skill** | List bots (its own schema name) → create a `botcomponents` row (`InlineAgentSkill`, componenttype 9) → `Microsoft.Dynamics.CRM.PvaPublish`, the same bound action `pac copilot publish` calls; refuses an exact duplicate name | proved, repeatedly |
| **Fetch a URL** | connectionless HTTP GET or POST to any public URL, body returned as text (capped) | proved |
| **Grow a new tool** | create a `workflows` row from a definition the agent wrote, activate it, add a `WorkflowTool`, link them, publish | experimental: the platform refuses to activate a flow the Dataverse connector created (`DefinitionRequestMissingFields`), so the instructions steer the agent to the skill route below |

The instructions say: when the user needs a capability none of your skills cover, and you can carry it out yourself (reasoning, or a script in your sandbox), author the skill, grow it, follow it now. **When it needs an outside source, the way the genome's HackerNews agent does: Fetch the source URL to see the real response, then grow a skill that names the URL, the fields, the sorting and the answer format. That skill plus Fetch a URL is the new agent.**

```bash
stemcell studio deploy --name "RAPP Stemcell" --schema rapp_Stemcell --environment https://<org>.crm.dynamics.com/ --self-grow [--friend <url>] [--flow-generation N]
stemcell solution deploy --workspace .stemcell/rapp_Stemcell/workspace --environment https://<org>.crm.dynamics.com/    # the same, with pac only (no az, no Web API)
stemcell harvest --schema rapp_Stemcell --environment https://<org>.crm.dynamics.com/      # grown skills → <genome>/agents/<name>/SKILL.md
```

Proof (16 Sep 2026, `rapp_Stemcell`):

- Asked for an ISO week number "with a skill you don't have yet": `skill.iso-week-number` appeared in the bot record 4 s later, `publishedon` moved 40 s after that, the answer (2027-01-01 is 2026-W53) was right. Asked whether 2100 is a leap year: `leap-year-checker` grown and followed in the same turn; a fresh conversation a minute later loaded it natively.
- **A new news agent for another source, no friend, no function:** "be able to give me Lobsters top stories the same way you do Hacker News". The agent called Fetch a URL on `lobste.rs/hottest.json`, grew `skill.lobsters` (row in its own bot record at 16:07), answered with live data. A fresh conversation later: `Loading skill: lobsters` → `Calling FetchaURL` → the top 2 with scores that had moved since. `proofs/` holds the transcripts.
- `stemcell harvest` wrote `iso-week-number/SKILL.md` into the grail genome and the in-process `sdk` body listed and used it. One genome; the body taught it.

Things to know: a republish reaches new conversations after one to two minutes, and the harness can keep calling the previous generation of a flow until then. A solution import never re-activates a flow that an earlier failed activation left in draft, so `--flow-generation N` gives every growth flow a fresh id and name; `solution deploy` reports `draftFlows` when that is needed. Every deploy keeps components the body grew on its own. Semantic duplicates (two skills for one purpose under different names) are the model's judgment; the flow refuses only exact names.

## Load the learning brainstem into any environment

`solutions/RAPPLearningBrainstem_unmanaged.zip` (built by `stemcell solution build`, version 2.0) is the friendless learning brainstem: the `rapp_LearningBrainstem` harness agent (`cliagent-1.0.0`), its instructions with the self-growth rules, the three growth tools (Grow a new skill, Fetch a URL, Grow a new tool) with their agent flows, the Dataverse connection reference `rapp_LearningBrainstem.cr.shared_commondataserviceforapps`, the genome's capability cards and the `iso-week-number` skill a body grew earlier.

1. Import it: maker portal → Solutions → Import, or `pac solution import --environment https://<org>.crm.dynamics.com/ --path solutions/RAPPLearningBrainstem_unmanaged.zip --publish-changes`.
2. Bind the connection reference to a Dataverse connection of the importing user (the portal's import wizard asks; with pac, pass `--settings-file` mapping `rapp_Stemcell.cr.shared_commondataserviceforapps` to a connection id from `pac connection list`). That connection is what lets the agent write its own skills and republish itself.
3. Open the agent in Copilot Studio, Preview it, and ask for something it cannot do yet but can work out itself (a conversion, a date calculation, a checklist). Watch the component list grow.

Verified 16 Sep 2026: imported into a second environment with none of this in it (`stemcell solution deploy`, pac only): the bot, 15 components, three activated flows and the connection reference landed, `draftFlows: []`; the reference was unbound because that environment had no Dataverse connection yet (step 2).

## Proofs

`proofs/turns.json` is the parity script: the same four turns (persona, agent execution, memory write, memory recall) on every body, regex asserts on every answer, one JSON record per run (`proofs/*.json`). A body is "there" when it passes the same turns as the grail.

## Tests

```bash
npm test      # 12 offline tests: spec parsing, genome + python contracts, agent execution with shims, http body, serve, prove, SDK-event mapping, Studio projection with bridge, friend and self-growth, harvest
```

## What this is not

Not the grail: `kody-w/rapp-installer` is untouched; stemcell reads its installed genome. Not a new kernel: the `sdk` body is the Copilot SDK with the genome on top. Not a portal: every deploy goes through copilot-harness-sdk's deploy script, which refuses anything that is not the GitHub Copilot harness; self-growth goes through the agent's own flow and Dataverse.

MIT.
