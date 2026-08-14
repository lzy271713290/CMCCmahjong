import assert from "node:assert/strict";
import test from "node:test";
import { createFullTileSet, createInitialGame, validateInitialGame } from "../src/game-model.js";

test("完整牌组包含34种牌且每种4张", () => {
  const tiles = createFullTileSet();
  const counts = new Map<string, number>();
  for (const tile of tiles) counts.set(tile.code, (counts.get(tile.code) ?? 0) + 1);
  assert.equal(tiles.length, 136);
  assert.equal(counts.size, 34);
  assert.equal([...counts.values()].every((count) => count === 4), true);
});

test("最小开局模型满足四人发牌和牌张守恒", () => {
  const game = createInitialGame([0, 1, 2, 3], 2, () => 0);
  assert.deepEqual([0, 1, 2, 3].map((seat) => game.hands.get(seat)?.length), [13, 13, 14, 13]);
  assert.equal(game.wall.length, 83);
  assert.doesNotThrow(() => validateInitialGame(game));
});
