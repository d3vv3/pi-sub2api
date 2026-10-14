# pi-sub2api

[![npm](https://img.shields.io/npm/v/pi-sub2api?style=flat-square)](https://www.npmjs.com/package/pi-sub2api)
[![node](https://img.shields.io/node/v/pi-sub2api?style=flat-square)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/pi-sub2api?style=flat-square)](LICENSE)

**Use a [sub2api](https://github.com/Wei-Shaw/sub2api) gateway from the [Pi coding agent](https://pi.dev).**

sub2api puts one API key in front of several upstream accounts. This extension makes that
gateway look like a normal pi provider: it reads the model list at startup and registers
every chat-capable model, so `--model sub2api/...` just works and `/models` lists them.

Two things it does that a plain base-URL override cannot. It picks the wire protocol per
model, because sub2api dispatches on the *key's* platform rather than the request path and
the wrong choice costs a translation hop — see [Protocol](#protocol). And it adds
`/usage`, which reports the gateway's own accounting rather than a token estimate, since
`/v1/models` returns no pricing for pi to estimate from.

## Table of Contents

- [Install](#install)
- [Configure](#configure)
- [Protocol](#protocol)
- [Use](#use)
- [Notes](#notes)
- [Development](#development)
- [License](#license)

## Install

```bash
pi install npm:pi-sub2api
```

Or try it for a single run without installing:

```bash
pi -e npm:pi-sub2api
```

## Configure

All configuration lives in `~/.pi/agent/auth.json` under the provider name `sub2api`. No shell
environment variables are needed.

```json
{
  "sub2api": {
    "type": "api_key",
    "key": "sk-...",
    "env": { "SUB2API_BASE_URL": "https://your-sub2api-host" }
  }
}
```

```bash
chmod 600 ~/.pi/agent/auth.json
```

- `key` — an API key generated in the sub2api dashboard.
- `env.SUB2API_BASE_URL` — the gateway base URL, **without** a trailing `/v1`. Defaults to
  `http://localhost:8080`.
- `env.SUB2API_PROTOCOL` — optional, and normally left out. Pins every model to one wire protocol
  instead of letting the extension choose. See [Protocol](#protocol).

pi resolves the key from `auth.json["sub2api"]` for inference; the extension reads the same entry
for its own `/v1/models` and `/v1/usage` calls. `SUB2API_KEY` / `SUB2API_BASE_URL` /
`SUB2API_PROTOCOL` environment variables are used as a fallback if the `auth.json` entry is
absent.

## Protocol

sub2api dispatches on the platform of the API key's group, not on the request path. An
Anthropic-account key serves `/v1/messages` natively and translates `/v1/chat/completions` down to
it; an OpenAI-account key does the reverse. The non-native path costs a translation hop.

**You do not have to configure this.** Left alone, the extension reads each model id and registers
it on the protocol native to it:

| Model id | pi `api` | Endpoint |
| --- | --- | --- |
| `claude-*` | `anthropic-messages` | `POST {BASE}/v1/messages` |
| everything else | `openai-completions` | `POST {BASE}/v1/chat/completions` |

A model list of only Claude ids therefore ends up entirely on the Anthropic protocol, a list of
only GPT ids entirely on the OpenAI one, and a mixed list split between them — one provider, two
protocols. This is the `auto` behaviour, and it is what you get when `SUB2API_PROTOCOL` is unset.

Set it only to overrule that guess. Values are pi's own api names, since that is what they become:

| `SUB2API_PROTOCOL` | Effect |
| --- | --- |
| unset, or `auto` | per model, per the table above |
| `anthropic-messages` | every model on `POST {BASE}/v1/messages` |
| `openai-completions` | every model on `POST {BASE}/v1/chat/completions` |
| `openai-responses` | every model on `POST {BASE}/v1/responses` |

Forcing changes only the endpoint and payload format — per-model context and output limits still
follow the model.

### openai-responses

On an OpenAI group the gateway's own upstream is the Responses API — `DeriveUpstreamEndpoint`
sends every OpenAI request to `/v1/responses` regardless of how it arrived. So the default
`openai-completions` is itself a conversion: the reply comes back with a `resp_…` id and
`"object": "chat.completion.chunk"`, having been translated down from a Responses stream.

Going in as `openai-responses` skips that, and buys one thing the chat path cannot give:

| | `openai-completions` | `openai-responses` |
| --- | --- | --- |
| Thinking shown | yes, via `reasoning_content` | yes, via reasoning items |
| Reasoning replayed next turn | no | yes — `reasoning.encrypted_content` |

pi stores each reasoning item and feeds it back on the following turn, so a GPT-5 model keeps its
reasoning chain across a tool loop instead of restarting it every time.

It is opt-in rather than the default because an API-key account whose upstream lacks the Responses
API is served on the raw chat path instead (`resolveOpenAIUpstreamEndpoint`), and that setup has
not been tested here. To use it:

```json
"env": {
  "SUB2API_BASE_URL": "https://your-sub2api-host",
  "SUB2API_PROTOCOL": "openai-responses"
}
```

### When to force it

The default rule infers the backend platform from the model name, so forcing is for the cases
where the name does not match the backend.

**Force `anthropic-messages`** when an Anthropic group publishes model ids without `claude` in
them — aliases like `sonnet-latest` or `my-coding-model`. Nothing fails: the request goes to
`/v1/chat/completions` and the gateway translates it back to Anthropic format. But the hop is
wasted, and it is the lossier direction — thinking blocks and cache control survive the native
path better.

**Force `openai-completions`** when the reverse happens. Each side has a group flag that closes
its non-native path outright:

- `claude_code_only` — rejects `/v1/chat/completions` with a 403. Harmless here: such a group is
  Anthropic-platform and serves Claude ids, which already go to `/v1/messages`.
- `allow_messages_dispatch` — an OpenAI group rejects `/v1/messages` unless this is on, and **it
  defaults to off**.

Only the second one can bite, and only for a key whose model list carries Claude ids while its
group is OpenAI-platform. That takes a deliberate setup: `/v1/models` publishes the keys of each
account's `model_mapping`, so an operator has to have mapped something like
`"claude-sonnet-4-5": "gpt-5.5"` onto an OpenAI account. (The group-level
`messages_dispatch_model_config` that normally points Claude Code at OpenAI accounts does not
appear in the model list, so the usual setup is unaffected.)

When it does happen the first request fails loudly and says exactly why:

```
403 {"type":"permission_error","message":"This group does not allow /v1/messages dispatch"}
```

Fix it by setting `SUB2API_PROTOCOL` to `openai-completions`, or by turning on
`allow_messages_dispatch` for the group.

### Confirming the split

The startup line reports which protocol each model landed on:

```bash
pi --list-models
```

```
[sub2api] registered 12 model(s) — anthropic-messages: claude-opus-4-7, claude-sonnet-4-6 | openai-completions: gpt-5.5, gpt-5.4
```

After forcing, only one side should remain. Note that this line is only readable in
`--list-models` and print mode — the interactive TUI clears the screen as it starts.

### Startup model cache

After the first successful discovery, model IDs are cached under
`~/.pi/agent/sub2api-models/` (or `PI_CODING_AGENT_DIR/sub2api-models/`). The cache
is scoped to the gateway, API key and protocol using a hash; credentials are not stored.

Cached startup registers models immediately without waiting for the gateway. Once a
session starts, a non-blocking refresh updates the cache for the **next launch or reload**;
the active catalog is left unchanged. Refresh errors or empty results retain the last
working list. `--list-models` uses the cache without starting a refresh.

First-time discovery, or a changed configuration, waits at most 2 seconds for the request
(instead of 8). If that fails, the provider is skipped as before. Delete the matching cache
file (or the cache directory) to force discovery; a cached list can otherwise remain stale
while the gateway is unavailable. Cache write failures are logged but do not prevent
registration. No model cache is included in the package.

## Use

```bash
pi --list-models                                  # models appear under the sub2api provider
pi --provider sub2api --model gpt-5.5
pi --provider sub2api --model claude-opus-4-7
```

In an interactive session, `/usage` prints enabled subscription limits, balance and cost.
For a subscription, only daily/weekly/monthly windows with a positive limit are shown:

```
sub2api usage
  plan     Example subscription
  weekly   $286.86 / $400.00 used | $113.14 remaining (28.3%)
```

Null or zero limits are hidden. Unused enabled limits are still shown; exhausted limits
show zero remaining. Reset times are not inferred. The same inference API key is used,
with no dashboard login needed. If the gateway returns key-specific quota/rate limits
instead of a subscription breakdown, subscription rows are unavailable.

Existing balance and cost reporting is unchanged:

```
sub2api usage
  balance  -67.01 USD
  today    $0.27 · 9 req · 57,826 tok
  total    $184.21 · 5,965 req · 105,534,943 tok
  top models (by cost)
    gpt-5.5  $0.27 · 52,300 tok · 4 req
```

### Pi Atelier sidebar

With [Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier) loaded, enable the
**Sub2API** panel in Atelier's **Settings -> Display**. New contributed panels start
hidden. The panel (`sub2api:usage`) shows only the percentage spent of enabled
subscription limits in aligned label/value columns. A single enabled limit uses
`Used` and `Time`; multiple limits prefix those labels with `daily`, `weekly`,
and `monthly`. `Time` is the straight-line spending target: the percentage of the
allowance period elapsed. Weekly timing uses the gateway's timezone-aware
`subscription.weekly_window_start` over seven days, clamped to 0-100%. Missing or
invalid timestamps show `Unavailable`. The public API does not expose daily/monthly
reset boundaries, so their Time values also show `Unavailable`; no dates are guessed.
Both values refresh when usage refreshes, rather than ticking on a timer. Percentages
remain accurate above 100% for over-limit usage. The panel publishes optional
`keyValues` so supporting Atelier versions align labels and values at the current
sidebar width and reflow them on resize. Older Atelier versions retain the existing
fixed-spacing plain-row fallback; no Atelier dependency is required.
On supporting hosts, **Used** values are green below 50%, yellow from 50% to
below 75%, orange from 75% to below 90%, and red at 90% and above. Thresholds use
the unrounded usage percentage. **Time** stays neutral; unavailable values stay muted.
Disabled limits are omitted and
missing usage is shown as unavailable, not zero. Detailed amounts, balance, costs
and model statistics remain in `/usage`. Atelier's public contributed-panel API
has no compact/expanded state, so this panel always uses the compact presentation.

Usage refreshes in the background at UI session start and after an agent run using
the Sub2API provider. `/usage` also refreshes the panel; concurrent refreshes share
one request. There is no polling timer. A failed refresh replaces the panel with a
warning; run `/usage` to retry and see the detailed error. Gateway accounting may
lag a just-completed request.

The integration uses Atelier's public v1 event-bus protocol, so either extension
can load first and Atelier is not a required dependency. Without Atelier, the
extension continues working normally (UI sessions still refresh usage). No
automatic usage requests are made in non-UI sessions. The panel is removed on
shutdown or reload.

## Notes

- **API type**: the OpenAI side defaults to `openai-completions`;
  [`openai-responses`](#openai-responses) is available and is the gateway's native path.
  `openai-codex-responses` is not wired up: pi builds its URL as `{baseUrl}/codex/responses`, so it
  needs `{BASE}/backend-api/codex` as the base rather than `{BASE}/v1`. That route does answer, so
  supporting it is possible — it just needs its own base URL.
- **Cost**: pi's per-token `cost` is set to `0`, because sub2api's `/v1/models` returns no pricing.
  Cost comes from the gateway's own accounting via `/usage`, not from pi's estimate.
- **Model list**: embedding and image-generation models are filtered out; only chat-capable models
  are registered.
- **Thinking levels**: on the OpenAI path, reasoning models expose `off/low/medium/high/xhigh`;
  `minimal` is marked unsupported because the upstream rejects `reasoning_effort: "minimal"`.
- **Model metadata**: the gateway's model list reports no per-model limits, so `contextWindow` and
  `maxTokens` come from a table keyed on the model id — Claude generations mirror pi's built-in
  Anthropic values, and everything else gets 400000/128000. Claude ids newer than that table get
  their generation's context window with a conservative output cap: an under-declared `maxTokens`
  only shortens replies, while an over-declared one is a hard 400.

## Development

```bash
npm install
npm run check          # tsc --noEmit
npm test               # usage formatting, model cache and sidebar regressions
npm run pack:dry-run   # what would ship
```

There is no build step. The package ships TypeScript, which pi loads
through jiti, so `pi -e /path/to/pi-sub2api` runs a checkout exactly as an installed copy
runs. The extension is one file: `src/index.ts`. The formatter and sidebar tests transpile it without
executing the extension factory or reading credentials. Model-cache tests use synthetic
keys and isolated temporary directories.

Typechecking and formatter tests are automated gates, but do not cover live gateway behavior.
Everything interesting here is a claim about a live gateway — which protocol a key's
platform serves natively, what `/v1/models` omits, which `reasoning_effort` values the
upstream rejects — and none of it can be verified without pointing the extension at a real
sub2api instance. Those claims are recorded in [Notes](#notes) as what was observed.

## License

MIT
