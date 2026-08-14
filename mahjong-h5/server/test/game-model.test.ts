import assert from "node:assert/strict";
import test from "node:test";
import type { TileCode } from "../../shared/protocol.js";
import {
  canWinWithDiscard,
  createFullTileSet,
  createInitialGame,
  drawTileFromWall,
  drawTileFromWallEnd,
  findDiscardReactionOptions,
  selectReactionClaims,
  sortTiles,
  validateInitialGame,
  type Tile,
} from "../src/game-model.js";

function makeTiles(codes: TileCode[]): Tile[] {
  const copies = new Map<TileCode, number>();
  return codes.map((code) => {
    const copy = copies.get(code) ?? 0;
    copies.set(code, copy + 1);
    return { code, copy: copy as Tile["copy"] };
  });
}

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

test("杠后补牌从牌墙尾部取得并保持当前玩家出牌", () => {
  const game = createInitialGame([0, 1, 2, 3], 0, () => 0);
  const expected = game.wall.at(-1);
  const drawn = drawTileFromWallEnd(game, 2);
  assert.deepEqual(drawn, expected);
  assert.equal(game.wall.length, 82);
  assert.equal(game.turnSeat, 2);
  assert.equal(game.stage, "awaiting_discard");
});

test("只有弃牌者下家可以获得数字牌吃牌组合", () => {
  const hand = makeTiles(["wan-2", "wan-3", "tong-5"]);
  const discard = { seat: 0, tile: "wan-1" as const };
  const nextOptions = findDiscardReactionOptions(hand, 1, discard, [], 20);
  const otherOptions = findDiscardReactionOptions(hand, 2, discard, [], 20);
  assert.deepEqual(nextOptions.filter((option) => option.kind === "chi").map((option) => option.consumeTiles), [["wan-2", "wan-3"]]);
  assert.equal(otherOptions.some((option) => option.kind === "chi"), false);
  assert.equal(findDiscardReactionOptions(makeTiles(["east", "east"]), 1, { seat: 0, tile: "east" }, [], 20).some((option) => option.kind === "chi"), false);
});

test("碰和明杠按同牌数量产生且空牌墙禁止明杠", () => {
  const hand = makeTiles(["red", "red", "red", "wan-1"]);
  const discard = { seat: 0, tile: "red" as const };
  assert.deepEqual(
    findDiscardReactionOptions(hand, 2, discard, [], 20)
      .filter((option) => option.kind === "peng" || option.kind === "gang")
      .map((option) => option.kind),
    ["gang", "peng"],
  );
  assert.deepEqual(
    findDiscardReactionOptions(hand, 2, discard, [], 0)
      .filter((option) => option.kind === "peng" || option.kind === "gang")
      .map((option) => option.kind),
    ["peng"],
  );
});

test("普通胡校验三门齐全、一九面子和刻子门槛", () => {
  const winningHand = makeTiles([
    "wan-1", "wan-2", "wan-3",
    "tong-1", "tong-2", "tong-3",
    "tiao-1", "tiao-2", "tiao-3",
    "wan-9", "wan-9", "wan-9",
    "east",
  ]);
  assert.equal(canWinWithDiscard(winningHand, "east", []), true);
  assert.equal(canWinWithDiscard(winningHand.filter((tile) => !tile.code.startsWith("tiao-")).concat(makeTiles(["wan-4", "wan-5", "wan-6"])), "east", []), false);
});

test("七小对允许四张拆两对但仍要求三门和一九对子", () => {
  const hand = makeTiles([
    "wan-1", "wan-1", "wan-2", "wan-2",
    "tong-3", "tong-3", "tong-4", "tong-4",
    "tiao-5", "tiao-5", "tiao-6", "tiao-6",
    "east",
  ]);
  assert.equal(canWinWithDiscard(hand, "east", []), true);
  const noTerminalPair = hand.map((tile) => (tile.code === "wan-1" ? { ...tile, code: "wan-3" as const } : tile));
  assert.equal(canWinWithDiscard(noTerminalPair, "east", []), false);
});

test("弃牌响应严格按胡杠碰吃优先且保留一炮多响", () => {
  const option = (kind: "chi" | "peng" | "gang" | "hu") => ({ id: kind, kind, consumeTiles: [], displayTiles: [] });
  assert.deepEqual(
    selectReactionClaims([
      { seat: 1, option: option("chi") },
      { seat: 2, option: option("peng") },
      { seat: 3, option: option("gang") },
    ]).map((claim) => claim.option.kind),
    ["gang"],
  );
  assert.deepEqual(
    selectReactionClaims([
      { seat: 3, option: option("hu") },
      { seat: 0, option: option("gang") },
      { seat: 1, option: option("hu") },
    ]).map((claim) => claim.seat),
    [1, 3],
  );
});
