---
summary: "Provider, storage, worker, and embedding registration on OpenClawPluginApi"
title: "Plugin SDK capability registration"
sidebarTitle: "Capability registration"
read_when:
  - You are registering an inference, media, search, or transcript provider
  - You are implementing the cloud-worker provider lifecycle
  - You are registering an embedding provider
  - You are implementing a storage location transport
---

The capability registrars on `OpenClawPluginApi`, and the runtime contracts a
worker, storage, or embedding provider must satisfy. Part of the
[Plugin SDK overview](/plugins/sdk-overview).

## Capability registration

| Method                                           | What it registers                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `api.registerProvider(...)`                      | Text inference (LLM)                                                              |
| `api.registerModelCatalogProvider(...)`          | Model catalog rows for text and media generation                                  |
| `api.registerAgentHarness(...)`                  | [Experimental](/plugins/sdk-agent-harness) native agent executor (Codex, Copilot) |
| `api.registerCliBackend(...)`                    | Local CLI inference backend                                                       |
| `api.registerChannel(...)`                       | Messaging channel                                                                 |
| `api.registerEmbeddingProvider(...)`             | Reusable vector embedding provider                                                |
| `api.registerSpeechProvider(...)`                | Text-to-speech / STT synthesis                                                    |
| `api.registerRealtimeTranscriptionProvider(...)` | Streaming realtime transcription                                                  |
| `api.registerRealtimeVoiceProvider(...)`         | Duplex realtime voice sessions                                                    |
| `api.registerMediaUnderstandingProvider(...)`    | Image/audio/video analysis                                                        |
| `api.registerTranscriptSourceProvider(...)`      | Live or imported meeting transcript source                                        |
| `api.registerImageGenerationProvider(...)`       | Image generation                                                                  |
| `api.registerMusicGenerationProvider(...)`       | Music generation                                                                  |
| `api.registerVideoGenerationProvider(...)`       | Video generation                                                                  |
| `api.registerWebFetchProvider(...)`              | Web fetch / scrape provider                                                       |
| `api.registerWebSearchProvider(...)`             | Web search                                                                        |

Transcript source providers that share an account namespace with an inbound
channel declare an `accountOwnership` descriptor with that channel id and a
shared account resolver. OpenClaw then
ignores model-selected account ids for same-channel capture, binds the trusted
inbound account, and records it as the session owner for later lifecycle
actions. The resolver also selects an omitted account before OpenClaw starts or
persists live capture. It validates an already-bound trusted account without
redirecting it and returns an actionable typed error when no unique capable
account exists. Configured auto-start must supply a nonempty source account or
resolve one with this descriptor. OpenClaw rejects ambiguous or unresolved ownership before it
persists the start or invokes the provider. Provider aliases are lookup names
only and must not be used for this declaration.

## Versioned decision data

The focused `openclaw/plugin-sdk/decisions` entrypoint provides additive V2 data
types and pure validation/conversion helpers for adapters and saved decision fixtures.
These helpers do not run a provider, collect evidence, choose a model, or issue host
authority. The existing V1 `api.runtime.decisions.evaluate` contract remains
available. V2 execution uses `api.runtime.decisions.evaluateV2` and a versioned
provider registration; importing data types alone does not authorize execution.

`DecisionContentV2` distinguishes text, JSON, image data, and stable-ID lists.
Answers preserve explicit Boolean decisions separately from P(true), nullable
choices, fractional scores, sort/tag results, per-question errors, and reported
usage. Missing estimates and costs stay missing. Independent estimates are not
normalized; categorical distributions retain their declared constraints. Data
and validation results are never permission to execute an action.

`validateDecisionBatchV2` and `validateDecisionResultV2` enforce the bounded data
contract. Result validation optionally accepts the route's declared decision
capabilities. Structural validation alone cannot prove that a provider supports
an operation, an input modality, or a reasoning mode.

The four explicit codecs are `decisionBatchV1ToV2`,
`decisionBatchV2ToV1`, `decisionResultV1ToV2`, and
`decisionResultV2ToV1`. Unsupported or unrepresentable data returns
`undefined` instead of being coerced. Malformed batch input throws
`DecisionContractError`. They preserve values rather than performing inference,
thresholding, argmax, probability normalization, or accounting estimates.

For example, an explicit V2 JSON string cannot become V1 text without losing its
evidence kind. Rich answers, abstention, or accounting that V1 cannot represent
also cannot be silently downgraded. Compatible conversions may share readonly
input data; they do not promise an independent deep copy.

## Prepared decision execution (contract version 2)

Register `DecisionProviderV2` with `contractVersion: 2` and the provider ID declared
in `contracts.decisionProviders`. Supply its normal provider definition in the
registration's `provider` field, or register that provider first from the same
plugin. A different plugin cannot attach an executor to that provider ID.

Declare decision capabilities under `modelCatalog.providers.<id>.models[].inference`.
Set `chat: false` for typed-only models. They appear in the decision catalog and
stay out of conversational model pickers; no chat context window or token cost
needs to be invented. The documented V1 `decisionModels` manifest input is
normalized into this catalog. An explicit canonical row owns its whole contract.

Consumers call `api.runtime.decisions.evaluateV2(batch, options)` with the same
purpose, rubric version, deadline, signal and explicit decision-model selection
as V1. Optional `reasoning` must match the selected model's declared modes.
The prepared runtime resolves that exact model, normal provider credentials and
route. An explicit `@profile` selection is locked; it cannot fall through to
another account. Credentials resolve for the selected agent/profile during preparation;
provider status makes no global V2 credential-readiness claim.
V2 providers receive private prepared model/auth facts and a
required `isAdmissible()` predicate. Check it immediately before physical I/O,
including after DNS or a worker queue wait. False closes the request; do not
swallow an authority assertion to continue inference.

The host retains the request until physical provider cleanup settles, even when
cancellation or plugin reload has already revoked dispatch authority. It validates
and snapshots accepted output before returning it. Auth facts, headers and
transport overrides do not enter public results. Cost recording is a separate
consumer of accepted outcomes. V2 SDK calls record validated usage only after
provider and caller lifetime checks pass; rejected, retired or cancelled results
produce no usage event. Accounting uses the selected provider/model, excluding
auth profile suffixes, and the host-owned calling plugin identity. Reported USD
costs, including zero, win over prepared token rates. Unknown route pricing stays
unknown. Estimates enter accounting only; returned usage keeps provider facts.

The core `decision_evaluate` tool also uses V2 execution while retaining its bounded
Boolean/Choice/Score input shape. It exposes accepted native answers, abstention,
per-question errors, metadata and usage without V1 result narrowing. Existing V1
providers continue through the lossless input/result bridge. Automatic consumers
that still use V1 retain their own fallback behavior when a native result cannot
be represented without loss.

V1 and V2 callers can use either provider version when the pure SDK codecs can
represent the entire batch and result without loss. Native abstention, images,
sort/tag questions or other unrepresentable data return `unsupported-input`
across the V1 boundary. They never become fabricated probabilities or labels.
Existing V1 providers retain their documented execution contract. External
plugins adopt V2 only after a host release exports the required V2 SDK surface.

## Decision models (contract version 1)

Start with [Decision models](/concepts/decision-models) for model choices,
configuration, and Choice/Score/Boolean rubric examples. This section defines
the provider and consumer SDK contract.

`api.registerDecisionProvider({ id, contractVersion: 1, isReady, evaluate })` registers
an optional decision provider, separate from conversational model providers and
agent tools. Declare the ID in manifest `contracts.decisionProviders`; duplicate
IDs are rejected. Registration and optional `isReady()` must be local, synchronous,
and network-free. Import types from `openclaw/plugin-sdk/decisions`.

Consumers call `api.runtime.decisions.evaluate(batch, { agentId?, purpose, priority?, rubricVersion,
timeoutMs, signal })`. State and rubric entries are finite JSON. Use plain objects
and arrays; custom prototypes, serialization hooks, and getters are rejected on
both request and response boundaries. Choices preserve
all offered labels and probabilities; the chosen label is the provider's decision
and need not equal the largest rounded probability. Consumers choose whether to
use that label or an explicit distribution policy. Ordered scores are fractional
estimated zero-based positions, with index-aligned probabilities; Boolean answers
carry `probabilityTrue`. The host validates the entire batch atomically: exact answer
keys, finite probabilities in [0, 1], positive distribution mass, and scores within
the submitted rubric. Reported probabilities may be rounded and need not sum
exactly to one; scores need not equal the expectation of that rounded distribution.
The host preserves those values. Consumers that require normalized weights must
apply their own explicit policy. Provider confidence is a provider-specific metric,
not calibrated correctness. Results include model, optional token usage, and local
rubric and runtime-generation provenance.

Set `agents.defaults.decisionModel` to an explicit `provider/model` reference.
Unset or empty means off. `agents.entries.<id>.decisionModel` overrides the global
default; an empty agent value disables decisions for that agent. There is no
automatic conversational-model fallback. Selection makes the provider available
to supported consumers. Consumers own their feature activation and evidence
selection; provider configuration alone does not schedule background work. Evidence
sent to the selected provider may incur its normal usage charges. Plugin disablement
wins; installing a tool or credential alone does not select a provider. Vendor adapters
own transport and model-specific translation; no vendor is a core dependency.

The [ONNX plugin](/plugins/onnx) supplies local classifiers; the
[TypeSafe AI plugin](/plugins/typesafe) supplies hosted Jev and local System One
adapters, including Kev. Both plugins require
separate installation, explicit setup, and role selection.

### Calling from a third-party plugin

Like `api.runtime.llm.complete`, `api.runtime.decisions.evaluate` lets a plugin
consume a host-configured provider without handling its credentials. The consumer
does not need the provider's SDK, API key, SecretRef, or a provider registration.
Only the provider plugin registers `contracts.decisionProviders` and owns its
vendor transport and prepared credential input. This does not make conversational
model credentials interchangeable with decision-provider credentials.

The operator must enable and configure the provider plugin and select
`agents.defaults.decisionModel` (or an agent override). Third-party plugins own
their feature's activation, evidence selection, and permission to send that
evidence. Having credentials alone must not activate background collection or
spending.

The host applies the registered consumer plugin's `allowedCompletionModels`
policy from `plugins.entries.<consumer-id>.llm` before provider dispatch. An empty
or invalid-only list denies all models; `["*"]` permits any model at this policy
layer. Pass the operation's owning `agentId` as before; omitting it selects the
global decision role, even inside an agent operation. Unlike the agent-bound LLM
runtime, Decision calls select their owner explicitly and do not require
`allowAgentIdOverride`.

A configured decision role is not a caller model override, so `allowModelOverride`
and the override-only `allowedModels` do not gate it. The agent's conversational
`modelPolicy.allow` is not an all-completion restriction. Current Gateway operator
model policy remains independently enforced, including revocation and cancellation.
Request fields cannot substitute consumer identity or another plugin's policy.
Authorization failures throw rather than return an `unavailable` fallback outcome.
The built-in decision tool uses its host-bound agent rather than a public override.

Call from a live plugin tool, hook, or other owned operation, carrying its
cancellation signal:

```ts
const outcome = await api.runtime.decisions.evaluate(
  {
    state: { message: "Can you help me with this?", directlyAddressed: true },
    questions: {
      respond: {
        type: "boolean",
        instructions: "Is this message asking the assistant to respond?",
        criteria: {
          true: "The message asks the assistant to respond",
          false: "The message does not ask the assistant to respond",
        },
      },
    },
  },
  {
    agentId, // The agent that owns this operation; omit only for global-default selection.
    purpose: "example-plugin.response-eligibility",
    rubricVersion: "1",
    timeoutMs: 1500,
    signal,
  },
);
```

An `ok` outcome contains validated answers, model/usage, and provider/rubric/runtime
provenance. It is evidence for the consumer's decision, not permission to send a
message or perform another effect. An `unavailable` outcome carries a reason for
the consumer's existing fallback. Do not catch cancellation or closed-authority
errors and turn them into fallback work.

The provider receives the selected `model` and optional `agentId` in its evaluation
context. Concurrent agent/model selections share provider health without retiring
each other. A changed selection fences the affected request before returning it.

Automatic consumers check the Labs opt-in at provider dispatch. Disabling it
stops future evaluations, not already-dispatched work or use of its result. The
host supplies `context.isAdmissible()` for ongoing consumer authority, model
selection, and provider configuration/credential generation checks; the Labs
toggle is not part of those ongoing checks. Providers performing external I/O
must call it synchronously immediately before sending,
after any lazy loading, DNS, or other awaited preparation. A false result closes
that evaluation; a thrown authority assertion is terminal. The host remembers
either observation across provider cleanup, so revocation cannot become a provider
health failure or a later successful result. Omission preserves explicit
`decision_evaluate` calls and older-host compatibility; it is not a Labs check for
explicit calls. TypeSafe uses its guarded transport’s final `beforeRequest` hook.
The host still checks before provider dispatch and before returning results, but
cannot prevent I/O in third-party providers that ignore this callback. Local ONNX
inference retains its existing signal-controlled worker lifecycle; it does not
transmit evidence to an external service.

Consumers share the selected provider's host-owned concurrency, circuit, and
credential-refresh lifecycle; each plugin does not create its own provider client.
No credential is returned to the consumer. Provider setup and refresh use the
same prepared-secret path whether the caller is built-in or third-party.

The host admits at most four requests, with no queue and a 30-second maximum.
`priority` defaults to `"requested"`. Set `"optional"` for opportunistic assistance:
it returns `overloaded` when three requests are already in flight, leaving the
fourth slot for requested evaluations. Purpose strings do not determine priority.
All requests retain their slots until the provider physically settles, including
after cancellation. Consumers can request shorter deadlines and choose their own fallback policy.
The caller's `timeoutMs` includes runtime preparation. Expired preparation never
starts a provider evaluation; otherwise the provider receives the remaining budget.
The call still waits for physical cleanup, which can outlive the deadline.
Three transport, rate-limit, or invalid-response failures open a ten-second circuit;
recovery admits one trial. Retry-After is bounded to one minute. Authentication
failures return to the caller without opening the shared provider circuit: another
agent or a later evaluation may use a different credential. There are no host retries
or health checks.

Caller cancellation and closed consumer authority reject: do not start fallback.
Provider retirement returns unavailable while a live consumer can fall back.
Providers must honor the composed abort signal and physically settle transport
and body cleanup; an uncooperative provider stays owned and fenced by normal
failed-drain recovery. Old generation outcomes cannot update new health.

Manifest capability credentials use `configContracts.secretInputs` and authored
SecretRefs. `getPreparedPluginSecretInput(pluginId, path)` from
`openclaw/plugin-sdk/secret-input-runtime` reads only a prepared, available snapshot;
it never resolves a cold reference or consults ambient environment credentials.
Call it only from the plugin instance's active invocation. The helper is not a
durable credential capability: quiescing or retiring that exact instance removes
read authority immediately, even while already-admitted work is finishing. A
provider must treat a missing value as unavailable and must not retain or reuse a
previous value across reload. Refresh with `secrets.reload`; capability failure
does not retain an old key.

`plugins.inspect` reports configuration, credential readiness, current callability,
last success, usage, latency, and bounded unavailable counts. For V1, `credentialReady: true`
means the provider's local `isReady()` confirmed prepared credentials. `false`
means readiness is unconfirmed or unavailable, not necessarily that credentials
are missing. V2 omits `credentialReady` because credentials are selected for each
agent/profile during preparation. Omitting V1 `isReady()` leaves evaluation eligible; returning `false`
blocks it. `callable` separately reports current admission for requested evaluations,
not guaranteed success.
Counts are instance-local diagnostics, not durable audit records or write authority.

For discovery, declare decision capabilities in the model's canonical
`modelCatalog.providers.<id>.models[].inference.decision` metadata. Each provider
must be owned by `contracts.decisionProviders`. The Control UI Decision picker
reads a separate `models.list.decisionModels` projection; no provider runtime or
credential check runs to populate the picker. Models with `inference.chat: false`
stay out of conversational pickers. Existing V1 `decisionModels` declarations
normalize into this catalog at manifest loading.

Decision metadata describes supported question types, input limits and their
accounting scope, Boolean criteria requirements, and confidence semantics.
The core `decision_evaluate` tool uses the prepared catalog when available,
otherwise the canonical manifest catalog; provider readiness does not change its
definition. See the
[manifest reference](/plugins/manifest/capabilities#decision-models-reference)
for the bounded descriptor fields.
