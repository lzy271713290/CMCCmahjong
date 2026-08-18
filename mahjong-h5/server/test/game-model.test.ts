import assert from "node:assert/strict";
import test from "node:test";
import type { MeldView, TileCode } from "../../shared/protocol.js";
import {
  analyzeWinningHand,
  canWinCompleteHand,
  canWinWithDiscard,
  createFullTileSet,
  createInitialGame,
  drawTileFromWall,
  drawTileFromWallEnd,
  findDiscardReactionOptions,
  findTurnOperationOptions,
  selectReactionClaims,
  sortTiles,
  validateInitialGame,
  wallCountsForGame,
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

test("普通摸牌先清空第一段牌墙再进入下一段", () => {
  const game = createInitialGame([0, 1, 2, 3], 0, () => 0);
  assert.deepEqual(wallCountsForGame(game), [21, 21, 21, 20]);

  for (let index = 0; index < 21; index += 1) {
    const drawn = drawTileFromWall(game, 1);
    assert.ok(drawn);
  }

  assert.deepEqual(wallCountsForGame(game), [0, 21, 21, 20]);
  assert.equal(game.wall.length, 62);
  assert.equal(game.wallFrontIndex, 0);

  const nextSegmentTile = drawTileFromWall(game, 1);
  assert.ok(nextSegmentTile);
  assert.deepEqual(wallCountsForGame(game), [0, 20, 21, 20]);
  assert.equal(game.wallFrontIndex, 1);
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

test("完整十四张手牌可以直接判定自摸", () => {
  const hand = makeTiles([
    "wan-1", "wan-2", "wan-3",
    "tong-1", "tong-2", "tong-3",
    "tiao-1", "tiao-2", "tiao-3",
    "wan-9", "wan-9", "wan-9",
    "east", "east",
  ]);
  assert.equal(canWinCompleteHand(hand, []), true);
  assert.deepEqual(findTurnOperationOptions(hand, 2, [], { seat: 2, tile: hand.at(-1)! }, 20).map((option) => option.kind), ["zimo"]);
  assert.equal(findTurnOperationOptions(hand, 2, [], { seat: 1, tile: hand.at(-1)! }, 20).some((option) => option.kind === "zimo"), false);
});

test("自回合候选包含暗杠和已有碰牌的加杠且空墙禁杠", () => {
  const hand = makeTiles(["wan-1", "wan-1", "wan-1", "wan-1", "red", "tong-2", "tiao-3"]);
  const melds = [{ seat: 0, kind: "peng" as const, tiles: ["red", "red", "red"] as TileCode[], fromSeat: 1 }];
  const options = findTurnOperationOptions(hand, 0, melds, undefined, 12);
  assert.deepEqual(options.map((option) => option.kind), ["angang", "jiagang"]);
  assert.equal(options.find((option) => option.kind === "angang")?.id, "angang:wan-1");
  assert.equal(options.find((option) => option.kind === "jiagang")?.id, "jiagang:0:red");
  assert.deepEqual(findTurnOperationOptions(hand, 0, melds, undefined, 0), []);
});

test("中发白和东南西北齐全时生成两种特殊杠候选", () => {
  const hand = makeTiles(["red", "green", "white", "east", "south", "west", "north", "wan-2"]);
  const options = findTurnOperationOptions(hand, 0, [], { seat: 0, tile: hand[2]! }, 20);
  assert.deepEqual(
    options.filter((option) => option.kind === "specialgang").map((option) => ({ id: option.id, tiles: option.tiles })),
    [
      { id: "specialgang:dragons", tiles: ["red", "green", "white"] },
      { id: "specialgang:winds", tiles: ["east", "south", "west", "north"] },
    ],
  );
  assert.equal(findTurnOperationOptions(hand, 0, [], undefined, 0).some((option) => option.kind === "specialgang"), false);
});

test("特殊杠成立后对应字牌逐张生成涨毛候选", () => {
  const hand = makeTiles(["red", "red", "north", "wan-2"]);
  const melds = [
    { seat: 0, kind: "special_gang" as const, specialType: "dragons" as const, tiles: ["red", "green", "white"] as TileCode[], fromSeat: 0, growthCount: 0 },
    { seat: 0, kind: "special_gang" as const, specialType: "winds" as const, tiles: ["east", "south", "west", "north"] as TileCode[], fromSeat: 0, growthCount: 0 },
  ];
  assert.deepEqual(
    findTurnOperationOptions(hand, 0, melds, undefined, 20).filter((option) => option.kind === "zhangmao").map((option) => option.id),
    ["zhangmao:0:red", "zhangmao:1:north"],
  );
});

test("特殊杠按一个有杠面子参与胡牌并豁免一九与刻子", () => {
  const concealed = makeTiles([
    "wan-2", "wan-3", "wan-4",
    "tong-2", "tong-3", "tong-4",
    "tiao-2", "tiao-3", "tiao-4",
    "east", "east",
  ]);
  const specialMeld = [{
    seat: 0,
    kind: "special_gang" as const,
    specialType: "dragons" as const,
    tiles: ["red", "green", "white"] as TileCode[],
    fromSeat: 0,
    growthCount: 0,
  }];
  assert.equal(canWinCompleteHand(concealed, specialMeld), true);
});

test("三组落地面子加手中中发白成组可以胡牌并豁免一九与刻子", () => {
  const hand = makeTiles(["wan-3", "wan-3", "red", "green"]);
  const melds = [
    { seat: 0, kind: "chi" as const, tiles: ["wan-1", "wan-2", "wan-3"] as TileCode[], fromSeat: 1 },
    { seat: 0, kind: "chi" as const, tiles: ["tong-1", "tong-2", "tong-3"] as TileCode[], fromSeat: 2 },
    { seat: 0, kind: "chi" as const, tiles: ["tiao-1", "tiao-2", "tiao-3"] as TileCode[], fromSeat: 3 },
  ];
  const analysis = analyzeWinningHand(hand, "white", melds);
  assert.equal(analysis.valid, true);
  assert.equal(analysis.isPengPengHu, false);
  assert.equal(analysis.isSanBuLao, false);
});

test("三组落地刻子加手中中发白成组保持三不烙", () => {
  const hand = makeTiles(["wan-9", "wan-9", "red", "green"]);
  const melds = [
    { seat: 0, kind: "peng" as const, tiles: ["wan-1", "wan-1", "wan-1"] as TileCode[], fromSeat: 1 },
    { seat: 0, kind: "peng" as const, tiles: ["tong-2", "tong-2", "tong-2"] as TileCode[], fromSeat: 2 },
    { seat: 0, kind: "peng" as const, tiles: ["tiao-3", "tiao-3", "tiao-3"] as TileCode[], fromSeat: 3 },
  ];
  const analysis = analyzeWinningHand(hand, "white", melds);
  assert.equal(analysis.valid, true);
  assert.equal(analysis.isSanBuLao, true);
});

test("中发白成组可豁免一九与刻子但仍不能缺门", () => {
  const hand = makeTiles(["wan-9", "wan-9", "red", "green"]);
  const melds = [
    { seat: 0, kind: "chi" as const, tiles: ["wan-1", "wan-2", "wan-3"] as TileCode[], fromSeat: 1 },
    { seat: 0, kind: "chi" as const, tiles: ["wan-4", "wan-5", "wan-6"] as TileCode[], fromSeat: 2 },
    { seat: 0, kind: "chi" as const, tiles: ["wan-7", "wan-8", "wan-9"] as TileCode[], fromSeat: 3 },
  ];
  assert.equal(analyzeWinningHand(hand, "white", melds).valid, false);
  assert.equal(canWinWithDiscard(hand, "white", melds), false);
});

test("东南西北四张不能作为成组参与胡牌", () => {
  const hand = makeTiles(["wan-3", "wan-3", "east", "south", "west", "north"]);
  const melds = [
    { seat: 0, kind: "chi" as const, tiles: ["wan-1", "wan-2", "wan-3"] as TileCode[], fromSeat: 1 },
    { seat: 0, kind: "chi" as const, tiles: ["tong-1", "tong-2", "tong-3"] as TileCode[], fromSeat: 2 },
    { seat: 0, kind: "chi" as const, tiles: ["tiao-1", "tiao-2", "tiao-3"] as TileCode[], fromSeat: 3 },
  ];
  assert.equal(analyzeWinningHand(hand, "white", melds).valid, false);
  assert.equal(canWinWithDiscard(hand, "white", melds), false);
});

test("中发白成组后手牌满足3n加1，n可以为0", () => {
  const meldSets: MeldView[][] = [
    [],
    [
      { seat: 0, kind: "chi" as const, tiles: ["tiao-1", "tiao-2", "tiao-3"] as TileCode[], fromSeat: 1 },
    ],
    [
      { seat: 0, kind: "chi" as const, tiles: ["tiao-1", "tiao-2", "tiao-3"] as TileCode[], fromSeat: 1 },
      { seat: 0, kind: "peng" as const, tiles: ["tong-2", "tong-2", "tong-2"] as TileCode[], fromSeat: 2 },
    ],
    [
      { seat: 0, kind: "chi" as const, tiles: ["tiao-1", "tiao-2", "tiao-3"] as TileCode[], fromSeat: 1 },
      { seat: 0, kind: "peng" as const, tiles: ["tong-2", "tong-2", "tong-2"] as TileCode[], fromSeat: 2 },
      { seat: 0, kind: "gang" as const, gangType: "ming" as const, tiles: ["wan-1", "wan-1", "wan-1", "wan-1"] as TileCode[], fromSeat: 3 },
    ],
  ];
  const hiddenSequences: TileCode[][] = [
    ["wan-1", "wan-2", "wan-3"],
    ["tong-1", "tong-2", "tong-3"],
    ["tiao-1", "tiao-2", "tiao-3"],
  ];
  for (let exposedCount = 0; exposedCount <= 3; exposedCount += 1) {
    const melds = meldSets[exposedCount]!;
    const sequences = hiddenSequences.slice(0, 4 - melds.length - 1).flat();
    const base: TileCode[] = [...sequences, "wan-9", "wan-9"];
    const hand = makeTiles([...base, "red", "green"]);
    const withWhite = makeTiles([...base, "red", "green", "white"]);
    assert.equal(hand.length, (4 - melds.length) * 3 + 1);
    assert.equal(withWhite.length, (4 - melds.length) * 3 + 2);
    assert.equal(analyzeWinningHand(withWhite, undefined, melds).valid, true);
  }
});

test("胡牌分析识别闭门和碰碰胡，但手牌暗刻不计入三不烙", () => {
  const hand = makeTiles([
    "wan-1", "wan-1", "wan-1",
    "tong-2", "tong-2", "tong-2",
    "tiao-3", "tiao-3", "tiao-3",
    "east", "east", "east",
    "wan-9", "wan-9",
  ]);
  assert.deepEqual(analyzeWinningHand(hand, undefined, []), {
    valid: true,
    isSevenPairs: false,
    isClosed: true,
    isPengPengHu: true,
    isSanBuLao: false,
  });
});

test("三不烙需要三组落地刻子，手牌暗刻不算", () => {
  const hand = makeTiles([
    "wan-1", "wan-1", "wan-1",
    "tong-2", "tong-2",
  ]);
  const melds = [
    { seat: 0, kind: "peng" as const, tiles: ["tiao-3", "tiao-3", "tiao-3"] as TileCode[], fromSeat: 1 },
    { seat: 0, kind: "peng" as const, tiles: ["east", "east", "east"] as TileCode[], fromSeat: 2 },
    { seat: 0, kind: "chi" as const, tiles: ["tong-3", "tong-4", "tong-5"] as TileCode[], fromSeat: 3 },
  ];
  assert.deepEqual(analyzeWinningHand(hand, undefined, melds), {
    valid: true,
    isSevenPairs: false,
    isClosed: false,
    isPengPengHu: false,
    isSanBuLao: false,
  });
});

test("三组落地刻子成立三不烙", () => {
  const hand = makeTiles([
    "wan-1", "wan-2", "wan-3",
    "tong-2", "tong-2",
  ]);
  const melds = [
    { seat: 0, kind: "peng" as const, tiles: ["tiao-3", "tiao-3", "tiao-3"] as TileCode[], fromSeat: 1 },
    { seat: 0, kind: "peng" as const, tiles: ["east", "east", "east"] as TileCode[], fromSeat: 2 },
    { seat: 0, kind: "peng" as const, tiles: ["red", "red", "red"] as TileCode[], fromSeat: 3 },
  ];
  assert.deepEqual(analyzeWinningHand(hand, undefined, melds), {
    valid: true,
    isSevenPairs: false,
    isClosed: false,
    isPengPengHu: false,
    isSanBuLao: true,
  });
});

test("七小对分析保持闭门但不重复标记碰碰胡和三不烙", () => {
  const hand = makeTiles([
    "wan-1", "wan-1", "wan-2", "wan-2",
    "tong-3", "tong-3", "tong-4", "tong-4",
    "tiao-5", "tiao-5", "tiao-6", "tiao-6",
    "east", "east",
  ]);
  assert.deepEqual(analyzeWinningHand(hand, undefined, []), {
    valid: true,
    isSevenPairs: true,
    isClosed: true,
    isPengPengHu: false,
    isSanBuLao: false,
  });
});
