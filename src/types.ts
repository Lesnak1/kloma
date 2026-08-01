export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";
export type TimeInForce = "GTC" | "IOC" | "FOK" | "GTD";
export type RiskMode = "preserve" | "balanced" | "defend" | "attack";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PriceLevel {
  price: number;
  quantity: number;
  orderId?: number;
}

export interface MarketSummary {
  propertyId: number;
  tokenName: string;
  assetName: string;
  ticker: string;
  status: "PENDING" | "LIVE" | "DELISTED" | string;
  marketPrice: number;
  dailyReferencePrice: number | null;
  volume24h: number;
  rentalYieldPercentage?: number | null;
  candlesticks?: Candle[];
  isCompetition?: boolean;
  liquidity?: { status?: string; reason?: string; healthy?: boolean };
}

export interface MarketListResponse {
  properties: MarketSummary[];
  paymentTokenAddress?: string;
  competitionModeActive?: boolean;
}

export interface MarketDetail {
  property: {
    propertyId: number;
    tokenName: string;
    assetName: string;
    ticker: string;
    status: string;
    isHalted: boolean;
    isCompetition?: boolean;
  };
  orderBook: {
    propertyId?: number;
    bids: PriceLevel[];
    asks: PriceLevel[];
  } | null;
  recentTrades?: Array<{
    tradeId: number | string;
    propertyId: number;
    aggressorSide: OrderSide | 0 | 1;
    price: number;
    quantity: number;
    timestamp: number;
  }>;
  dailyReferencePrice: number | null;
  volume24h: number;
  maxSlippageBps?: number;
  competitionModeActive?: boolean;
  liquidity?: { status?: string; reason?: string; healthy?: boolean };
}

export interface CandleHistoryResponse {
  resolution: string;
  candles: Candle[];
  oldestTs: number | null;
  hasMore: boolean;
}

export interface Position {
  propertyId: number;
  tokenName: string;
  quantity: number;
  totalQuantity?: number;
  averageEntryPrice: number;
  marketPrice: number;
  percentOfPortfolio?: number;
  propertyPnl?: number;
  propertyPnlPercent?: number;
}

export interface ActiveOrder {
  id: number;
  orderId?: number;
  propertyId: number;
  tokenName: string;
  side: OrderSide;
  type?: OrderType;
  timeInForce?: TimeInForce;
  quantity: number;
  filledQuantity?: number;
  price: number | null;
  status?: string;
  createdAt?: number | string;
}

export interface PortfolioComponent {
  cash: number;
  frozen: number;
  portfolioValue: number;
  portfolioPnl: number;
  portfolioPnlPercent: number;
  lifetimeVolume?: number;
  positions: Position[];
  applicableFees?: {
    makerFeeBps?: number;
    takerFeeBps?: number;
  };
  openOrders?: ActiveOrder[];
}

export interface CompetitionRound {
  roundNumber: number;
  name?: string;
  startsAt?: string;
  endsAt?: string;
  status: string;
  totalPrizePool?: number;
  participantBatchSize?: number;
}

export interface FeaturedRound extends CompetitionRound {
  rules?: unknown;
  startingBalanceUsdl?: number;
  prizePool?: unknown;
  volumeMultiplierTiers?: unknown;
  newAssetProperty?: unknown;
}

export interface CompetitionResponse {
  rounds: CompetitionRound[];
  featuredRound: FeaturedRound | null;
  makerFeeBps: number;
  takerFeeBps: number;
  queueCount: number;
}

export interface QueuePositionResponse {
  position: number | null;
  queueCount: number;
  finalPlacement: number | null;
  referralCount?: number;
  priorityBoostPlaces?: number;
  maxBoostsPerUser?: number;
}

export interface LeaderboardEntry {
  rank: number;
  handle: string | null;
  walletAddress: string;
  points: number;
  volume: number;
  pnl: number;
}

export interface LeaderboardResponse {
  roundNumber: number;
  roundName?: string;
  roundRules?: unknown;
  roundStatus?: string;
  volumeMultiplierTiers?: unknown;
  entries: LeaderboardEntry[];
  newAssetProperty?: unknown;
}

export interface OrderRequest {
  propertyId: number;
  price: number;
  quantity: number;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  deadline: number;
  nonce: string;
}

export interface OrderResult {
  success: boolean;
  orderId: number;
  errorMessage?: string;
}

export interface CancelResult {
  success: boolean;
  orderId: number;
  errorMessage?: string;
}

export interface CancelAllResult {
  requestedCount: number;
  cancelledOrderIds: number[];
  failedOrders: Array<{ orderId: number; errorMessage: string }>;
}

export interface DesiredOrder {
  tokenName: string;
  propertyId: number;
  side: OrderSide;
  price: number;
  quantity: number;
  type: "LIMIT";
  timeInForce: "GTC" | "IOC";
  rationale: string[];
}

export interface MarketDecision {
  tokenName: string;
  propertyId: number;
  state: "quote" | "hold" | "halt";
  reason: string;
  riskMode: RiskMode;
  metrics: {
    bestBid?: number;
    bestAsk?: number;
    mid?: number;
    spreadBps?: number;
    volatilityBps?: number;
    momentumBps?: number;
    higherTimeframeMomentumBps?: number;
    imbalance?: number;
    fairPrice?: number;
    reservationPrice?: number;
    multiplier?: number;
    calibrationSamples?: number;
    calibrationNetEdgeBps?: number;
    calibrationAccuracy?: number;
    calibrationSizeScale?: number;
    calibrationThresholdAddBps?: number;
    calibrationQuarantined?: boolean;
    dynamicStopLossPct?: number;
    dynamicTakeProfitPct?: number;
    exitDepthNotional?: number;
    liquidityBudget?: number;
  };
  desiredOrders: DesiredOrder[];
}

export interface RunReport {
  runId: string;
  timestamp: string;
  mode: "dry-run" | "live" | "halted";
  competition: {
    active: boolean;
    roundNumber: number | null;
    roundStatus: string | null;
    admitted: boolean | null;
  };
  fees?: {
    makerFeeBps: number;
    takerFeeBps: number;
  };
  portfolio?: {
    value: number;
    cash: number;
    frozen: number;
    pnl: number;
    drawdownPct: number;
  };
  leaderboard?: {
    rank: number | null;
    participants: number;
    percentile: number | null;
    bottomThirtyCutoffRank: number | null;
    riskMode: RiskMode;
  };
  decisions: MarketDecision[];
  actions: Array<{
    action: "cancel" | "place" | "skip" | "scheduler";
    tokenName?: string;
    side?: OrderSide;
    orderId?: number;
    price?: number;
    quantity?: number;
    result: string;
  }>;
  warnings: string[];
  durationMs: number;
}
