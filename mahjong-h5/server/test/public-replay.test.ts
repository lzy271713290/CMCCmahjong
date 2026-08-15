import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_REPLAY_FORMAT, parsePublicReplay } from "../../client/src/public-replay.js";

function validRecord(): Record<string, unknown> {
  return {
    format: PUBLIC_REPLAY_FORMAT,
    exportedAt: "2026-08-15T08:00:00.000Z",
    roomCode: "123456",
    modelVersion: "replay-ready-v11",
    players: [
      { name: "东家", seat: 0, isTestPlayer: false },
      { name: "南家", seat: 1, isTestPlayer: false },
      { name: "西家", seat: 2, isTestPlayer: false },
      { name: "北家", seat: 3, isTestPlayer: false },
    ],
    scoreTotals: [1, -1, 0, 0],
    publicActions: [
      { sequence: 1, kind: "round_started", roundNumber: 1, seat: 0 },
      { sequence: 2, kind: "discard", roundNumber: 1, seat: 0, tile: "wan-1" },
      { sequence: 3, kind: "peng", roundNumber: 1, seat: 1, fromSeat: 0, tile: "wan-1" },
    ],
  };
}

test("公共记录解析器接受标准导出并只返回安全公开字段", () => {
  const raw = validRecord();
  raw.untrustedExtra = { ignored: true };
  const parsed = parsePublicReplay(JSON.stringify(raw));
  assert.equal(parsed.format, PUBLIC_REPLAY_FORMAT);
  assert.equal(parsed.roomCode, "123456");
  assert.deepEqual(parsed.scoreTotals, [1, -1, 0, 0]);
  assert.deepEqual(parsed.publicActions.map((action) => action.kind), ["round_started", "discard", "peng"]);
  assert.equal("untrustedExtra" in parsed, false);
});

test("公共记录解析器拒绝嵌套私有手牌和身份令牌", () => {
  const withHand = validRecord();
  withHand.match = { nested: { selfHand: ["wan-1"] } };
  assert.throws(() => parsePublicReplay(JSON.stringify(withHand)), /selfHand/);

  const withToken = validRecord();
  withToken.players = [{ name: "东家", seat: 0, isTestPlayer: false, playerToken: "secret" }];
  assert.throws(() => parsePublicReplay(JSON.stringify(withToken)), /playerToken/);
});

test("公共记录解析器拒绝乱序动作、非法牌面和重复座位", () => {
  const unordered = validRecord();
  unordered.publicActions = [{ sequence: 2, kind: "discard" }, { sequence: 1, kind: "discard" }];
  assert.throws(() => parsePublicReplay(JSON.stringify(unordered)), /递增正整数/);

  const invalidTile = validRecord();
  invalidTile.publicActions = [{ sequence: 1, kind: "discard", tile: "wan-10" }];
  assert.throws(() => parsePublicReplay(JSON.stringify(invalidTile)), /牌面无效/);

  const duplicateSeats = validRecord();
  duplicateSeats.players = [
    { name: "甲", seat: 0, isTestPlayer: false },
    { name: "乙", seat: 0, isTestPlayer: false },
  ];
  assert.throws(() => parsePublicReplay(JSON.stringify(duplicateSeats)), /座位重复/);
});

test("公共记录解析器限制文件大小和动作数量", () => {
  assert.throws(() => parsePublicReplay(`{"padding":"${"x".repeat(1_000_001)}"}`), /1MB/);
  const tooMany = validRecord();
  tooMany.publicActions = Array.from({ length: 5_001 }, (_, index) => ({ sequence: index + 1, kind: "discard" }));
  assert.throws(() => parsePublicReplay(JSON.stringify(tooMany)), /5000/);
});
