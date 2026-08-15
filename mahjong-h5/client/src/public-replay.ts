import type { PublicActionKind, PublicActionView, TileCode } from "../../shared/protocol.js";

export const PUBLIC_REPLAY_FORMAT = "cmccmahjong-public-replay-v1" as const;

export type PublicReplayPlayer = {
  name: string;
  seat: number;
  isTestPlayer: boolean;
};

export type PublicReplayRecord = {
  format: typeof PUBLIC_REPLAY_FORMAT;
  exportedAt: string;
  roomCode: string;
  modelVersion?: string;
  players: PublicReplayPlayer[];
  scoreTotals: number[];
  publicActions: PublicActionView[];
};

const actionKinds = new Set<PublicActionKind>([
  "round_started", "discard", "chi", "peng", "ming_gang", "an_gang", "jia_gang",
  "special_gang", "zhangmao", "self_draw_hu", "discard_hu", "rob_kong_hu",
  "round_ended", "settlement_requested", "settlement_agreed", "settlement_rejected",
  "player_disconnected", "player_reconnected",
]);
const honorTiles = new Set(["east", "south", "west", "north", "red", "green", "white"]);
const privateKeys = new Set(["playerToken", "selfHand", "selfDrawnTile"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeat(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3;
}

function isTileCode(value: unknown): value is TileCode {
  if (typeof value !== "string") return false;
  if (honorTiles.has(value)) return true;
  return /^(wan|tong|tiao)-[1-9]$/.test(value);
}

function assertNoPrivateFields(value: unknown): void {
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.pop();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!isObject(current)) continue;
    for (const [key, child] of Object.entries(current)) {
      if (privateKeys.has(key)) throw new Error(`记录包含禁止导入的私有字段：${key}`);
      queue.push(child);
    }
  }
}

function parsePlayers(value: unknown): PublicReplayPlayer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error("玩家信息必须包含1至4个座位");
  const players = value.map((candidate) => {
    if (!isObject(candidate)) throw new Error("玩家信息格式错误");
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!name || name.length > 12 || !isSeat(candidate.seat) || typeof candidate.isTestPlayer !== "boolean") {
      throw new Error("玩家昵称、座位或类型无效");
    }
    return { name, seat: candidate.seat, isTestPlayer: candidate.isTestPlayer };
  });
  if (new Set(players.map((player) => player.seat)).size !== players.length) throw new Error("玩家座位重复");
  return players;
}

function parseOptionalSeat(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!isSeat(value)) throw new Error(`公开动作的${field}无效`);
  return value;
}

function parseActions(value: unknown): PublicActionView[] {
  if (!Array.isArray(value) || value.length > 5_000) throw new Error("公开动作数量无效或超过5000条限制");
  let lastSequence = 0;
  return value.map((candidate) => {
    if (!isObject(candidate) || !Number.isInteger(candidate.sequence) || Number(candidate.sequence) <= lastSequence) {
      throw new Error("公开动作序号必须为递增正整数");
    }
    if (typeof candidate.kind !== "string" || !actionKinds.has(candidate.kind as PublicActionKind)) {
      throw new Error("公开动作类型无效");
    }
    lastSequence = Number(candidate.sequence);
    const roundNumber = candidate.roundNumber === undefined
      ? undefined
      : Number.isInteger(candidate.roundNumber) && Number(candidate.roundNumber) > 0
        ? Number(candidate.roundNumber)
        : (() => { throw new Error("公开动作局数无效"); })();
    const seats = candidate.seats === undefined
      ? undefined
      : Array.isArray(candidate.seats) && candidate.seats.length <= 4 && candidate.seats.every(isSeat)
        ? [...new Set(candidate.seats)]
        : (() => { throw new Error("公开动作座位列表无效"); })();
    const tile = candidate.tile === undefined
      ? undefined
      : isTileCode(candidate.tile)
        ? candidate.tile
        : (() => { throw new Error("公开动作牌面无效"); })();
    return {
      sequence: lastSequence,
      kind: candidate.kind as PublicActionKind,
      roundNumber,
      seat: parseOptionalSeat(candidate.seat, "座位"),
      seats,
      fromSeat: parseOptionalSeat(candidate.fromSeat, "来源座位"),
      tile,
    };
  });
}

export function parsePublicReplay(text: string): PublicReplayRecord {
  if (new Blob([text]).size > 1_000_000) throw new Error("记录文件不能超过1MB");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("记录不是有效的JSON文件");
  }
  if (!isObject(raw)) throw new Error("记录根节点格式错误");
  assertNoPrivateFields(raw);
  if (raw.format !== PUBLIC_REPLAY_FORMAT) throw new Error("不支持的记录格式");
  if (typeof raw.exportedAt !== "string" || !Number.isFinite(Date.parse(raw.exportedAt))) throw new Error("记录导出时间无效");
  if (typeof raw.roomCode !== "string" || !/^\d{6}$/.test(raw.roomCode)) throw new Error("记录房间号无效");
  if (raw.modelVersion !== undefined && typeof raw.modelVersion !== "string") throw new Error("记录模型版本无效");
  if (!Array.isArray(raw.scoreTotals) || raw.scoreTotals.length !== 4 || raw.scoreTotals.some((score) => typeof score !== "number" || !Number.isFinite(score))) {
    throw new Error("记录总分格式无效");
  }
  return {
    format: PUBLIC_REPLAY_FORMAT,
    exportedAt: raw.exportedAt,
    roomCode: raw.roomCode,
    modelVersion: raw.modelVersion,
    players: parsePlayers(raw.players),
    scoreTotals: [...raw.scoreTotals] as number[],
    publicActions: parseActions(raw.publicActions),
  };
}
