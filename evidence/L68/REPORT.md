# First transcript content: no production patch

The timestamp candidate did not improve first content and was reverted. Preserve the initial-position visibility gate: it releases during the same synchronous browser task that constructs and measures the rows. Closing the experiment-only draft; nothing to land.

## Scope and measurement

The campaign's original evidence recorded 14 intermediate states on a signed-in reload of a dashboard deep link. This lane investigates first transcript content using only the maintained synthetic Team-scale fixture; no private capture or conversation content is published.

Baseline source is `3d40bcedbb74` on `ab8c15de6536`, including the initial-placement repair #172973. Candidate changed only `ui/src/pages/chat/components/chat-message-timestamp-view.tsx`: skip unused long timestamp titles and avoid constructing unused usage metadata. Both production bundles use the same build identity. The branch's only committed change is this report.

One quiet AWS Crabbox `c7a.4xlarge`, lease `cbx_dd98465b365f`, observed 16 AMD EPYC 9R14 CPUs and 30.64 GiB RAM; Node 24.19.0 and repository headless Chromium 153. Seven alternating AB/BA baseline/candidate pairs. Each invocation warms the synthetic signed-in dashboard, preserves localStorage shell preferences, then clears origin IndexedDB before the measured reload to guarantee no cached transcript. A native browser WebSocket connects to the canonical fixture responder running in Node. Reply latency is 35 ms with a 4 ms delivery gap. No real Gateway or account.

Unlike the earlier L65 setup, this explicit uncached-transcript scenario receives content after hello, on startup. Connect and first-content tasks are therefore reported separately. This is a new baseline, not a numerical comparison against L65's 120 ms bucket. LoAF/mutation probes and CPU profiling add overhead equally to both variants.

Values are median (IQR), milliseconds except CLS and RPC count.

| Metric                                                     |          Baseline |         Candidate |
| ---------------------------------------------------------- | ----------------: | ----------------: |
| First-content task                                         |     278.75 (3.80) |     279.95 (2.41) |
| Transcript content sampled CPU in that task                |      79.01 (2.03) |      80.82 (3.94) |
| Transcript content sampled CPU from connect through reveal |    114.58 (52.08) |    108.91 (40.62) |
| Connect task                                               |     7.28 (103.40) |   110.91 (106.85) |
| First row attached                                         |  1166.60 (195.20) |  1171.70 (137.95) |
| Visibility released                                        |  1369.70 (198.15) |  1373.50 (142.65) |
| FCP                                                        |           544 (8) |           544 (6) |
| LCP                                                        |        1496 (176) |        1492 (146) |
| CLS                                                        | 0.01374 (0.01000) | 0.02365 (0.01024) |
| RPC requests                                               |            87 (0) |            87 (0) |

Connect has two real task compositions: about 7 ms when pane/composer work runs in later tasks, and about 110 ms when that work shares hello's task. Baseline had four short and three long connect tasks; candidate had three short and four long tasks. Its median alone cannot establish a connect regression or win. First-content owning-task duration remains stable in both modes. The timestamp-only candidate supplies no clear end-to-end benefit; the CLS distribution also does not support keeping it.

CPU analysis uses the enclosing renderer task, not the synchronous listener duration. Native WebSocket receive/callback timestamps calibrate the browser/trace clock offset. Signed CPU-profile deltas are sorted into absolute sample time, matching the maintained profile summarizer. Samples are clipped to task intervals and assigned to the nearest owning source frame, with disjoint stage buckets. Early uncorrected listener-only summaries are not evidence.

## Content attribution

Baseline first-content task sampled CPU, median (IQR): sanitizer 29.20 (2.81), other message construction 15.25 (1.93), Markdown/reconciliation 11.74 (1.62), timestamps 9.00 (1.31), inline-widget paths 7.41 (2.80), images/avatar paths 5.81 (1.28), mention/link paths 0.69 (1.02) ms. Disjoint bucket medians need not add to the total median. Geometry is a separate 83.06 (1.50) ms; projection is 20.27 (2.13) ms. In the initial attribution capture, DOMParser.parseFromString accounts for about 25 ms under the sanitizer. Generic framework/native costs are attributed through their owning stack where available.

A separate instrumented candidate build counts production function calls and records row/hash-scoped spans. Its timings below are diagnostic only and are excluded from the seven-pair comparison. Before reveal, all 12 visited virtual rows (indices 228–239, including normal overscan) ran Markdown parsing, sanitization, and canonical DOM parsing exactly once. Ten rows remain mounted at reveal. No off-window history parsing, duplicate parser hash, syntax-highlighter call, or eager collapsed tool output was observed. The fixture's text is prose and its last row contains an inline widget; it is not proof about code-heavy or tool-heavy conversations.

| Row index | Preparations / reconciles | Markdown parses | Sanitizations | Parse ms | Sanitize ms | Canonical parse ms |
| --------- | ------------------------: | --------------: | ------------: | -------: | ----------: | -----------------: |
| 228       |                         2 |               1 |             1 |      0.1 |         1.9 |                0.1 |
| 229       |                         2 |               1 |             1 |      0.1 |         1.8 |                0.0 |
| 230       |                         4 |               1 |             1 |      0.1 |         1.9 |                0.2 |
| 231       |                         4 |               1 |             1 |      0.1 |         1.6 |                0.1 |
| 232       |                         4 |               1 |             1 |      0.2 |         1.8 |                0.1 |
| 233       |                         7 |               1 |             1 |      0.5 |         2.0 |                0.2 |
| 234       |                         7 |               1 |             1 |      0.0 |         1.7 |                0.0 |
| 235       |                         7 |               1 |             1 |      0.2 |         1.7 |                0.0 |
| 236       |                         7 |               1 |             1 |      0.1 |         1.7 |                0.0 |
| 237       |                         7 |               1 |             1 |      0.1 |         1.9 |                0.0 |
| 238       |                         7 |               1 |             1 |      0.1 |         1.6 |                0.1 |
| 239       |                         7 |               1 |             1 |      0.1 |         1.7 |                0.1 |

The 65 preparation/reconciliation passes cause 65 calls to the cached Markdown entry point but only 12 uncached renders. Diagnostic totals: sanitizer 21.3 ms, Markdown parser 1.7 ms, canonical parser 0.9 ms, timestamp preparation 5.9 ms, group preparation 1.2 ms, grouped-message preparation 0.6 ms, reconciliation 5.5 ms inclusive / 1.4 ms own. The remaining repeated work is substantially cheaper than reparsing. The maintained cache already prevents the hypothesized duplicate expensive work. Do not infer exact per-row CPU samples from these separate diagnostic spans.

## Visibility gate

`chat-transcript-layout-solid.tsx:216` queues geometry after nested row commits through one microtask. `chat-transcript-virtualizer-host.ts:736` measures connected rows, applies the target end offset, and releases visibility immediately once `isTranscriptRangeCommitted` confirms mounted rows match measured virtual sizes. It does not await fonts, images, widgets, animation frames, or a fixed timer on the ordinary tail-first path.

Baseline attachment-to-release is 203.10 (2.55) ms; release occurs 12.66 (0.91) ms before the owning task ends. Candidate values are 204.90 (3.40) and 12.73 (0.25) ms. This interval is synchronous rendering/geometry, not idle waiting for the gate. Clearing visibility earlier in that task would not permit an earlier browser paint. The bounded frame wait belongs to restoration of a saved non-end reader offset outside the currently measurable range and is a separate correctness contract. No gate change is proposed.

## Proof, artifacts, and disposition

The rejected timestamp candidate passed the existing message tests: 92 tests in 5.53 s wrapper wall time, plus two owned-control retention tests in 6.13 s. Both ran locally one file at a time with `--maxWorkers=1`. No test files changed. Autoreview found no accepted/actionable P0–P2 findings in the candidate. No full UI e2e, changed-file gate, or runtime PR CI is claimed for a candidate being discarded. The experiment draft skips broad runtime CI. Its PR-context check was red; failed-log retrieval hit GitHub API quota (HTTP 403), so the failure cause is unverified. The initial minimal body is replaced by the complete final report body.

The AWS baseline run is https://crabbox.openclaw.ai/portal/runs/run_4edead4ab308dbbd8d859101bb939699. Interleaved comparison and the separate diagnostic run used the same retained lease over its authenticated SSH route. All 14 comparison captures completed. The summary step initially failed because corrected analysis files had not yet been generated; analysis was completed from the retained raw traces/profiles without rerunning or excluding any measurement. Lease release confirmed. No host Gateway started.

Local proof under `.local/l68/`: `comparison.json`, `comparison-capture/`, `diagnostic-capture/`, `diagnostic-before-gate.json`, `baseline-content-stacks.json`, `rejected-timestamp.patch`, test/review logs, and `stop.log`. All captures are synthetic. Experiment harness and instrumentation remain ignored task artifacts, not production changes.

Runtime production LOC delta: **0**. Only `evidence/L68/REPORT.md` is committed; the requested diff-stat filter includes that nonproduction evidence file. No changelog entry or release note is needed. Recommendation to the lead: preserve the gate; do not land the timestamp candidate. A different fixture is required before making claims about code highlighting, tool cards, or content types absent here.
