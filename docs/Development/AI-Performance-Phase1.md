# AI performance, phase 1: low-risk work elimination

Phase 0 built the measurement layer (see [AI-Performance-Measurement.md](AI-Performance-Measurement.md)).
This is phase 1 of the performance plan: the changes that remove demonstrably repeated work without
changing the action space the AI explores, plus one correctness fix that had to land before any
further concurrency work.

**Nothing here changes how the AI plays.** Every item reaches the same answer by doing less, and each
one is paired with a test that compares it against the code it replaced on a real game state.

## What changed

| # | Change | Where | What it removes |
|---|---|---|---|
| 1 | Derive the root game score on demand | `GameSimulator` | One full state evaluation — and the combat-lookahead game copy inside it — per simulation branch |
| 2 | Bounded target counting | `TargetRestrictions.hasAtLeastCandidates` | Building a full candidate list to answer "are there at least N?" |
| 3 | Per-decision comparator facts | `ComputerUtilAbility.SortFacts`, `AiController.sortCandidates` | Re-deriving cost, priority and creature evaluation on every one of `O(n log n)` comparisons |
| 4 | Reuse one structural cost adjustment | `ComputerUtilCost.canPayCost` | The second `CostAdjustment.adjust` scan of every battlefield, stack and command permanent per feasibility check |
| 5 | Serial forced-attacker loop | `AiAttackController.declareAttackers` | A common-pool fan-out that made the declared attack depend on thread scheduling |
| 6 | Pooled evaluation worker | `AiEvaluationExecutor` | One OS thread created and destroyed per priority decision |

### 1. Derive the root game score on demand

`GameSimulator` scored the unchanged original game in its constructor. That evaluation is not cheap:
before combat damage, `GameStateEvaluator` copies the whole game to look ahead at the coming combat.

It is now derived on demand in `getScoreForOrigGame()`. **Almost nothing asks for it.** The full
simulation picker builds one simulator per target/mode branch and never reads the value; neither does
`simulateSpellAbility`. The only readers are `OnePlaySafetyChecker`, a few tests, and the
assertion-only game copy check — each immediately after construction, so each sees the same value at
the same point it always did.

This replaced an earlier attempt at the same saving, and the history is the useful part:

1. The plan (§3.1, §10.1) proposed passing the picker's root score into every branch, **conditional
   on a shadow test** proving the baseline invariant. That test was written first and it failed: on a
   full board with recursive simulation, the score taken at the top of `chooseSpellAbilityToPlay` no
   longer matched a fresh evaluation by the time the branches ran, because deciding whether each
   candidate can be played and paid for touches state the evaluator reads.
2. Narrowing the reuse to the branches of one candidate passed the suite — but only because the suite
   runs with assertions **on**, which forces the value to be computed anyway. That is a trap worth
   naming: an assertion-enabled parity run cannot validate a change whose whole point is not to
   compute something.
3. Reading the callers showed the value was not needed at all on the shipped path. Not computing a
   number nobody reads cannot change a decision — no invariant, no shadow check, and it removes
   strictly more work than the reuse did, including the first branch's evaluation.

The `COPY_STACK` path stays eager: it needs a second copy from the same copier, and taking it later
would reset the object mapping `simulateSpellAbility` depends on.

### 2. Bounded target counting

`getNumCandidates` is `O(P + C)` plus a list allocation even when the caller only wants to know
whether one candidate exists. `hasAtLeastCandidates(sa, required)` walks the same sources in the same
order, applies the same predicates, and stops as soon as the answer is known.

It reproduces `getNumCandidates` rather than correcting it — including the double count its own TODO
notes — because callers observe only the boolean. The one thing it never skips is
`applyTargetTextChanges`, which mutates `validTgts` between the player and card passes and which
later readers depend on having run.

Migrated callers (all threshold-only): `ComputerUtilAbility.isFullyTargetable`,
`AiController.canPlaySa`, `SpellAbilityAi.doTrigger`, `CharmEffect`. Callers that need the members or
their order still use `getAllCandidates`.

### 3. Per-decision comparator facts

`saComparator` derives the same handful of values from an ability on every comparison, and
`getSpellAbilityPriority` walks the host card's triggers and static abilities to do it. Nothing in a
sort mutates the game, so those values cannot change while the sort runs.

`AiController.sortCandidates` now creates one `SortFacts` and shares it between both ordering passes —
the general comparator pass and the creature-spell pass — so a creature's evaluation is paid for once
per decision instead of once per comparison. The facts are dropped when the ordering finishes.

`ComputerUtilAbility.saEvaluator` is unchanged and still derives everything on demand, so any other
caller behaves exactly as before. Suspicious comparator asymmetries were deliberately **not** "fixed"
here; the parity test requires byte-identical ordered output.

With assertions on, every sort orders a copy of the same input with the uncached comparators and
requires the same sequence, so all 361 tests check the facts rather than only the one test written
for them. The copy is taken *before* the sort: these comparators are not guaranteed transitive, so
re-sorting an already sorted list would not be the same experiment.

### 4. Reuse one structural cost adjustment

`ComputerUtilCost.canPayCost` reaches both the mana check and the additional-cost check, and each ran
`CostAdjustment.adjust` over the same cost — the source carried a TODO saying as much. The mana check
now reports the adjustment it derived, and the additional-cost check takes that result.

The two are not automatically the same, so the reuse is guarded. While it works out the mana cost,
`calculateManaCost` temporarily points the host card's "cast from" at the zone it is currently in,
and the adjustment reads that. **The guard is structural: reuse only when that temporary value was
the value the additional-cost check will see anyway**, which makes the two calls the same call.

The first version of this guard was analytical instead — it enumerated the two places the adjustment
reads "cast from" (commander tax, and a static's `AffectedZone` requirement for a card that has been
cast) and allowed reuse where neither applied. That is a claim about code elsewhere, and it stops
being true the day someone adds a third reader, silently and with assertions off. "The context did
not differ" cannot stop being true.

Safety costs hit rate here, and it is worth being explicit about how much. On a board with lands,
burn, creature spells, an artifact, an aura and two permanents with activated abilities, measured
over a played turn:

| Guard | `canPayCost` calls | Reuses | Hit rate |
|---|---:|---:|---:|
| Analytical (first version) | 37 | 37 | 100% |
| Structural (shipped) | 37 | 22 | 59% |

The difference is entirely spells being cast from hand, whose "cast from" genuinely is repointed.
Activated abilities, and spells already on the stack, still reuse. With assertions on, every reuse is
additionally shadow-checked against adjusting a second time.

### 5. Serial forced-attacker loop

The must-attack loop in `declareAttackers` fanned out one `CompletableFuture` per attacker onto the
common pool. The tasks read shared combat and requirement objects and declared attackers into the
live `Combat`, so which creatures ended up attacking — and in what order — depended on how the pool
interleaved them; a task still running when the aggregate future timed out could declare an attacker
after the method had moved on.

It now runs serially in attacker order. The work is a handful of requirement lookups per attacker, so
ordering it costs little, and the declaration is reproducible. This is the prerequisite the plan sets
for any later concurrency work: a behaviour-preserving parallel rewrite has to start from a pure
computation over an immutable snapshot, not from this.

The failure path is preserved deliberately: `exceptionally` swallowed anything a task threw and left
that attacker undeclared, so the serial loop catches `RuntimeException` and `StackOverflowError` per
attacker and carries on. Deep recursion is a real failure mode here (see #8302). Errors that say the
JVM is out of resources are not caught — continuing from those was never a behaviour anyone relied
on.

### 6. Pooled evaluation worker

The watchdog boundary — run the candidate loop on another thread, wait with a timeout — is worth
keeping. Creating an OS thread per priority decision to get it is not. `AiEvaluationExecutor` hands
out the same semantics over a pool that keeps idle workers for a minute.

**This is a shared pool, not the per-controller single worker the plan sketched**, and the reason is
worth recording. Decisions are not as serial as they look: every simulated game copy builds its own
players and therefore its own controllers, and the AI in a copy takes priority while an outer
decision is still on the stack. A single worker owned by one controller would deadlock the nested
decision behind the outer one, and a worker owned by each controller would leave a parked thread
behind for every game copy. A pool sized by actual concurrency does neither.

`Thread.stop()` is still the last resort, unchanged, because the evaluation loop only honours
cancellation between abilities. A run that ignores cancellation keeps its thread and simply never
returns to the pool — exactly what thread-per-decision did — so one stuck evaluation cannot stall
later decisions.

The pool is capped at eight workers, and past the cap a decision starts a thread of its own rather
than queueing. Concurrent evaluations are bounded by simulation nesting in practice, but abandoned
workers are never returned, so an uncapped pool could grow across a long session. The cap bounds
that; the fallback means the worst case is exactly the behaviour every decision used to have.
`evalWorkersUnpooled` counts it, and it should stay at zero.

## New counters

Added to `PerfCounter`, so the JSON report and the JFR events show whether each fast path is engaging:

| Counter | Meaning |
|---|---|
| `targetThresholdQueries` | `hasAtLeastCandidates` calls |
| `targetCandidatesVisited` | Entities those traversals examined before stopping — compare against `targetCandidatesMaterialized` |
| `sortFactsComputed` / `sortFactHits` | Comparator facts derived versus served from the per-decision cache |
| `costAdjustmentReuses` | Feasibility checks that adjusted the cost once instead of twice |
| `evalWorkersAbandoned` | Evaluations that ignored cancellation and cost their worker |
| `evalWorkersUnpooled` | Evaluations that had to start their own thread because the pool was full |

## What phase 1 did *not* include

- **"Use no-allocation traversal where the result is not retained"** (plan §3.4). It appears in the
  plan's low-risk list but has no phase 1 row in the roadmap, and §4.1 makes it conditional on an
  allocation profile selecting the call sites. Converting an aggregate zone query is only sound after
  auditing each consumer for snapshot, indexing and mutation assumptions, which is per-call-site work
  that belongs with the phase 2 allocation pass.
- **Reproducing the PR #11366 and #11160 measurements on this revision** (plan roadmap, phase 1 P0).
  This is a measurement task, and it was not run here: the container this work was done in shares CPU
  with other tenants, which is the one thing §11.2 says a timing run must not do. The runbook below is
  what to run on a machine that can produce a trustworthy number. Note that #11366's result cannot be
  reproduced without first implementing the `CardState` trait cache, which is phase 2 P0.

## Reproduction runbook

Take a baseline and an optimised measurement from the same fixture corpus, on a quiet machine, with
pinned JVM flags. `forge bench` is the harness; see the measurement doc for its options.

```
# 1. correctness first: exact trace identity, both builds, same seed
forge bench -d deck-a.dck -D res/geneticaidecks -n 20 -s 7 -t -o before
#   (rebuild with the change)
forge bench -d deck-a.dck -D res/geneticaidecks -n 20 -s 7 -t -o after
diff before/trace.jsonl after/trace.jsonl        # must be empty

# 2. then timing, tracing off, fresh JVM per run, order randomised
forge bench -d deck-a.dck -D res/geneticaidecks -n 20 -w 2 -s 7 -o before-timing
forge bench -d deck-a.dck -D res/geneticaidecks -n 20 -w 2 -s 7 -o after-timing
```

Beyond "faster", the success criteria for these six changes are:

| Change | What the counters must show |
|---|---|
| On-demand root score | `scoreEvaluations` and `combatLookaheadCopies` down by roughly `simulationBranches`; identical trace |
| Bounded targets | `targetCandidatesVisited` well below what `targetCandidatesMaterialized` was for the same fixture; same boolean everywhere |
| Sort facts | `sortFactHits` ≫ `sortFactsComputed`; byte-identical ordered candidate list |
| Cost adjustment | `costAdjustmentReuses` close to `canPayCostChecks`; same payable verdict |
| Forced attackers | Same declared attackers across repeated runs of one board |
| Pooled worker | Thread count tracks concurrent evaluations, not decision count; `evalWorkersAbandoned` zero |

## Parity evidence

The default pass criterion is exact trace identity, and it was checked against the merge base rather
than only asserted about. A throwaway harness played two fixed-seed scenarios to the end of a turn on
both builds with `PerfProbe` tracing on, writing the ordered decision trace followed by the full
canonical `GameStateDigest` dump of the final state.

**Run it with assertions disabled** (`-DenableAssertions=false`). This matters more than it sounds:
Surefire enables assertions by default, and several of the changes here are guarded by shadow checks
that recompute the very thing the change avoids computing. An assertions-on comparison therefore
cannot see a work-elimination change at all — it was that run which made the earlier baseline-reuse
attempt look clean.

| Scenario | Covers | Result |
|---|---|---|
| Conventional AI, full board (lands, burn, creature spell, artifact, aura, activated abilities, attackers and blockers) | Candidate ordering, heuristic verdicts, target thresholds, cost feasibility, attack and block declaration, RNG draws | 881 lines **byte-identical** |
| Full-simulation AI, multi-branch targeting | Simulated branch scores per candidate, on-demand root score, RNG draws | 23,046 lines **byte-identical** |

### What that comparison turned up

Before the digest change described below, the simulation scenario matched on all 23,007 trace lines —
every decision, every simulated branch score, every RNG draw — and then differed on the final state.
The whole difference was the absolute value of card timestamps: `ts=246,247,248,249` against
`ts=78,79,80,81`, same cards, same zones, same order, same everything else.

Measured cause: **one `GameStateEvaluator` call with combat lookahead advances the live game's
timestamp counter by 5**, while a bare `GameCopier.makeCopy` advances it by 0. The lookahead copies
the game and advances the copy to combat damage, and something in that copied combat still draws from
the original game's counter. That is a pre-existing copy-fidelity leak, in the same family as the
"Game copy error" recorded below — the copy is not fully detached from its original. Removing
evaluations therefore leaves the counter lower, and cards that later change zones are stamped with
smaller numbers.

Timestamps order continuous effects, and the rules only use them relatively. Relative order was
preserved exactly. So `GameStateDigest` now records each card's timestamp **rank** among the
timestamps present in the game rather than its raw value: a reordering — the part that could change a
game — still shows up, while the part that only reflects how much hypothetical work the AI did does
not. Without that, every future work-elimination change in phases 2 to 5 would fail state comparison
for a reason that has nothing to do with the game.

Two further observations from building the fixtures:

- The simulation fixture originally gave the AI creatures before combat, which makes the evaluator
  copy the game to look ahead. That fixture fails on **master** too, with `GameSimulator`'s own "Game
  copy error" check: a recursively simulated game copies back with a creature missing on each side
  and the opponent two life adrift. Not introduced or fixed here, and worth its own investigation.
- Because that check compares a copy against the original's score, it doubles as a second shadow
  check whenever simulation runs with assertions on.

## Tests

| Test | Covers |
|---|---|
| `forge.ai.AiPhase1OptimizationTest` | Bounded target counting against full counting at every threshold; ordered candidate list with and without facts; cost feasibility with and without adjustment reuse; repeated attack declarations on one board; worker reuse across a played turn |
| `forge.ai.simulation.LazyBaselineScoreTest` | The deferred score equals the eager one, is memoised, and deriving it does not disturb the game; candidate scores unchanged without per-branch baselines |
| `forge.ai.AiPerfInstrumentationTest` | (phase 0) Probing does not change the canonical game state; traces are reproducible |

Four shadow checks are `assert`-only, so they run over the **whole** AI and simulation suite rather
than only the tests written for them, and cost nothing in a shipped build:

| Shadow check | Where | What it would catch |
|---|---|---|
| Bounded traversal against the full count | `TargetRestrictions.hasAtLeastCandidates` | A predicate the early exit stops calling that the caller could observe |
| Ordered candidate list against the uncached comparators | `AiController.sortCandidates` | Any comparator fact that is not stable for the length of a sort |
| Reused adjustment against adjusting again | `ComputerUtilCost.canPayCost` | A context difference the structural guard does not cover |
| Copied game's score against the original's | `GameSimulator` (pre-existing) | Copy fidelity, including anything the on-demand score changed |

The catch is that a shadow check computes what the change avoids computing, so a build with
assertions on is **not** the build to compare for parity. See the note above.
