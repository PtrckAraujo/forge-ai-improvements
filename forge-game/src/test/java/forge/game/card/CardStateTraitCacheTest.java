/*
 * Forge: Play Magic: the Gathering.
 * Copyright (C) 2011  Forge Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
package forge.game.card;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import com.google.common.collect.HashBasedTable;
import com.google.common.collect.HashMultiset;
import com.google.common.collect.Multiset;
import com.google.common.collect.Table;
import org.testng.Assert;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import forge.card.CardStateName;
import forge.card.CardType;
import forge.game.replacement.ReplacementEffect;
import forge.game.replacement.ReplacementHandler;
import forge.game.card.perpetual.PerpetualInterface;
import forge.game.staticability.StaticAbility;
import forge.game.trigger.Trigger;
import forge.game.trigger.TriggerHandler;
import forge.util.Localizer;
import forge.util.collect.FCollectionView;
import forge.util.perf.PerfCounter;
import forge.util.perf.PerfProbe;

/** Correctness and engagement tests for the per-CardState derived-trait caches. */
public class CardStateTraitCacheTest {
    private static void assertUnsupported(final Runnable mutation) {
        try {
            mutation.run();
            Assert.fail("cached trait views must reject collection mutations");
        } catch (UnsupportedOperationException expected) {
            // expected
        }
    }

    @BeforeClass
    public void initializeLocalization() {
        Path languages = Path.of("forge-gui", "res", "languages").toAbsolutePath();
        if (!Files.isDirectory(languages)) {
            languages = Path.of("..", "forge-gui", "res", "languages").toAbsolutePath();
        }
        Localizer.getInstance().initialize("en-US", languages.toString());
    }

    @AfterMethod
    public void restoreProbeState() {
        PerfProbe.reset();
    }

    @Test
    public void repeatedReadsReuseAllFourDerivedViews() {
        final Card card = new Card(1, null);

        PerfProbe.reset();
        PerfProbe.setEnabled(true);
        try {
            final FCollectionView<Trigger> triggers = card.getTriggers();
            final FCollectionView<StaticAbility> statics = card.getStaticAbilities();
            final FCollectionView<ReplacementEffect> replacements = card.getReplacementEffects();
            final FCollectionView<ReplacementEffect> plainReplacements =
                    card.getCurrentState().getReplacementEffects(false);

            Assert.assertSame(card.getTriggers(), triggers);
            Assert.assertSame(card.getStaticAbilities(), statics);
            Assert.assertSame(card.getReplacementEffects(), replacements);
            Assert.assertSame(card.getCurrentState().getReplacementEffects(false), plainReplacements);
            Assert.assertNotSame(replacements, plainReplacements,
                    "rules-host and plain replacement views have different semantics");
        } finally {
            PerfProbe.setEnabled(false);
        }

        Assert.assertEquals(PerfProbe.getGlobal().get(PerfCounter.TRAIT_CACHE_REBUILDS), 4L);
        Assert.assertEquals(PerfProbe.getGlobal().get(PerfCounter.TRAIT_CACHE_HITS), 4L);
    }

    @Test
    public void cachedViewsRejectEveryCollectionMutation() {
        final Card card = new Card(1, null);
        final CardState state = card.getCurrentState();
        final Trigger trigger = TriggerHandler.parseTrigger(
                "Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield",
                card, false, state);
        final StaticAbility staticAbility = StaticAbility.create(
                "Mode$ Continuous | Affected$ Card.Self | AddPower$ 1", card, state, false);
        final ReplacementEffect replacement = ReplacementHandler.parseReplacement(
                "Event$ Moved | ValidCard$ Card.Self | Destination$ Battlefield "
                        + "| ReplacementResult$ NotReplaced | Description$ Test replacement.",
                card, false);
        state.addTrigger(trigger);
        state.addStaticAbility(staticAbility);
        state.addReplacementEffect(replacement);

        final FCollectionView<Trigger> triggers = state.getTriggers();
        final FCollectionView<StaticAbility> statics = state.getStaticAbilities();
        final FCollectionView<ReplacementEffect> replacements = state.getReplacementEffects();
        final FCollectionView<ReplacementEffect> plainReplacements =
                state.getReplacementEffects(false);

        assertUnsupported(() -> triggers.add(trigger));
        assertUnsupported(() -> triggers.remove(trigger));
        assertUnsupported(() -> triggers.addAll(List.of(trigger)));
        assertUnsupported(() -> triggers.removeAll(List.of(trigger)));
        assertUnsupported(() -> triggers.retainAll(Collections.emptyList()));
        assertUnsupported(() -> triggers.removeIf(item -> true));
        assertUnsupported(triggers::clear);
        final Iterator<Trigger> iterator = triggers.iterator();
        Assert.assertSame(iterator.next(), trigger);
        assertUnsupported(iterator::remove);
        assertUnsupported(statics::clear);
        assertUnsupported(replacements::clear);
        assertUnsupported(plainReplacements::clear);

        Assert.assertSame(state.getTriggers(), triggers);
        Assert.assertSame(state.getStaticAbilities(), statics);
        Assert.assertSame(state.getReplacementEffects(), replacements);
        Assert.assertSame(state.getReplacementEffects(false), plainReplacements);
        Assert.assertTrue(triggers.contains(trigger));
        Assert.assertTrue(statics.contains(staticAbility));
        Assert.assertTrue(replacements.contains(replacement));
    }

    @Test
    public void changedTraitLayersInvalidateEveryDerivedView() {
        final Card card = new Card(1, null);
        final CardState state = card.getCurrentState();

        final FCollectionView<Trigger> triggersBefore = card.getTriggers();
        final FCollectionView<StaticAbility> staticsBefore = card.getStaticAbilities();
        final FCollectionView<ReplacementEffect> replacementsBefore = card.getReplacementEffects();

        final Trigger trigger = TriggerHandler.parseTrigger(
                "Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield",
                card, false, state);
        final StaticAbility staticAbility = StaticAbility.create(
                "Mode$ Continuous | Affected$ Card.Self | AddPower$ 1", card, state, false);
        final ReplacementEffect replacement = ReplacementHandler.parseReplacement(
                "Event$ Moved | ValidCard$ Card.Self | Destination$ Battlefield "
                        + "| ReplacementResult$ NotReplaced | Description$ Test replacement.",
                card, false);
        final long timestamp = 17L;

        card.addChangedCardTraits(new CardTraitChanges(null, List.of(trigger), List.of(replacement),
                List.of(staticAbility), null), timestamp, 0L, false);

        final FCollectionView<Trigger> triggersWithChange = card.getTriggers();
        final FCollectionView<StaticAbility> staticsWithChange = card.getStaticAbilities();
        final FCollectionView<ReplacementEffect> replacementsWithChange = card.getReplacementEffects();
        Assert.assertNotSame(triggersWithChange, triggersBefore);
        Assert.assertNotSame(staticsWithChange, staticsBefore);
        Assert.assertNotSame(replacementsWithChange, replacementsBefore);
        Assert.assertTrue(triggersWithChange.contains(trigger));
        Assert.assertTrue(staticsWithChange.contains(staticAbility));
        Assert.assertTrue(replacementsWithChange.contains(replacement));

        Assert.assertTrue(card.removeChangedCardTraits(timestamp, 0L));
        Assert.assertFalse(card.getTriggers().contains(trigger));
        Assert.assertFalse(card.getStaticAbilities().contains(staticAbility));
        Assert.assertFalse(card.getReplacementEffects().contains(replacement));
    }

    @Test
    public void clearingCountersDropsGeneratedReplacementEffects() {
        final Card card = new Card(1, null);

        final FCollectionView<ReplacementEffect> withoutShield = card.getReplacementEffects();
        card.setCounters(CounterEnumType.SHIELD, 1);
        final FCollectionView<ReplacementEffect> withShield = card.getReplacementEffects();
        Assert.assertNotSame(withShield, withoutShield);
        Assert.assertTrue(withShield.anyMatch(replacement -> replacement.hasParam("ShieldCounter")),
                "a shield counter must add its destroy replacement");

        card.clearCounters();
        final FCollectionView<ReplacementEffect> cleared = card.getReplacementEffects();
        Assert.assertNotSame(cleared, withShield);
        Assert.assertFalse(cleared.anyMatch(replacement -> replacement.hasParam("ShieldCounter")),
                "clearing counters must not leave a cached shield replacement behind");
    }

    @Test
    public void bulkCountersAreOwnedAndInvalidateEveryGeneratedReplacement() {
        final Card card = new Card(1, null);
        final Multiset<CounterType> supplied = HashMultiset.create();
        supplied.add(CounterEnumType.SHIELD);
        supplied.add(CounterEnumType.STUN);
        supplied.add(CounterEnumType.FINALITY);

        // Avoid the unrelated keyword-view refresh used when replacing an initially empty bag on
        // this deliberately data-less test card.
        card.setCounters(CounterEnumType.SHIELD, 1);
        card.setCounters(supplied);
        final FCollectionView<ReplacementEffect> rulesHost = card.getReplacementEffects();
        final FCollectionView<ReplacementEffect> plain =
                card.getCurrentState().getReplacementEffects(false);
        Assert.assertTrue(rulesHost.anyMatch(effect -> effect.hasParam("ShieldCounter")));
        Assert.assertTrue(hasDescription(rulesHost, "stun counter"));
        Assert.assertTrue(hasDescription(rulesHost, "exile it instead"));
        Assert.assertFalse(plain.anyMatch(effect -> effect.hasParam("ShieldCounter")));
        Assert.assertFalse(hasDescription(plain, "stun counter"));
        Assert.assertFalse(hasDescription(plain, "exile it instead"));

        supplied.clear();
        Assert.assertEquals(card.getCounters(CounterEnumType.SHIELD), 1,
                "setCounters must copy its mutable input");
        assertUnsupported(card.getCounters()::clear);

        card.setCounters(HashMultiset.create());
        final FCollectionView<ReplacementEffect> cleared = card.getReplacementEffects();
        Assert.assertNotSame(cleared, rulesHost);
        Assert.assertFalse(cleared.anyMatch(effect -> effect.hasParam("ShieldCounter")));
        Assert.assertFalse(hasDescription(cleared, "stun counter"));
        Assert.assertFalse(hasDescription(cleared, "exile it instead"));
    }

    @Test
    public void twoCardsCannotAliasCountersOrLeaveTheSecondCacheStale() {
        final Card first = new Card(1, null);
        final Card second = new Card(2, null);
        first.setCounters(CounterEnumType.SHIELD, 1);
        second.setCounters(CounterEnumType.SHIELD, 1);

        second.setCounters(first.getCounters());
        final FCollectionView<ReplacementEffect> secondWithShield = second.getReplacementEffects();
        Assert.assertTrue(secondWithShield.anyMatch(effect -> effect.hasParam("ShieldCounter")));

        first.clearCounters();
        Assert.assertEquals(second.getCounters(CounterEnumType.SHIELD), 1,
                "cards must not share a caller-owned counter multiset");
        Assert.assertSame(second.getReplacementEffects(), secondWithShield,
                "mutating the first card must not invalidate or corrupt the second card's cache");
        Assert.assertTrue(secondWithShield.anyMatch(effect -> effect.hasParam("ShieldCounter")));
    }

    @Test
    public void rulesHostAndPlainCachesPreserveGeneratedReplacementSemantics() {
        final Card card = new Card(1, null);
        final CardState state = card.getCurrentState();
        state.setBaseLoyalty("3");
        state.setType(new CardType(List.of("Planeswalker"), false));

        Assert.assertTrue(hasEtbCounter(state.getReplacementEffects(), "LOYALTY"));
        Assert.assertTrue(hasEtbCounter(state.getReplacementEffects(false), "LOYALTY"),
                "type-derived replacements are part of both cache variants");

        state.setBaseDefense("4");
        state.setType(new CardType(List.of("Battle"), false));
        Assert.assertTrue(hasEtbCounter(state.getReplacementEffects(), "DEFENSE"));
        Assert.assertTrue(hasEtbCounter(state.getReplacementEffects(false), "DEFENSE"));

        state.setType(new CardType(List.of("Enchantment"), false));
        state.addType("Saga");
        final FCollectionView<ReplacementEffect> sagaWithoutReadAhead =
                state.getReplacementEffects();
        Assert.assertTrue(hasEtbCounterAmount(sagaWithoutReadAhead, "LORE", "1"));
        state.addIntrinsicKeyword("Read ahead", true);
        card.updateKeywordsCache(state);
        final FCollectionView<ReplacementEffect> sagaWithReadAhead = state.getReplacementEffects();
        Assert.assertNotSame(sagaWithReadAhead, sagaWithoutReadAhead);
        Assert.assertFalse(hasEtbCounterAmount(sagaWithReadAhead, "LORE", "1"),
                "Read ahead must suppress the default one-lore-counter Saga replacement");
        Assert.assertTrue(hasEtbCounterAmount(sagaWithReadAhead, "LORE", "FinalChapterNr"));

        state.setType(new CardType(List.of("Instant"), false));
        state.addType("Adventure");
        Assert.assertTrue(hasDescription(state.getReplacementEffects(), "Adventure"));
        Assert.assertFalse(hasDescription(state.getReplacementEffects(false), "Adventure"));

        state.setType(new CardType(List.of("Sorcery"), false));
        state.addType("Omen");
        Assert.assertTrue(hasDescription(state.getReplacementEffects(), "Omen"));
        Assert.assertFalse(hasDescription(state.getReplacementEffects(false), "Omen"));
    }

    @Test
    public void splitStateTopologyAndMutationsInvalidateOriginal() {
        final Card card = new Card(1, null);
        final CardState original = card.getCurrentState();
        final FCollectionView<Trigger> beforeSplit = original.getTriggers();

        card.addAlternateState(CardStateName.LeftSplit, false);
        final CardState left = card.getState(CardStateName.LeftSplit);
        final Trigger leftTrigger = TriggerHandler.parseTrigger(
                "Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield",
                card, false, left);
        final StaticAbility leftStatic = StaticAbility.create(
                "Mode$ Continuous | Affected$ Card.Self | AddPower$ 1", card, left, false);
        final ReplacementEffect leftReplacement = ReplacementHandler.parseReplacement(
                "Event$ Moved | ValidCard$ Card.Self | Destination$ Battlefield "
                        + "| ReplacementResult$ NotReplaced | Description$ Split replacement.",
                card, false);
        Assert.assertTrue(left.addTrigger(leftTrigger));
        Assert.assertTrue(left.addStaticAbility(leftStatic));
        Assert.assertTrue(left.addReplacementEffect(leftReplacement));

        final FCollectionView<Trigger> withSplit = original.getTriggers();
        Assert.assertNotSame(withSplit, beforeSplit);
        Assert.assertTrue(withSplit.contains(leftTrigger),
                "Original must merge the raw traits of its split state");
        Assert.assertTrue(original.getStaticAbilities().contains(leftStatic));
        Assert.assertTrue(original.getReplacementEffects().contains(leftReplacement));

        card.clearStates(CardStateName.LeftSplit, false);
        Assert.assertFalse(original.getTriggers().contains(leftTrigger),
                "removing a split state must invalidate Original's merged view");
        Assert.assertFalse(original.getStaticAbilities().contains(leftStatic));
        Assert.assertFalse(original.getReplacementEffects().contains(leftReplacement));
    }

    @Test
    public void changedTraitsInvalidateEveryCloneState() {
        final Card card = new Card(1, null);
        final CardCloneStates cloneStates = new CardCloneStates(card, null);
        cloneStates.add(card.getCurrentState().copy(card, CardStateName.Original, false));
        card.getCloneStates().put(23L, cloneStates);
        final CardState clone = cloneStates.get(CardStateName.Original);

        final FCollectionView<Trigger> beforeChange = clone.getTriggers();
        final Trigger trigger = TriggerHandler.parseTrigger(
                "Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield",
                card, false, clone);
        card.addChangedCardTraits(new CardTraitChanges(null, List.of(trigger), null, null, null),
                29L, 0L, false);

        final FCollectionView<Trigger> afterChange = clone.getTriggers();
        Assert.assertNotSame(afterChange, beforeChange);
        Assert.assertTrue(afterChange.contains(trigger),
                "card-wide invalidation must include states held by CardCloneStates");
    }

    @Test
    public void copyAndAddAbilitiesInvalidateAllDestinationViews() {
        final Card source = new Card(1, null);
        final CardState sourceState = source.getCurrentState();
        final Trigger sourceTrigger = TriggerHandler.parseTrigger(
                "Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield",
                source, true, sourceState);
        final StaticAbility sourceStatic = StaticAbility.create(
                "Mode$ Continuous | Affected$ Card.Self | AddPower$ 1",
                source, sourceState, true);
        final ReplacementEffect sourceReplacement = ReplacementHandler.parseReplacement(
                "Event$ Moved | ValidCard$ Card.Self | Destination$ Battlefield "
                        + "| ReplacementResult$ NotReplaced | Description$ Copied replacement.",
                source, true);
        sourceState.addTrigger(sourceTrigger);
        sourceState.addStaticAbility(sourceStatic);
        sourceState.addReplacementEffect(sourceReplacement);

        final Card addedCard = new Card(2, null);
        final CardState addedState = addedCard.getCurrentState();
        final FCollectionView<Trigger> triggersBeforeAdd = addedState.getTriggers();
        final FCollectionView<StaticAbility> staticsBeforeAdd = addedState.getStaticAbilities();
        final FCollectionView<ReplacementEffect> replacementsBeforeAdd =
                addedState.getReplacementEffects();
        addedState.addAbilitiesFrom(sourceState, false);
        Assert.assertNotSame(addedState.getTriggers(), triggersBeforeAdd);
        Assert.assertNotSame(addedState.getStaticAbilities(), staticsBeforeAdd);
        Assert.assertNotSame(addedState.getReplacementEffects(), replacementsBeforeAdd);
        Assert.assertEquals(addedState.getTriggers().size(), 1);
        Assert.assertEquals(addedState.getStaticAbilities().size(), 1);
        Assert.assertTrue(hasDescription(addedState.getReplacementEffects(), "Copied replacement"));

        final Card copiedCard = new Card(3, null);
        final CardState copiedState = copiedCard.getCurrentState();
        final FCollectionView<Trigger> triggersBeforeCopy = copiedState.getTriggers();
        final FCollectionView<StaticAbility> staticsBeforeCopy = copiedState.getStaticAbilities();
        final FCollectionView<ReplacementEffect> replacementsBeforeCopy =
                copiedState.getReplacementEffects();
        copiedState.copyFrom(sourceState, false);
        Assert.assertNotSame(copiedState.getTriggers(), triggersBeforeCopy);
        Assert.assertNotSame(copiedState.getStaticAbilities(), staticsBeforeCopy);
        Assert.assertNotSame(copiedState.getReplacementEffects(), replacementsBeforeCopy);
        Assert.assertEquals(copiedState.getTriggers().size(), 1);
        Assert.assertEquals(copiedState.getStaticAbilities().size(), 1);
        Assert.assertTrue(hasDescription(copiedState.getReplacementEffects(), "Copied replacement"));
    }

    @Test
    public void bulkTraitSettersClearAndPerpetualApplicationInvalidateViews() {
        final Card card = new Card(1, null);
        final CardState state = card.getCurrentState();
        final Trigger trigger = TriggerHandler.parseTrigger(
                "Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield",
                card, false, state);
        final CardTraitChanges changes = new CardTraitChanges(
                null, List.of(trigger), null, null, null);

        final FCollectionView<Trigger> beforeByText = state.getTriggers();
        final Table<Long, Long, CardTraitChanges> byText = HashBasedTable.create();
        byText.put(41L, 0L, changes);
        card.setChangedCardTraitsByText(byText);
        Assert.assertNotSame(state.getTriggers(), beforeByText);
        Assert.assertEquals(state.getTriggers().size(), 1);
        Assert.assertTrue(card.clearChangedCardTraits());
        Assert.assertTrue(state.getTriggers().isEmpty());

        final FCollectionView<Trigger> beforeSet = state.getTriggers();
        final Table<Long, Long, ICardTraitChanges> setChanges = HashBasedTable.create();
        setChanges.put(42L, 0L, changes);
        card.setChangedCardTraits(setChanges);
        Assert.assertNotSame(state.getTriggers(), beforeSet);
        Assert.assertEquals(state.getTriggers().size(), 1);
        Assert.assertTrue(card.clearChangedCardTraits());

        final FCollectionView<Trigger> beforePerpetual = state.getTriggers();
        final PerpetualInterface perpetual = new PerpetualInterface() {
            @Override
            public long getTimestamp() {
                return 43L;
            }

            @Override
            public void applyEffect(final Card affected) {
                affected.addChangedCardTraits(changes.copy(affected, false), 43L, 0L, false);
            }
        };
        card.addPerpetual(perpetual);
        perpetual.applyEffect(card);
        Assert.assertNotSame(state.getTriggers(), beforePerpetual);
        Assert.assertEquals(state.getTriggers().size(), 1);
    }

    @Test
    public void obsoleteConcurrentRebuildCannotBeRepublished() throws InterruptedException {
        final BlockingCard card = new BlockingCard(1);
        final CardState state = card.getCurrentState();
        final AtomicReference<FCollectionView<Trigger>> overlappingResult = new AtomicReference<>();
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        final Thread reader = new Thread(() -> {
            try {
                overlappingResult.set(state.getTriggers());
            } catch (Throwable thrown) {
                failure.set(thrown);
            }
        });

        reader.start();
        Assert.assertTrue(card.rebuildStarted.await(5, TimeUnit.SECONDS));
        final Trigger addedDuringRebuild = TriggerHandler.parseTrigger(
                "Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield",
                card, false, state);
        Assert.assertTrue(state.addTrigger(addedDuringRebuild));
        card.blockRebuild = false;
        card.allowPublication.countDown();
        reader.join(5000);

        Assert.assertFalse(reader.isAlive());
        Assert.assertNull(failure.get());
        Assert.assertFalse(overlappingResult.get().contains(addedDuringRebuild));
        final FCollectionView<Trigger> current = state.getTriggers();
        Assert.assertTrue(current.contains(addedDuringRebuild));
        Assert.assertSame(state.getTriggers(), current,
                "the obsolete overlapping rebuild must not remain in the cache");
    }

    private static boolean hasEtbCounter(final FCollectionView<ReplacementEffect> effects,
            final String counterType) {
        return effects.anyMatch(effect -> effect.getOverridingAbility() != null
                && counterType.equals(effect.getOverridingAbility().getParam("CounterType")));
    }

    private static boolean hasEtbCounterAmount(final FCollectionView<ReplacementEffect> effects,
            final String counterType, final String amount) {
        return effects.anyMatch(effect -> effect.getOverridingAbility() != null
                && counterType.equals(effect.getOverridingAbility().getParam("CounterType"))
                && amount.equals(effect.getOverridingAbility().getParam("CounterNum")));
    }

    private static boolean hasDescription(final FCollectionView<ReplacementEffect> effects,
            final String descriptionFragment) {
        return effects.anyMatch(effect -> effect.hasParam("Description")
                && effect.getParam("Description").contains(descriptionFragment));
    }

    private static final class BlockingCard extends Card {
        private final CountDownLatch rebuildStarted = new CountDownLatch(1);
        private final CountDownLatch allowPublication = new CountDownLatch(1);
        private volatile boolean blockRebuild = true;

        private BlockingCard(final int id) {
            super(id, null);
        }

        @Override
        public void updateTriggers(final List<Trigger> result, final CardState state) {
            super.updateTriggers(result, state);
            if (!blockRebuild) {
                return;
            }
            rebuildStarted.countDown();
            try {
                if (!allowPublication.await(5, TimeUnit.SECONDS)) {
                    throw new AssertionError("timed out waiting to resume the trait-cache rebuild");
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new AssertionError(interrupted);
            }
        }
    }
}
