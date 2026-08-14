import { randomInt } from "node:crypto";
import type {
  DiscardView,
  HonorTile,
  MeldView,
  NumberedSuit,
  ReactionOption,
  RoundResultView,
  TileCode,
} from "../../shared/protocol.js";

export const GAME_MODEL_VERSION = "discard-reactions-v2";

export type Tile = {
  code: TileCode;
  copy: 0 | 1 | 2 | 3;
};

export type InitialGameState = {
  modelVersion: typeof GAME_MODEL_VERSION;
  roundNumber: 1;
  dealerSeat: number;
  turnSeat: number;
  stage: "awaiting_discard" | "awaiting_reactions" | "round_ended";
  hands: Map<number, Tile[]>;
  wall: Tile[];
  discards: DiscardView[];
  melds: Map<number, MeldView[]>;
  lastDraw?: { seat: number; tile: Tile };
  pendingReaction?: {
    discard: DiscardView;
    optionsBySeat: Map<number, ReactionOption[]>;
    responses: Map<number, string | "pass">;
  };
  roundResult?: RoundResultView;
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
  const draw = (seat: number, count: number): Tile[] => {
    const hand = hands.get(seat);
    if (!hand) throw new Error("发牌目标座位不存在");
    const tiles = wall.splice(0, count);
    if (tiles.length !== count) throw new Error("牌墙数量不足，无法完成发牌");
    hand.push(...tiles);
    return tiles;
  };

  // 模拟线下发牌：三轮每人四张，再各发一张，庄家额外取得首张出牌。
  for (let round = 0; round < 3; round += 1) {
    for (const seat of seats) draw(seat, 4);
  }
  for (const seat of seats) draw(seat, 1);
  const dealerDraw = draw(dealerSeat, 1)[0]!;

  const game: InitialGameState = {
    modelVersion: GAME_MODEL_VERSION,
    roundNumber: 1,
    dealerSeat,
    turnSeat: dealerSeat,
    stage: "awaiting_discard",
    hands,
    wall,
    discards: [],
    melds: new Map(seats.map((seat) => [seat, [] as MeldView[]])),
    lastDraw: { seat: dealerSeat, tile: dealerDraw },
  };
  validateInitialGame(game);
  return game;
}

export function drawTileFromWall(game: InitialGameState, seat: number): Tile | undefined {
  const tile = game.wall.shift();
  if (!tile) {
    game.stage = "round_ended";
    game.lastDraw = undefined;
    game.roundResult = { reason: "wall_exhausted", winnerSeats: [] };
    return undefined;
  }
  const hand = game.hands.get(seat);
  if (!hand) throw new Error("摸牌目标座位不存在");
  hand.push(tile);
  game.turnSeat = seat;
  game.stage = "awaiting_discard";
  game.lastDraw = { seat, tile };
  return tile;
}

export function drawTileFromWallEnd(game: InitialGameState, seat: number): Tile | undefined {
  const tile = game.wall.pop();
  if (!tile) {
    game.stage = "round_ended";
    game.lastDraw = undefined;
    game.roundResult = { reason: "wall_exhausted", winnerSeats: [] };
    return undefined;
  }
  const hand = game.hands.get(seat);
  if (!hand) throw new Error("补牌目标座位不存在");
  hand.push(tile);
  game.turnSeat = seat;
  game.stage = "awaiting_discard";
  game.lastDraw = { seat, tile };
  return tile;
}

export function findDiscardReactionOptions(
  hand: readonly Tile[],
  seat: number,
  discard: DiscardView,
  melds: readonly MeldView[],
  wallRemaining: number,
): ReactionOption[] {
  if (seat === discard.seat) return [];
  const counts = countCodes(hand.map((tile) => tile.code));
  const options: ReactionOption[] = [];

  if (canWinWithDiscard(hand, discard.tile, melds)) {
    options.push({ id: "hu", kind: "hu", consumeTiles: [], displayTiles: [discard.tile] });
  }
  if ((counts.get(discard.tile) ?? 0) >= 3 && wallRemaining > 0) {
    const consumeTiles = [discard.tile, discard.tile, discard.tile];
    options.push({ id: `gang:${discard.tile}`, kind: "gang", consumeTiles, displayTiles: [...consumeTiles, discard.tile] });
  }
  if ((counts.get(discard.tile) ?? 0) >= 2) {
    const consumeTiles = [discard.tile, discard.tile];
    options.push({ id: `peng:${discard.tile}`, kind: "peng", consumeTiles, displayTiles: [...consumeTiles, discard.tile] });
  }

  if (seat === (discard.seat + 1) % 4) {
    const [suit, rawRank] = discard.tile.split("-");
    const rank = Number(rawRank);
    if ((suit === "wan" || suit === "tong" || suit === "tiao") && Number.isInteger(rank)) {
      for (const ranks of [
        [rank - 2, rank - 1],
        [rank - 1, rank + 1],
        [rank + 1, rank + 2],
      ]) {
        if (ranks.some((candidate) => candidate < 1 || candidate > 9)) continue;
        const consumeTiles = ranks.map((candidate) => `${suit}-${candidate}` as TileCode);
        if (consumeTiles.every((code) => (counts.get(code) ?? 0) >= consumeTiles.filter((candidate) => candidate === code).length)) {
          const displayTiles = [...consumeTiles, discard.tile].sort(tileCodeComparator);
          options.push({ id: `chi:${consumeTiles.join("+")}`, kind: "chi", consumeTiles, displayTiles });
        }
      }
    }
  }
  return options;
}

export type ReactionClaim = { seat: number; option: ReactionOption };

export function selectReactionClaims(claims: readonly ReactionClaim[]): ReactionClaim[] {
  const huClaims = claims.filter((claim) => claim.option.kind === "hu");
  if (huClaims.length > 0) return [...huClaims].sort((left, right) => left.seat - right.seat);
  const priority: Record<ReactionOption["kind"], number> = { hu: 4, gang: 3, peng: 2, chi: 1 };
  const selected = [...claims].sort((left, right) => priority[right.option.kind] - priority[left.option.kind])[0];
  return selected ? [selected] : [];
}

export function canWinWithDiscard(hand: readonly Tile[], incoming: TileCode, melds: readonly MeldView[]): boolean {
  const concealedCodes = hand.map((tile) => tile.code).concat(incoming);
  const allCodes = concealedCodes.concat(melds.flatMap((meld) => meld.tiles));
  if (!NUMBERED_SUITS.every((suit) => allCodes.some((code) => code.startsWith(`${suit}-`)))) return false;

  if (melds.length === 0 && isSevenPairs(concealedCodes)) return true;
  const groupsNeeded = 4 - melds.length;
  if (groupsNeeded < 0 || concealedCodes.length !== groupsNeeded * 3 + 2) return false;

  const exposed = melds.reduce(
    (stats, meld) => {
      if (meld.kind === "gang") stats.hasGang = true;
      if (meld.kind === "peng" || meld.kind === "gang") {
        stats.hasTriplet = true;
        if (isHonor(meld.tiles[0]!)) stats.hasHonorTriplet = true;
      }
      if (meld.tiles.some(isTerminal)) stats.hasTerminalMeld = true;
      return stats;
    },
    { hasGang: false, hasTriplet: false, hasHonorTriplet: false, hasTerminalMeld: false },
  );
  const counts = countCodes(concealedCodes);

  for (const [pairCode, count] of counts) {
    if (count < 2) continue;
    counts.set(pairCode, count - 2);
    const decompositions = collectGroupStats(counts, groupsNeeded);
    counts.set(pairCode, count);
    if (
      decompositions.some((closed) => {
        const hasGang = exposed.hasGang;
        const terminalSatisfied = hasGang || exposed.hasTerminalMeld || exposed.hasHonorTriplet || closed.hasTerminalMeld || closed.hasHonorTriplet;
        const tripletSatisfied = hasGang || exposed.hasTriplet || closed.hasTriplet;
        return terminalSatisfied && tripletSatisfied;
      })
    ) {
      return true;
    }
  }
  return false;
}

type GroupStats = { hasTriplet: boolean; hasHonorTriplet: boolean; hasTerminalMeld: boolean };

function collectGroupStats(counts: Map<TileCode, number>, groupsRemaining: number, stats: GroupStats = emptyGroupStats()): GroupStats[] {
  const nextCode = [...TILE_ORDER.keys()].find((code) => (counts.get(code) ?? 0) > 0);
  if (!nextCode) return groupsRemaining === 0 ? [stats] : [];
  if (groupsRemaining <= 0) return [];
  const results: GroupStats[] = [];
  const count = counts.get(nextCode) ?? 0;

  if (count >= 3) {
    counts.set(nextCode, count - 3);
    results.push(
      ...collectGroupStats(counts, groupsRemaining - 1, {
        hasTriplet: true,
        hasHonorTriplet: stats.hasHonorTriplet || isHonor(nextCode),
        hasTerminalMeld: stats.hasTerminalMeld || isTerminal(nextCode),
      }),
    );
    counts.set(nextCode, count);
  }

  const [suit, rawRank] = nextCode.split("-");
  const rank = Number(rawRank);
  if ((suit === "wan" || suit === "tong" || suit === "tiao") && rank <= 7) {
    const second = `${suit}-${rank + 1}` as TileCode;
    const third = `${suit}-${rank + 2}` as TileCode;
    if ((counts.get(second) ?? 0) > 0 && (counts.get(third) ?? 0) > 0) {
      counts.set(nextCode, count - 1);
      counts.set(second, (counts.get(second) ?? 0) - 1);
      counts.set(third, (counts.get(third) ?? 0) - 1);
      results.push(
        ...collectGroupStats(counts, groupsRemaining - 1, {
          ...stats,
          hasTerminalMeld: stats.hasTerminalMeld || rank === 1 || rank + 2 === 9,
        }),
      );
      counts.set(nextCode, count);
      counts.set(second, (counts.get(second) ?? 0) + 1);
      counts.set(third, (counts.get(third) ?? 0) + 1);
    }
  }
  return results;
}

function isSevenPairs(codes: readonly TileCode[]): boolean {
  if (codes.length !== 14) return false;
  const counts = countCodes(codes);
  if ([...counts.values()].some((count) => count % 2 !== 0)) return false;
  const pairCount = [...counts.values()].reduce((sum, count) => sum + count / 2, 0);
  return pairCount === 7 && [...counts.entries()].some(([code, count]) => count >= 2 && isTerminal(code));
}

function countCodes(codes: readonly TileCode[]): Map<TileCode, number> {
  const counts = new Map<TileCode, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return counts;
}

function tileCodeComparator(left: TileCode, right: TileCode): number {
  return (TILE_ORDER.get(left) ?? 999) - (TILE_ORDER.get(right) ?? 999);
}

function emptyGroupStats(): GroupStats {
  return { hasTriplet: false, hasHonorTriplet: false, hasTerminalMeld: false };
}

function isHonor(code: TileCode): boolean {
  return !code.includes("-");
}

function isTerminal(code: TileCode): boolean {
  return code.endsWith("-1") || code.endsWith("-9");
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
