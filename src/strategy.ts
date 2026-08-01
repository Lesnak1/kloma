import type { BotConfig } from "@/src/config";
import {
  aggregateCandles,
  clamp,
  floorQuantity,
  microPrice,
  momentumBps,
  realizedVolatilityBps,
  roundToTick,
  topOfBook,
} from "@/src/indicators";
import { modeSizeMultiplier } from "@/src/risk";
import type {
  Candle,
  DesiredOrder,
  MarketDecision,
  MarketDetail,
  MarketSummary,
  Position,
  RiskMode,
} from "@/src/types";
import {
  initialStrategyCalibration,
  isCalibrationQuarantined,
  type StrategyCalibration,
} from "@/src/calibration";

export interface StrategyInput {
  config: BotConfig;
  market: MarketSummary;
  detail: MarketDetail;
  candles: Candle[];
  position?: Position;
  portfolioValue: number;
  cash: number;
  grossExposure: number;
  drawdownPct?: number;
  makerFeeBps: number;
  takerFeeBps: number;
  riskMode: RiskMode;
  multiplier: number;
  calibration?: StrategyCalibration;
  nowSeconds?: number;
}

function hold(input: StrategyInput, reason: string, state: "hold" | "halt" = "hold"): MarketDecision {
  return {
    tokenName: input.market.tokenName,
    propertyId: input.market.propertyId,
    state,
    reason,
    riskMode: input.riskMode,
    metrics: { multiplier: input.multiplier },
    desiredOrders: [],
  };
}

function quantityForNotional(notional: number, price: number, minimumNotional: number): number {
  const quantity = floorQuantity(notional / price);
  return quantity > 0 && quantity * price >= minimumNotional ? quantity : 0;
}

export function decideMarket(input: StrategyInput): MarketDecision {
  const { config, detail, market, position } = input;
  const calibration = input.calibration ?? initialStrategyCalibration();
  if (market.status !== "LIVE" || detail.property.status !== "LIVE") {
    return hold(input, "market-not-live");
  }
  if (detail.property.isHalted) return hold(input, "market-halted", "halt");
  if (!detail.orderBook) return hold(input, "empty-order-book");

  const bestBid = topOfBook(detail.orderBook.bids ?? [], "bid");
  const bestAsk = topOfBook(detail.orderBook.asks ?? [], "ask");
  if (!bestBid || !bestAsk || bestBid.price >= bestAsk.price) return hold(input, "invalid-two-sided-book", "halt");

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const usableCandles = input.candles
    .filter((candle) => candle.close > 0 && candle.time > 0)
    .sort((left, right) => left.time - right.time);
  const latestCandle = usableCandles.at(-1);
  if (!latestCandle || latestCandle.time < now - 20 * 60) return hold(input, "stale-candles");

  const previousCandle = usableCandles.at(-2);
  const oneBarSignedBps = previousCandle ? (latestCandle.close / previousCandle.close - 1) * 10_000 : 0;
  const oneBarMoveBps = Math.abs(oneBarSignedBps);
  if (oneBarMoveBps > 800) return hold(input, "one-bar-jump-circuit-breaker", "halt");

  const mid = (bestBid.price + bestAsk.price) / 2;
  const spreadBps = ((bestAsk.price - bestBid.price) / mid) * 10_000;
  if (spreadBps > config.maxSpreadBps) return hold(input, "spread-circuit-breaker", "halt");

  const volatilityBps = clamp(realizedVolatilityBps(usableCandles), 1, 800);
  const momentum = momentumBps(usableCandles);
  const higherTimeframeMomentum = momentumBps(aggregateCandles(usableCandles, 15 * 60));
  const imbalance = clamp(
    (bestBid.quantity - bestAsk.quantity) / Math.max(bestBid.quantity + bestAsk.quantity, Number.EPSILON),
    -1,
    1,
  );
  const micro = microPrice(bestBid, bestAsk);
  const microBps = ((micro / mid) - 1) * 10_000;
  const reference = detail.dailyReferencePrice ?? market.dailyReferencePrice;
  const referenceDeviationBps = reference && reference > 0 ? (mid / reference - 1) * 10_000 : 0;
  const trendRegime = Math.abs(momentum) > Math.max(45, volatilityBps * 0.7);
  const rawSignalBps = trendRegime
    ? momentum * 0.58 + microBps * 0.25 + imbalance * 18
    : momentum * 0.2 + microBps * 0.35 + imbalance * 12 - clamp(referenceDeviationBps, -500, 500) * 0.08;
  const signalBps = clamp(rawSignalBps, -350, 350);
  const fairPrice = mid * (1 + signalBps / 10_000);
  const buyTrendConfirmed = higherTimeframeMomentum >= 20 && oneBarSignedBps >= -volatilityBps * 0.5;
  const sellTrendConfirmed = higherTimeframeMomentum <= -20 && oneBarSignedBps <= volatilityBps * 0.5;
  const calibrationQuarantined = isCalibrationQuarantined(calibration);

  const positionQuantity = Math.max(0, Number(position?.quantity ?? 0));
  const positionPrice = Number(position?.marketPrice ?? mid) || mid;
  const positionNotional = positionQuantity * positionPrice;
  const perMarketCap = input.portfolioValue * (config.maxMarketExposurePct / 100);
  const grossCap = input.portfolioValue * (config.maxGrossExposurePct / 100);
  const inventoryRatio = perMarketCap > 0 ? clamp(positionNotional / perMarketCap, 0, 2) : 0;
  const inventoryPenaltyBps = inventoryRatio * clamp(volatilityBps * 0.45 + 18, 18, 180);
  const reservationPrice = fairPrice * (1 - inventoryPenaltyBps / 10_000);

  // Directional inventory must eventually be closed, so require a full maker round-trip edge.
  const feeAdjustedThreshold = input.makerFeeBps * 2 + config.minNetEdgeBps + calibration.thresholdAddBps;
  const marketMakingThreshold =
    input.makerFeeBps * 2 +
    config.minNetEdgeBps +
    calibration.thresholdAddBps +
    Math.min(80, volatilityBps * 0.15);
  const marketMakingEdge = spreadBps >= marketMakingThreshold;
  const buySignalPresent = signalBps >= feeAdjustedThreshold;
  const sellSignalPresent = signalBps <= -feeAdjustedThreshold;
  const buyAlpha = buySignalPresent && buyTrendConfirmed;
  const sellAlpha = sellSignalPresent && sellTrendConfirmed;

  const volatilityScale = clamp(100 / volatilityBps, 0.35, 1.15);
  const multiplierScale = clamp(input.multiplier, 1, 2);
  const baseNotional =
    input.portfolioValue *
    (config.orderNotionalPct / 100) *
    modeSizeMultiplier(input.riskMode) *
    volatilityScale *
    multiplierScale *
    calibration.sizeScale;

  const cashBudget = Math.max(0, input.cash - input.portfolioValue * (config.cashReservePct / 100));
  const grossBudget = Math.max(0, grossCap - input.grossExposure);
  const marketBudget = Math.max(0, perMarketCap - positionNotional);
  const exitFloor = bestBid.price * (1 - config.liquidityDepthBps / 10_000);
  const exitDepthNotional = (detail.orderBook.bids ?? [])
    .filter((level) => level.price >= exitFloor && level.price <= bestBid.price && level.quantity > 0)
    .reduce((sum, level) => sum + level.price * level.quantity, 0);
  const liquidityBudget = exitDepthNotional * (config.maxBookParticipationPct / 100);
  const buyNotional = Math.min(baseNotional, cashBudget, grossBudget, marketBudget, liquidityBudget);
  const pointsInventoryCap = input.portfolioValue * (config.pointsMaxMarketExposurePct / 100);
  const pointsInventoryBudget = Math.max(0, pointsInventoryCap - positionNotional);
  const pointsCostScale = input.riskMode === "preserve"
    ? 0.6
    : input.riskMode === "balanced"
      ? 0.8
      : input.riskMode === "defend"
        ? 0.95
        : 1;
  const pointsCostBudgetBps = config.pointsMaxRoundTripCostBps * pointsCostScale;
  const alphaCostCreditBps = buyTrendConfirmed ? Math.min(35, Math.max(0, signalBps) * 0.25) : 0;
  const pointsRoundTripCostBps = Math.max(0, input.makerFeeBps * 2 - spreadBps - alphaCostCreditBps);
  const pointsBearishGuard =
    signalBps <= -Math.max(35, volatilityBps * 0.25) ||
    higherTimeframeMomentum <= -Math.max(30, volatilityBps * 0.2);
  const pointsBaseNotional =
    input.portfolioValue *
    (config.pointsOrderNotionalPct / 100) *
    modeSizeMultiplier(input.riskMode) *
    volatilityScale *
    multiplierScale *
    calibration.sizeScale;
  const pointsOrderNotional = Math.min(
    pointsBaseNotional,
    cashBudget,
    grossBudget,
    pointsInventoryBudget,
    liquidityBudget,
  );
  const pointsModeEligible =
    config.pointsModeEnabled &&
    Number(input.drawdownPct ?? 0) < config.pointsDrawdownStopPct &&
    !calibrationQuarantined &&
    !pointsBearishGuard &&
    pointsRoundTripCostBps <= pointsCostBudgetBps &&
    pointsOrderNotional >= config.minOrderNotional;
  const desiredOrders: DesiredOrder[] = [];
  const positionPnlPct = Number(position?.propertyPnlPercent ?? 0);
  const dynamicStopLossPct = clamp(
    (volatilityBps * 1.5) / 100,
    config.minStopLossPct,
    config.stopLossPct,
  );
  const dynamicTakeProfitPct = clamp(
    (input.makerFeeBps + input.takerFeeBps + config.minNetEdgeBps + Math.max(30, volatilityBps * 0.45)) / 100,
    config.minTakeProfitPct,
    config.maxTakeProfitPct,
  );
  const stopLoss = positionQuantity > 0 && positionPnlPct <= -dynamicStopLossPct;
  const takeProfit = positionQuantity > 0 && positionPnlPct >= dynamicTakeProfitPct;

  const regularBuyEntry = marketMakingEdge || buyAlpha;
  const selectedBuyNotional = regularBuyEntry ? buyNotional : pointsOrderNotional;
  if (
    !stopLoss &&
    !takeProfit &&
    !calibrationQuarantined &&
    (regularBuyEntry || pointsModeEligible) &&
    selectedBuyNotional >= config.minOrderNotional
  ) {
    const improvedBid = Math.min(bestAsk.price - config.tickSize, bestBid.price + config.tickSize);
    const passiveTarget = reservationPrice * (1 - Math.max(config.minNetEdgeBps, volatilityBps * 0.12) / 10_000);
    const rawBid = buyAlpha || pointsModeEligible
      ? improvedBid
      : Math.min(improvedBid, Math.max(bestBid.price, passiveTarget));
    const price = roundToTick(Math.min(rawBid, bestAsk.price - config.tickSize), config.tickSize, "down");
    const quantity = quantityForNotional(selectedBuyNotional, price, config.minOrderNotional);
    if (price > 0 && price < bestAsk.price && quantity > 0) {
      desiredOrders.push({
        tokenName: market.tokenName,
        propertyId: market.propertyId,
        side: "BUY",
        price,
        quantity,
        type: "LIMIT",
        timeInForce: "GTC",
        rationale: [
          marketMakingEdge ? "fee-adjusted-spread" : buyAlpha ? "momentum-alpha" : "points-passive-liquidity",
          trendRegime ? "trend" : "range",
        ],
      });
    }
  }

  const pointsInventoryExit = config.pointsModeEnabled && positionQuantity > 0;
  const pointsOnlyExit = pointsInventoryExit && !stopLoss && !takeProfit && !marketMakingEdge && !sellAlpha;
  if (positionQuantity > 0 && (stopLoss || takeProfit || marketMakingEdge || sellAlpha || pointsInventoryExit)) {
    const sellNotional = stopLoss || takeProfit
      ? positionQuantity * (stopLoss ? bestBid.price : bestAsk.price)
      : Math.min(pointsOnlyExit ? pointsBaseNotional : baseNotional, positionQuantity * bestAsk.price);
    const improvedAsk = Math.max(bestBid.price + config.tickSize, bestAsk.price - config.tickSize);
    const passiveTarget = reservationPrice * (1 + Math.max(config.minNetEdgeBps, volatilityBps * 0.12) / 10_000);
    let rawAsk = Math.max(improvedAsk, Math.min(bestAsk.price, passiveTarget));
    if (stopLoss) rawAsk = bestBid.price;
    else if (takeProfit || sellAlpha) rawAsk = improvedAsk;
    else if (pointsOnlyExit) {
      const entryPrice = Number(position?.averageEntryPrice ?? 0);
      const minimumExitEdgeBps = Math.max(0, input.makerFeeBps * 2 - pointsCostBudgetBps);
      const pointsExitFloor = entryPrice > 0 ? entryPrice * (1 + minimumExitEdgeBps / 10_000) : improvedAsk;
      rawAsk = Math.max(improvedAsk, pointsExitFloor);
    }
    const price = roundToTick(Math.max(rawAsk, stopLoss ? bestBid.price : bestBid.price + config.tickSize), config.tickSize, "up");
    const requestedQuantity = stopLoss || takeProfit
      ? positionQuantity
      : quantityForNotional(sellNotional, price, config.minOrderNotional);
    const quantity = floorQuantity(Math.min(positionQuantity, requestedQuantity));
    if (quantity > 0 && quantity * price >= config.minOrderNotional && (stopLoss || price > bestBid.price)) {
      desiredOrders.push({
        tokenName: market.tokenName,
        propertyId: market.propertyId,
        side: "SELL",
        price,
        quantity,
        type: "LIMIT",
        timeInForce: stopLoss ? "IOC" : "GTC",
        rationale: [
          stopLoss
            ? "volatility-stop-loss"
            : takeProfit
              ? "volatility-take-profit"
              : marketMakingEdge
                ? "fee-adjusted-spread"
                : sellAlpha
                  ? "negative-alpha"
                  : "points-inventory-recycle",
        ],
      });
    }
  }

  const bid = desiredOrders.find((order) => order.side === "BUY");
  const ask = desiredOrders.find((order) => order.side === "SELL");
  if (bid && ask && bid.price >= ask.price) {
    return hold(input, "self-trade-prevention", "halt");
  }

  let reason = "no-fee-adjusted-edge";
  if (desiredOrders.length > 0) {
    const pointsOrder = desiredOrders.some((order) => order.rationale.some((item) => item.startsWith("points-")));
    reason = marketMakingEdge
      ? "net-positive-passive-edge"
      : pointsOrder
        ? "points-aware-passive-liquidity"
        : "fee-adjusted-directional-edge";
  } else if (calibrationQuarantined) {
    reason = "calibration-quarantine";
  } else if ((buySignalPresent && !buyTrendConfirmed) || (sellSignalPresent && !sellTrendConfirmed)) {
    reason = "higher-timeframe-not-confirmed";
  }

  return {
    tokenName: market.tokenName,
    propertyId: market.propertyId,
    state: desiredOrders.length > 0 ? "quote" : "hold",
    reason,
    riskMode: input.riskMode,
    metrics: {
      bestBid: bestBid.price,
      bestAsk: bestAsk.price,
      mid,
      spreadBps,
      volatilityBps,
      momentumBps: momentum,
      higherTimeframeMomentumBps: higherTimeframeMomentum,
      imbalance,
      fairPrice,
      reservationPrice,
      multiplier: input.multiplier,
      calibrationSamples: calibration.samples,
      calibrationNetEdgeBps: calibration.emaNetEdgeBps,
      calibrationAccuracy: calibration.directionalAccuracy,
      calibrationSizeScale: calibration.sizeScale,
      calibrationThresholdAddBps: calibration.thresholdAddBps,
      calibrationQuarantined,
      dynamicStopLossPct,
      dynamicTakeProfitPct,
      exitDepthNotional,
      liquidityBudget,
      pointsModeEligible,
      pointsRoundTripCostBps,
      pointsOrderNotional,
      pointsInventoryCap,
    },
    desiredOrders,
  };
}
