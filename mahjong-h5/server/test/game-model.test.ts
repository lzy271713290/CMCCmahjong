import assert from "node:assert/strict";
import test from "node:test";
import { createFullTileSet, createInitialGame, drawTileFromWall, sortTiles, validateInitialGame } from "../src/game-model.js";

test("完整牌组包含34种牌且每种4张", () => {
  const tiles = createFullTileSet();
  const counts = new Map<string, number>();
  for (const tile of tiles) counts.set(tile.code, (counts.get(tile.code) ?? 0) + 1);
  assert.equal(tiles.length, 136);
  assert.equal(counts.size, 34);
  assert.equal([...counts.values()].every((count) => count === 4), true);
});

test("起手牌按万筒条和字牌稳定排序", () => {
  const sorted = sortTiles([
    { code: "white", copy: 0 },
    { code: "tiao-1", copy: 0 },
    { code: "wan-9", copy: 0 },
    { code: "wan-1", copy: 0 },
    { code: "tong-2", copy: 0 },
  ]);
  assert.deepEqual(sorted.map((tile) => tile.code), ["wan-1", "wan-9", "tong-2", "tiao-1", "white"]);
});

test("最小开局模型满足四人发牌和牌张守恒", () => {
  const game = createInitialGame([0, 1, 2, 3], 2, () => 0);
  assert.deepEqual([0, 1, 2, 3].map((seat) => game.hands.get(seat)?.length), [13, 13, 14, 13]);
  assert.equal(game.wall.length, 83);
  assert.doesNotThrow(() => validateInitialGame(game));
});

test("无操作响应后为下一家摸一张并记录独立摸牌", () => {
  const game = createInitialGame([0, 1, 2, 3], 0, () => 0);
  game.hands.get(0)!.pop();
  game.lastDraw = undefined;
  game.stage = "awaiting_reactions";

  const drawn = drawTileFromWall(game, 1);

  assert.ok(drawn);
  assert.equal(game.wall.length, 82);
  assert.equal(game.hands.get(1)?.length, 14);
  assert.equal(game.turnSeat, 1);
  assert.equal(game.stage, "awaiting_discard");
  assert.deepEqual(game.lastDraw, { seat: 1, tile: drawn });
});

test("牌墙耗尽时结束本局且不再产生摸牌", () => {
  const game = createInitialGame([0, 1, 2, 3], 0, () => 0);
  game.wall.length = 0;

  assert.equal(drawTileFromWall(game, 1), undefined);
  assert.equal(game.stage, "round_ended");
  assert.equal(game.lastDraw, undefined);
});
