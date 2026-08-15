export type NumberedSuit = "wan" | "tong" | "tiao";
export type HonorTile = "east" | "south" | "west" | "north" | "red" | "green" | "white";
export type TileCode = `${NumberedSuit}-${number}` | HonorTile;
export type DiscardView = { seat: number; tile: TileCode };
export type ReactionKind = "chi" | "peng" | "gang" | "hu";
export type ReactionOption = {
  id: string;
  kind: ReactionKind;
  consumeTiles: TileCode[];
  displayTiles: TileCode[];
};
export type TurnOperationKind = "angang" | "jiagang" | "specialgang" | "zhangmao" | "zimo";
export type TurnOperationOption = {
  id: string;
  kind: TurnOperationKind;
  tiles: TileCode[];
};
export type MeldView = {
  seat: number;
  kind: "chi" | "peng" | "gang" | "special_gang";
  tiles: TileCode[];
  fromSeat: number;
  gangType?: "ming" | "an" | "jia";
  specialType?: "dragons" | "winds";
  growthCount?: number;
  hiddenTileCount?: number;
};
export type ScoreReason =
  | "self_draw"
  | "discard_hu"
  | "rob_kong_hu"
  | "ming_gang"
  | "an_gang"
  | "jia_gang"
  | "special_gang"
  | "zhangmao";
export type ScoreFactor =
  | "base"
  | "self_draw"
  | "discard"
  | "dealer"
  | "closed_winner"
  | "closed_payer"
  | "pengpeng_hu"
  | "seven_pairs"
  | "sanbu_lao"
  | "kong"
  | "angang"
  | "zhangmao";
export type ScorePaymentView = { fromSeat: number; toSeat: number; amount: number; reason: ScoreReason; factors?: ScoreFactor[] };
export type WinnerScoreView = {
  seat: number;
  isClosed: boolean;
  isSevenPairs: boolean;
  isPengPengHu: boolean;
  isSanBuLao: boolean;
};
export type MatchMode = 8 | 16;
export type MatchRankingView = { seat: number; score: number; rank: number };
export type RoundEndReason = "discard_hu" | "self_draw_hu" | "rob_kong_hu" | "wall_exhausted" | "dissolved";
export type RoundHistoryView = {
  roundNumber: number;
  dealerSeat: number;
  reason: RoundEndReason;
  winnerSeats: number[];
  scoreDeltas: number[];
  scoreTotals: number[];
};
export type EarlySettlementView = {
  requesterSeat: number;
  duringRound?: boolean;
  status: "voting" | "rejected" | "approved";
  approvedSeats: number[];
  rejectedSeats: number[];
  waitingSeats: number[];
};
export type PublicActionKind =
  | "round_started"
  | "discard"
  | "chi"
  | "peng"
  | "ming_gang"
  | "an_gang"
  | "jia_gang"
  | "special_gang"
  | "zhangmao"
  | "self_draw_hu"
  | "discard_hu"
  | "rob_kong_hu"
  | "round_ended"
  | "settlement_requested"
  | "settlement_agreed"
  | "settlement_rejected"
  | "round_dissolved"
  | "turn_timed_out"
  | "reaction_timed_out"
  | "auto_management_started"
  | "auto_management_ended"
  | "player_disconnected"
  | "player_reconnected";
export type PublicActionView = {
  sequence: number;
  kind: PublicActionKind;
  roundNumber?: number;
  seat?: number;
  seats?: number[];
  fromSeat?: number;
  tile?: TileCode;
};
export type MatchView = {
  totalRounds: MatchMode;
  completedRounds: number;
  status: "waiting" | "active" | "completed";
  endReason?: "round_limit" | "negative_score" | "early_agreement";
  rankings?: MatchRankingView[];
  roundHistory: RoundHistoryView[];
  earlySettlement?: EarlySettlementView;
};
export type RoundResultView = {
  reason: RoundEndReason;
  winnerSeats: number[];
  fromSeat?: number;
  tile?: TileCode;
  winnerDetails?: WinnerScoreView[];
  payments?: ScorePaymentView[];
  scoreDeltas?: number[];
};

export type PlayerView = {
  id: string;
  name: string;
  seat: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  isTestPlayer: boolean;
  autoManaged?: boolean;
};

export type RoomSnapshot = {
  roomCode: string;
  revision: number;
  phase: "waiting" | "playing";
  players: PlayerView[];
  scoreTotals: number[];
  publicActions: PublicActionView[];
  match: MatchView;
  game?: {
    modelVersion: string;
    roundNumber: number;
    dealerSeat: number;
    turnSeat: number;
    stage: "awaiting_discard" | "awaiting_reactions" | "round_ended";
    wallRemaining: number;
    handTileCounts: number[];
    actionDeadlineAt?: number;
    actionTimeoutSeconds?: number;
    viewerSeat?: number;
    selfHand?: TileCode[];
    selfDrawnTile?: TileCode;
    latestDiscard?: DiscardView;
    discards: DiscardView[];
    melds: MeldView[];
    scorePayments: ScorePaymentView[];
    scoreDeltas: number[];
    reaction?: {
      discard: DiscardView;
      source: "discard" | "added_gang" | "special_gang" | "zhangmao";
      waitingCount: number;
      respondedCount: number;
    };
    availableOperations?: ReactionOption[];
    availableTurnOperations?: TurnOperationOption[];
    roundResult?: RoundResultView;
  };
};

export type ClientMessage =
  | { type: "create_room"; name: string; totalRounds?: MatchMode }
  | { type: "join_room"; roomCode: string; name: string }
  | { type: "reconnect"; roomCode: string; playerToken: string }
  | { type: "set_ready"; ready: boolean }
  | { type: "fill_test_players" }
  | { type: "remove_test_players" }
  | { type: "leave_room" }
  | { type: "start_game" }
  | { type: "start_next_round" }
  | { type: "request_early_settlement" }
  | { type: "respond_early_settlement"; agree: boolean }
  | { type: "discard_tile"; tile: TileCode }
  | { type: "react_to_discard"; operationId: string | "pass" }
  | { type: "perform_turn_operation"; operationId: string }
  | { type: "ping" };

export type ServerMessage =
  | {
      type: "session";
      roomCode: string;
      playerId: string;
      playerToken: string;
      snapshot: RoomSnapshot;
    }
  | { type: "snapshot"; snapshot: RoomSnapshot }
  | { type: "left_room" }
  | { type: "room_closed"; roomCode: string; reason: string }
  | { type: "room_announcement"; message: string }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };
