import type { MeldView, ScoreFactor, ScorePaymentView, ScoreReason, WinnerScoreView } from "../../shared/protocol.js";
import { isClosedHand, type WinningAnalysis } from "./game-model.js";

type HuScoreInput = {
  winnerSeats: number[];
  fromSeat?: number;
  dealerSeat: number;
  reason: "self_draw_hu" | "discard_hu" | "rob_kong_hu";
  analyses: Map<number, WinningAnalysis>;
  meldsBySeat: Map<number, MeldView[]>;
};

export function calculateHuPayments(input: HuScoreInput): { payments: ScorePaymentView[]; winnerDetails: WinnerScoreView[] } {
  const winnerSet = new Set(input.winnerSeats);
  const isMultiWin = input.winnerSeats.length > 1;
  const paymentReason: ScoreReason = input.reason === "self_draw_hu" ? "self_draw" : input.reason;
  const payments: ScorePaymentView[] = [];
  const winnerDetails = input.winnerSeats.map((seat) => toWinnerScore(seat, input.analyses.get(seat)));

  for (const winner of winnerDetails) {
    const payerSeats = input.reason !== "self_draw_hu" && isMultiWin && input.fromSeat !== undefined
      ? [input.fromSeat]
      : [0, 1, 2, 3].filter((seat) => seat !== winner.seat && !winnerSet.has(seat));
    for (const payerSeat of payerSeats) {
      let amount = 2;
      const factors: ScoreFactor[] = ["base"];
      if (input.reason === "self_draw_hu") {
        amount *= 2;
        factors.push("self_draw");
      }
      if (input.reason !== "self_draw_hu" && payerSeat === input.fromSeat) {
        amount *= 2;
        factors.push("discard");
      }
      if (winner.seat === input.dealerSeat || payerSeat === input.dealerSeat) {
        amount *= 2;
        factors.push("dealer");
      }
      if (winner.isClosed) {
        amount *= 2;
        factors.push("closed_winner");
      }
      if (isClosedHand(input.meldsBySeat.get(payerSeat) ?? [])) {
        amount *= 2;
        factors.push("closed_payer");
      }
      if (winner.isPengPengHu) {
        amount *= 2;
        factors.push("pengpeng_hu");
      }
      if (winner.isSevenPairs) {
        amount *= 2;
        factors.push("seven_pairs");
      }
      if (winner.isSanBuLao) {
        amount *= 2;
        factors.push("sanbu_lao");
      }
      payments.push({ fromSeat: payerSeat, toSeat: winner.seat, amount, reason: paymentReason, factors });
    }
  }
  return { payments, winnerDetails };
}

export function calculateKongPayments(
  winnerSeat: number,
  reason: Extract<ScoreReason, "ming_gang" | "an_gang" | "jia_gang" | "special_gang" | "zhangmao">,
): ScorePaymentView[] {
  const amount = reason === "an_gang" ? 4 : reason === "zhangmao" ? 1 : 2;
  const factors: ScoreFactor[] = reason === "an_gang" ? ["angang"] : reason === "zhangmao" ? ["zhangmao"] : ["kong"];
  return [0, 1, 2, 3]
    .filter((seat) => seat !== winnerSeat)
    .map((fromSeat) => ({ fromSeat, toSeat: winnerSeat, amount, reason, factors }));
}

export function calculateScoreDeltas(payments: readonly ScorePaymentView[]): number[] {
  const deltas = [0, 0, 0, 0];
  for (const payment of payments) {
    deltas[payment.fromSeat] = (deltas[payment.fromSeat] ?? 0) - payment.amount;
    deltas[payment.toSeat] = (deltas[payment.toSeat] ?? 0) + payment.amount;
  }
  return deltas;
}

function toWinnerScore(seat: number, analysis: WinningAnalysis | undefined): WinnerScoreView {
  if (!analysis?.valid) throw new Error("赢家牌型分析无效");
  return {
    seat,
    isClosed: analysis.isClosed,
    isSevenPairs: analysis.isSevenPairs,
    isPengPengHu: analysis.isPengPengHu,
    isSanBuLao: analysis.isSanBuLao,
  };
}
