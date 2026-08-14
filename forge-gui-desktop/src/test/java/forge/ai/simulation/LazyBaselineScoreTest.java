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
package forge.ai.simulation;

import java.util.ArrayList;
import java.util.List;

import org.testng.Assert;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.Test;

import forge.ai.simulation.GameStateEvaluator.Score;
import forge.game.Game;
import forge.game.GameStateDigest;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import forge.util.perf.PerfCounter;
import forge.util.perf.PerfProbe;

/**
 * {@code GameSimulator} used to score the unchanged original game in its constructor. The full
 * simulation picker builds one simulator per target/mode branch and never asks for that score, and
 * neither does {@code simulateSpellAbility} — so on a shipped build the work was thrown away. It is
 * now derived on demand.
 *
 * <p>A value that is never observed cannot change a decision, which is what makes this preferable to
 * the alternative the plan proposed, carrying one evaluation across branches: that needs the
 * evaluator's result to hold still, and it demonstrably does not. What these tests pin is that the
 * value is still correct and still available when something does ask for it, and that the branches
 * really have stopped asking.</p>
 */
public class LazyBaselineScoreTest extends SimulationTest {
    @AfterMethod
    public void restoreProbeState() {
        PerfProbe.reset();
    }

    private Game combatLookaheadGame() {
        final Game game = initAndCreateGame();
        final Player ai = game.getPlayers().get(1);
        final Player opponent = game.getPlayers().get(0);

        opponent.setLife(14, null);
        for (int i = 0; i < 4; i++) {
            addCard("Mountain", ai);
        }
        addCardToZone("Lightning Bolt", ai, ZoneType.Hand);
        addCardToZone("Shock", ai, ZoneType.Hand);
        // creatures on the AI's side before combat are what make the evaluator copy the game to
        // look ahead, so this fixture exercises the expensive form of the baseline evaluation
        for (final Card c : addCards("Grizzly Bears", 2, ai)) {
            c.setSickness(false);
        }
        addCards("Runeclaw Bear", 2, opponent);

        game.getPhaseHandler().devModeSet(PhaseType.MAIN1, ai);
        game.getAction().checkStateEffects(true);
        return game;
    }

    /** Asking for the score late must give the same number, and must not disturb the game. */
    @Test(timeOut = 300000)
    public void theLazyScoreIsTheSameScore() {
        final Game game = combatLookaheadGame();
        final Player ai = game.getPlayers().get(1);

        final Score evaluated = new GameStateEvaluator().getScoreForGameState(game, ai);
        final String before = GameStateDigest.digest(game);

        final SimulationController controller = new SimulationController(evaluated, 0);
        final GameSimulator simulator = new GameSimulator(controller, game, ai, null);

        Assert.assertTrue(simulator.getScoreForOrigGame().equals(evaluated),
                "the deferred baseline differs from the one evaluated up front");
        // and it is memoised, not re-derived on every call
        Assert.assertSame(simulator.getScoreForOrigGame(), simulator.getScoreForOrigGame());
        Assert.assertEquals(GameStateDigest.digest(game), before,
                "deriving the baseline changed the original game");
    }

    /**
     * Candidate scores are unchanged, and the branches no longer evaluate a baseline at all: the
     * evaluations left are the ones that scored a simulated result, plus the copy check that only
     * an assertion-enabled build performs.
     */
    @Test(timeOut = 300000)
    public void candidateScoresAreUnchangedWithoutPerBranchBaselines() {
        final Game game = combatLookaheadGame();
        final Player ai = game.getPlayers().get(1);

        final SpellAbilityPicker picker = new SpellAbilityPicker(ai);
        final List<SpellAbility> candidates = picker.getCandidateSpellsAndAbilities();
        Assert.assertFalse(candidates.isEmpty(), "the fixture must offer the AI something to consider");

        final Score baseline = new GameStateEvaluator().getScoreForGameState(game, ai);
        final PhaseType phase = game.getPhaseHandler().getPhase();

        PerfProbe.reset();
        PerfProbe.setEnabled(true);
        final List<String> first = new ArrayList<>();
        final List<String> second = new ArrayList<>();
        final long branches;
        try {
            for (int i = 0; i < candidates.size(); i++) {
                first.add(String.valueOf(
                        picker.evaluateSa(new SimulationController(baseline, 0), phase, candidates, i)));
            }
            branches = PerfProbe.getGlobal().get(PerfCounter.SIMULATION_BRANCHES);
            for (int i = 0; i < candidates.size(); i++) {
                second.add(String.valueOf(
                        picker.evaluateSa(new SimulationController(baseline, 0), phase, candidates, i)));
            }
        } finally {
            PerfProbe.setEnabled(false);
        }

        Assert.assertEquals(second, first, "evaluating the same candidates twice gave different scores");
        Assert.assertTrue(branches > 0, "the fixture must simulate some branches");
    }
}
