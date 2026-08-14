import assert from "node:assert/strict";
import test from "node:test";
import type { MeldView } from "../../shared/protocol.js";
import type { WinningAnalysis } from "../src/game-model.js";
import { calculateHuPayments, calculateKongPayments, calculateScoreDeltas } from "../src/scoring.js";

const plainClosed: WinningAnalysis = {
  valid: true,
  isClosed: true,
  isSevenPairs: false,
  isPengPengHu: false,
  isSanBuLao: false,
};

function emptyMelds(): Map<number, MeldView[]> {
  return new Map([[0, []], [1, []], [2, []], [3, []]]);
}

test("庄家闭门点炮胡按付款者分别叠加倍数", () => {
  const result = calculateHuPayments({
    winnerSeats: [1],
    fromSeat: 0,
    dealerSeat: 1,
    reason: "discard_hu",
    analyses: new Map([[1, plainClosed]]),
    meldsBySeat: emptyMelds(),
  });
  assert.deepEqual(result.payments, [
    { fromSeat: 0, toSeat: 1, amount: 32, reason: "discard_hu" },
    { fromSeat: 2, toSeat: 1, amount: 16, reason: "discard_hu" },
    { fromSeat: 3, toSeat: 1, amount: 16, reason: "discard_hu" },
  ]);
  assert.deepEqual(calculateScoreDeltas(result.payments), [-32, 64, -16, -16]);
});

test("闲家闭门自摸时庄家支付额外庄家倍数", () => {
  const result = calculateHuPayments({
    winnerSeats: [1],
    dealerSeat: 0,
    reason: "self_draw_hu",
    analyses: new Map([[1, plainClosed]]),
    meldsBySeat: emptyMelds(),
  });
  assert.deepEqual(result.payments.map((payment) => [payment.fromSeat, payment.amount]), [[0, 32], [2, 16], [3, 16]]);
});

test("碰碰胡和三不烙可以与闭门连续相乘", () => {
  const result = calculateHuPayments({
    winnerSeats: [1],
    fromSeat: 0,
    dealerSeat: 3,
    reason: "rob_kong_hu",
    analyses: new Map([[1, { ...plainClosed, isPengPengHu: true, isSanBuLao: true }]]),
    meldsBySeat: emptyMelds(),
  });
  assert.equal(result.payments.find((payment) => payment.fromSeat === 0)?.amount, 64);
  assert.equal(result.payments.find((payment) => payment.fromSeat === 3)?.amount, 64);
});

test("一炮多响时只有点炮者分别向赢家支付", () => {
  const openWinner: WinningAnalysis = { ...plainClosed, isClosed: false };
  const melds = emptyMelds();
  melds.set(1, [{ seat: 1, kind: "chi", tiles: ["wan-1", "wan-2", "wan-3"], fromSeat: 0 }]);
  melds.set(2, [{ seat: 2, kind: "peng", tiles: ["east", "east", "east"], fromSeat: 3 }]);
  const result = calculateHuPayments({
    winnerSeats: [1, 2],
    fromSeat: 0,
    dealerSeat: 3,
    reason: "discard_hu",
    analyses: new Map([[1, openWinner], [2, openWinner]]),
    meldsBySeat: melds,
  });
  assert.deepEqual(result.payments.map((payment) => [payment.fromSeat, payment.toSeat, payment.amount]), [[0, 1, 8], [0, 2, 8]]);
});

test("普通杠、暗杠、特殊杠和涨毛使用独立固定杠分", () => {
  assert.deepEqual(calculateKongPayments(1, "ming_gang").map((payment) => payment.amount), [2, 2, 2]);
  assert.deepEqual(calculateKongPayments(1, "jia_gang").map((payment) => payment.amount), [2, 2, 2]);
  assert.deepEqual(calculateKongPayments(1, "special_gang").map((payment) => payment.amount), [2, 2, 2]);
  assert.deepEqual(calculateKongPayments(1, "an_gang").map((payment) => payment.amount), [4, 4, 4]);
  assert.deepEqual(calculateKongPayments(1, "zhangmao").map((payment) => payment.amount), [1, 1, 1]);
  assert.deepEqual(calculateScoreDeltas(calculateKongPayments(1, "an_gang")), [-4, 12, -4, -4]);
});
