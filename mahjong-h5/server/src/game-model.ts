import { randomInt } from "node:crypto";
import type { DiscardView, HonorTile, NumberedSuit, TileCode } from "../../shared/protocol.js";

export const GAME_MODEL_VERSION = "private-hands-v1";

export type Tile = {
  code: TileCode;
  copy: 0 | 1 | 2 | 3;
};

export type InitialGameState = {
  modelVersion: typeof GAME_MODEL_VERSION;
  roundNumber: 1;
  dealerSeat: number;
  turnSeat: number;
  stage: "awaiting_discard" | "awaiting_reactions";
  hands: Map<number, Tile[]>;
  wall: Tile[];
  discards: DiscardView[];
};

const NUMBERED_SUITS: NumberedSuit[] = ["wan", "tong", "tiao"];
const HONOR_TILES: HonorTile[] = ["east", "south", "west", "north", "red", "green", "white"];
const TILE_ORDER = new Map<TileCode, number>(
  [...NUMBERED_SUITS.flatMap((suit) => Array.from({ length: 9 }, (_, index) => `${suit}-${index + 1}` as TileCode)), ...HONOR_TILES].map(
    (code, index) => [code, index],
  ),
);

export function createFullTileSet(): Tile[] {
  const codes: TileCode[] = [];
  for (const suit of NUMBERED_SUITS) {
    for (let rank = 1; rank <= 9; rank += 1) codes.push(`${suit}-${rank}`);
  }
  codes.push(...HONOR_TILES);
  return codes.flatMap((code) => [0, 1, 2, 3].map((copy) => ({ code, copy: copy as Tile["copy"] })));
}

export function shuffleTiles(tiles: readonly Tile[], randomIndex: (maxExclusive: number) => number = randomInt): Tile[] {
  const shuffled = [...tiles];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    if (!Number.isInteger(swapIndex) || swapIndex < 0 || swapIndex > index) throw new Error("洗牌随机索引越界");
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

export function sortTiles(tiles: readonly Tile[]): Tile[] {
  return [...tiles].sort((left, right) => {
    const codeDifference = (TILE_ORDER.get(left.code) ?? 999) - (TILE_ORDER.get(right.code) ?? 999);
    return codeDifference || left.copy - right.copy;
  });
}

export function createInitialGame(
  playerSeats: readonly number[],
  dealerSeat: number,
  randomIndex: (maxExclusive: number) => number = randomInt,
): InitialGameState {
  const seats = [...playerSeats].sort((left, right) => left - right);
  if (seats.length !== 4 || new Set(seats).size !== 4 || seats.some((seat) => seat < 0 || seat > 3)) {
    throw new Error("初始化牌局需要四个不同的有效座位");
  }
  if (!seats.includes(dealerSeat)) throw new Error("庄家座位必须属于当前玩家");

  const wall = shuffleTiles(createFullTileSet(), randomIndex);
  const hands = new Map(seats.map((seat) => [seat, [] as Tile[]]));
  const draw = (seat: number, count: number): void => {
    const hand = hands.get(seat);
    if (!hand) throw new Error("发牌目标座位不存在");
    const tiles = wall.splice(0, count);
    if (tiles.length !== count) throw new Error("牌墙数量不足，无法完成发牌");
    hand.push(...tiles);
  };

  // 模拟线下发牌：三轮每人四张，再各发一张，庄家额外取得首张出牌。
  for (let round = 0; round < 3; round += 1) {
    for (const seat of seats) draw(seat, 4);
  }
  for (const seat of seats) draw(seat, 1);
  draw(dealerSeat, 1);

  const game: InitialGameState = {
    modelVersion: GAME_MODEL_VERSION,
    roundNumber: 1,
    dealerSeat,
    turnSeat: dealerSeat,
    stage: "awaiting_discard",
    hands,
    wall,
    discards: [],
  };
  validateInitialGame(game);
  return game;
}

export function validateInitialGame(game: InitialGameState): void {
  const allTiles = [...game.hands.values()].flat().concat(game.wall);
  const physicalTileIds = new Set(allTiles.map((tile) => `${tile.code}:${tile.copy}`));
  const handCounts = [...game.hands.entries()].map(([seat, hand]) => ({ seat, count: hand.length }));

  if (allTiles.length !== 136 || physicalTileIds.size !== 136) throw new Error("牌张守恒校验失败");
  if (game.wall.length !== 83) throw new Error("发牌后牌墙应剩余83张");
  if (handCounts.some(({ seat, count }) => count !== (seat === game.dealerSeat ? 14 : 13))) {
    throw new Error("起手牌数量校验失败");
  }
}
