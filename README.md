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
| `headless:<host:port>[:<genome>]` | `headless` | the same, against a `copilot --headless --port N` runtime shared by many users | see below |
| `studio:<environmentId>/<schemaName>` | `studio` | a Copilot Studio GitHub Copilot harness agent over the Agentic Runtime `/3p` route with a delegated Entra token (public-client app holding `CopilotStudio.Copilots.Invoke`; MSAL cache file so only the first run signs in) | live turn through a deployed agent, skill invoked |
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

`grow --watch` polls the friend's `/agents`. When a new agent appears there (because the Studio body asked the friend to learn it, or because anyone taught the friend directly), it pulls the file through `/agents/export/<file>` into the genome, re-projects, and redeploys the Studio agent through the same harness-only script (update in place; stale components removed). The capability the Studio body could not perform becomes one of its own components without anyone opening the portal. `grow --learn "converts Celsius to Fahrenheit"` runs one cycle and asks the friend to learn first; `--dry-run` skips the deploy.

## Proofs

`proofs/turns.json` is the parity script: the same four turns (persona, agent execution, memory write, memory recall) on every body, regex asserts on every answer, one JSON record per run (`proofs/*.json`). A body is "there" when it passes the same turns as the grail.

## Tests

```bash
npm test      # 9 offline tests: spec parsing, genome + python contracts, agent execution with shims, http body, serve, prove, SDK-event mapping, Studio projection with bridge and with friend
```

## What this is not

Not the grail: `kody-w/rapp-installer` is untouched; stemcell reads its installed genome. Not a new kernel: the `sdk` body is the Copilot SDK with the genome on top. Not a portal: every Studio change goes through copilot-harness-sdk's deploy script, which refuses anything that is not the GitHub Copilot harness.

MIT.
