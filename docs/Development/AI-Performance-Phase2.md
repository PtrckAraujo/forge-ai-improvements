# AI performance, phase 2: cached card trait views

This is the first Phase 2 optimization from the
[AI performance plan](AI-Performance-Plan.md): cache the derived trigger, static-ability and
replacement-effect views on each `CardState` instead of rebuilding them on every access.

The change is based on the measured design in Card-Forge PR
[#11366](https://github.com/Card-Forge/forge/pull/11366). That PR observed 18.0 million replacement,
11.2 million static and 2.7 million trigger view reads in one AI-vs-AI game, with the same view as the
previous read more than 99.9% of the time. Its fixed-seed three-game result was 35,877 ms to 16,773 ms
of in-game time (2.15x), with matching winners, turn counts and match scores. Those are historical
measurements on a nearby revision, not a timing claim for this branch.

## What changed

`CardState` now retains four lazily built views:

- triggers;
- static abilities;
- replacement effects when the card is the rules host;
- replacement effects when it is not the rules host.

The existing builders, concatenation order and `FCollection` deduplication are unchanged. The first
read builds exactly the old result and stores it; later reads return that view until an input changes.
Spell and mana ability views are deliberately excluded because they have a different dependency and
mutation model.

## Invalidation audit

Caching is correct only if every input mutation drops the affected view. The cache is therefore
invalidated at these boundaries:

| Input | Invalidation boundary |
|---|---|
| Raw triggers, statics and replacements | Their `CardState` add/remove mutators; `copyFrom`; `addAbilitiesFrom` |
| Layer 3/6 changed card traits | Set, add, remove and clear methods on `Card` |
| Perpetual trait removal | `LosePerpetualEffect` now uses `Card.removeChangedCardTraits` instead of mutating the exposed table directly |
| Keyword-derived traits | `updateKeywordsCache(CardState)` |
| Type-derived rules traits | `CardState.updateTypes` and card-wide `Card.updateTypeCache` |
| Counter-derived replacements | Both `setCounters` forms and `clearCounters` |
| State topology, clone layers and split-card merging | `setStates`, `addAlternateState`, `clearStates`, and card-wide invalidation across base and `CardCloneStates` maps |

The last three rows extend the original open-PR audit. In particular, a shield/stun/finality view
could otherwise survive `clearCounters`, a perpetual trait could be removed without touching the
cache, Original could retain traits from a removed split state, and an active cloned face could keep
a view that was absent from the base-state map.

Cached views hold only traits already owned by the same card/state. They are exposed through a
concrete unmodifiable `FCollectionView` facade: collection mutators and iterator removal throw
`UnsupportedOperationException`, so a caller cannot poison the retained result even by downcasting
or ignoring the read-only API convention. Game copies build their own states and do not share cached
collection objects.

Counter collections follow the same ownership boundary. Bulk counter assignment copies with
`HashMultiset.create`, and `getCounters()` exposes an unmodifiable live view. Consequently,
`target.setCounters(source.getCounters())` cannot make two cards share a counter bag and leave one
card's trait cache stale when the other changes.

Cache entries also carry an invalidation generation. Card state remains game-thread confined, but a
diagnostic or simulation read that overlaps a mutation cannot republish an obsolete rebuild as a
future cache hit: the entry's generation will no longer match. Mutations publish their new type,
keyword or counter input before advancing that generation.

## Measurement counters

Two counters make engagement visible in `report.json` and JFR decision events:

| Counter | Meaning |
|---|---|
| `traitCacheHits` | Getter calls served by a retained view |
| `traitCacheRebuilds` | Getter calls that rebuilt a view after first use or invalidation |

A useful run should have hits far above rebuilds. A board with unusually high rebuilds should be
profiled for mutation churn before extending this cache to any other derived state.

## Correctness tests

`forge.game.card.CardStateTraitCacheTest` verifies:

- all four views are reused and the hit/rebuild counters engage;
- every collection mutation surface, including iterator removal, is rejected without poisoning a
  retained view;
- adding and removing layer-derived triggers/statics/replacements changes every affected view;
- bulk assignment and clearing of shield, stun and finality counters rebuild the rules-host view but
  do not add those effects to the plain view;
- two cards cannot alias a counter bag or leave the second card's replacement cache stale;
- planeswalker, battle, Saga, Read ahead, Adventure and Omen transitions preserve the semantic
  difference between rules-host and plain caches;
- adding, mutating and removing a split state updates Original's merged trigger, static and
  replacement views;
- copy, add-abilities, bulk changed-trait, clear, perpetual and clone-state paths invalidate the
  destination views; and
- a deterministic concurrent interleaving cannot retain an obsolete rebuild.

The existing AI instrumentation test remains the end-to-end guard: an optimized build must produce
the same canonical game digest and byte-identical ordered decision trace as its baseline.

Local verification for this change ran the complete `forge-game` suite (18 tests) and compiled the
desktop application plus all 115 desktop test sources. The desktop AI fixture itself needs a display
server, which was unavailable in the build environment; behavior parity still has to pass the
fixed-seed trace comparison below before a timing result is accepted.

## Reproduction runbook

Build the merge base and this branch separately, then run the same fixed-seed corpus in fresh JVMs.
Correctness comes first:

```text
forge bench -d deck-a.dck -D res/geneticaidecks -n 20 -s 7 -t -o baseline
forge bench -d deck-a.dck -D res/geneticaidecks -n 20 -s 7 -t -o trait-cache
diff baseline/trace.jsonl trait-cache/trace.jsonl
```

Only after the trace diff is empty, repeat without `-t` on a quiet machine, alternate build order,
and compare `traitCacheHits`, `traitCacheRebuilds`, decision latency, total game time and allocation.
The historical 2.15x result is a hypothesis to reproduce, not the acceptance threshold.

## Post-merge validation

Independent fixed-seed validation of the merged cache change measured a 24.21% reduction in summed
game time, 17.74% lower wall time and 8.72% lower user CPU across the direct ABBA corpus. All eight
fixture winner/turn tuples matched, and measured cache-hit share was 99.596% to 99.869%. The broad
direct corpus measured 22.16% lower game time and 18.77% lower wall time. The serialized desktop
suite completed 361 tests with no failures and six skips.

The three-game Breya batch differed after game one, while isolated fixed-seed runs produced
byte-identical decision traces. The batch logs explain the difference: both baseline repetitions
hit four AI evaluation `TimeoutException`s during game one, while both optimized repetitions hit
none. The faster build therefore entered later games without the baseline's timeout-dependent
state; this is a time-budget effect rather than evidence that the cached builders changed rules or
AI choice semantics.
