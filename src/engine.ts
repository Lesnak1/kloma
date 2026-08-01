import { randomUUID } from "node:crypto";
import type { BotConfig } from "@/src/config";
import { momentumBps } from "@/src/indicators";
import type { LoafApi } from "@/src/loaf-client";
import type { SchedulerControl } from "@/src/scheduler";
import type { PortfolioRiskState, StrategyCalibration } from "@/src/calibration";
import {
  assessStanding,
  explicitMarketMultiplier,
  portfolioDrawdownPct,
  portfolioGrossExposure,
  volumeMultiplierForStanding,
} from "@/src/risk";
import { decideMarket } from "@/src/strategy";
import type {
  ActiveOrder,
  DesiredOrder,
  MarketDecision,
  MarketSummary,
  Position,
  RunReport,
} from "@/src/types";

function isActiveStatus(value: unknown): boolean {
  return typeof value === "string" && value.toUpperCase() === "ACTIVE";
}

export function isTerminalRoundStatus(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["COMPLETED", "ENDED", "FINISHED", "CLOSED"].includes(value.toUpperCase())
  );
}

function orderId(order: ActiveOrder): number | null {
  const id = Number(order.id ?? order.orderId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function orderAgeSeconds(order: ActiveOrder, nowSeconds: number): number {
  if (order.createdAt === undefined) return Number.POSITIVE_INFINITY;
  if (typeof order.createdAt === "number") {
    const seconds = order.createdAt > 10_000_000_000 ? order.createdAt / 1000 : order.createdAt;
    return Math.max(0, nowSeconds - seconds);
  }
  const parsed = Date.parse(order.createdAt);
  return Number.isFinite(parsed) ? Math.max(0, nowSeconds - parsed / 1000) : Number.POSITIVE_INFINITY;
}

function marketScore(market: MarketSummary, multiplier: number): number {
  const volumeScore = Math.log10(Math.max(1, Number(market.volume24h ?? 0))) * 12;
  const opportunityScore = Math.min(200, Math.abs(momentumBps(market.candlesticks ?? []))) * 0.25;
  const liquidityPenalty = market.liquidity?.healthy === false ? 8 : 0;
  return (volumeScore + opportunityScore - liquidityPenalty) * Math.max(1, multiplier);
}

function positionMap(positions: Position[]): Map<string, Position> {
  return new Map(positions.map((position) => [position.tokenName.toLowerCase(), position]));
}

function priceDifferenceBps(left: number, right: number): number {
  const reference = Math.max(Math.abs(left), Math.abs(right), Number.EPSILON);
  return (Math.abs(left - right) / reference) * 10_000;
}

function standingTiers(leaderboardTiers: unknown, featuredTiers: unknown): unknown {
  return leaderboardTiers ?? featuredTiers;
}

export class TradingEngine {
  constructor(
    private readonly api: LoafApi,
    private readonly config: BotConfig,
    private readonly scheduler?: SchedulerControl,
    private readonly calibrations: Record<string, StrategyCalibration> = {},
    private readonly riskState?: PortfolioRiskState,
  ) {}

  async run(): Promise<RunReport> {
    const startedAt = Date.now();
    const runId = randomUUID();
    const warnings: string[] = [];
    const actions: RunReport["actions"] = [];
    const decisions: MarketDecision[] = [];
    const competition = await this.api.getCompetition();
    const fees = {
      makerFeeBps: Number(competition.makerFeeBps ?? 0),
      takerFeeBps: Number(competition.takerFeeBps ?? 0),
    };
    const activeRound =
      (competition.featuredRound && isActiveStatus(competition.featuredRound.status)
        ? competition.featuredRound
        : competition.rounds.find((round) => isActiveStatus(round.status))) ?? null;

    if (this.config.killSwitch) {
      if (this.config.tradingEnabled) {
        const result = await this.api.cancelAll();
        actions.push({ action: "cancel", result: `kill-switch: cancelled ${result.cancelledOrderIds.length}` });
        if (result.failedOrders.length > 0) warnings.push(`Kill switch had ${result.failedOrders.length} failed cancels.`);
      } else {
        actions.push({ action: "skip", result: "kill-switch enabled; dry-run sends no cancel" });
      }
      return {
        runId,
        timestamp: new Date(startedAt).toISOString(),
        mode: "halted",
        competition: {
          active: Boolean(activeRound),
          roundNumber: activeRound?.roundNumber ?? null,
          roundStatus: activeRound?.status ?? null,
          admitted: null,
        },
        fees,
        decisions,
        actions,
        warnings,
        durationMs: Date.now() - startedAt,
      };
    }

    if (!activeRound && !this.config.allowOutsideCompetition) {
      actions.push({ action: "skip", result: "no active competition round" });
      const targetRound = this.config.stopAfterRoundNumber
        ? [competition.featuredRound, ...competition.rounds].find(
            (round) =>
              round !== null &&
              round.roundNumber === this.config.stopAfterRoundNumber &&
              isTerminalRoundStatus(round.status),
          )
        : undefined;
      let cleanupSafe = true;

      if (this.config.tradingEnabled || targetRound) {
        try {
          const activeOrders = await this.api.getActiveOrders();
          if (activeOrders.length > 0 && this.config.tradingEnabled) {
            const result = await this.api.cancelAll();
            actions.push({
              action: "cancel",
              result: `outside-competition cleanup: cancelled ${result.cancelledOrderIds.length}`,
            });
            cleanupSafe = result.failedOrders.length === 0;
            if (!cleanupSafe) {
              warnings.push(
                `Outside-competition cleanup had ${result.failedOrders.length} failed cancels; scheduler remains enabled.`,
              );
            }
          } else if (activeOrders.length > 0) {
            cleanupSafe = false;
            actions.push({
              action: "skip",
              result: `dry-run left ${activeOrders.length} open orders unchanged`,
            });
            warnings.push("Open orders exist after the target round, but TRADING_ENABLED=false prevents automatic cancellation.");
          }
        } catch (error) {
          cleanupSafe = false;
          warnings.push(
            `Outside-competition order cleanup could not be verified: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }

      if (targetRound) {
        if (this.scheduler && cleanupSafe) {
          try {
            const result = await this.scheduler.disable();
            actions.push({
              action: "scheduler",
              result: `target round ${targetRound.roundNumber} ended; disabled job ${result.jobId}`,
            });
          } catch (error) {
            warnings.push(
              `Automatic scheduler shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`,
            );
          }
        } else if (!this.scheduler) {
          warnings.push(
            `Target round ${targetRound.roundNumber} ended, but CRONJOB_API_KEY/CRONJOB_JOB_ID is incomplete; scheduler remains enabled.`,
          );
        }
      }

      return {
        runId,
        timestamp: new Date(startedAt).toISOString(),
        mode: this.config.tradingEnabled ? "halted" : "dry-run",
        competition: { active: false, roundNumber: null, roundStatus: null, admitted: null },
        fees,
        decisions,
        actions,
        warnings: ["ALLOW_OUTSIDE_COMPETITION=false; no new orders were evaluated or sent.", ...warnings],
        durationMs: Date.now() - startedAt,
      };
    }

    let admitted: boolean | null = null;
    if (activeRound) {
      try {
        const queue = await this.api.getQueuePosition();
        admitted = queue.position == null && queue.finalPlacement == null;
      } catch (error) {
        warnings.push(`Competition eligibility check failed: ${error instanceof Error ? error.message : "unknown error"}`);
        admitted = false;
      }
      if (!admitted) {
        return {
          runId,
          timestamp: new Date(startedAt).toISOString(),
          mode: "halted",
          competition: {
            active: true,
            roundNumber: activeRound.roundNumber,
            roundStatus: activeRound.status,
            admitted,
          },
          fees,
          decisions,
          actions: [{ action: "skip", result: "account is not admitted to the active round" }],
          warnings,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    const [portfolio, marketList, leaderboard, activeOrders] = await Promise.all([
      this.api.getPortfolio(),
      this.api.getMarkets(),
      this.api.getLeaderboard(),
      this.api.getActiveOrders(),
    ]);
    const startingBalance = Number(activeRound && "startingBalanceUsdl" in activeRound
      ? activeRound.startingBalanceUsdl
      : this.config.startingBalanceUsdl) || this.config.startingBalanceUsdl;
    const peakPortfolioValue = activeRound && this.riskState?.roundNumber === activeRound.roundNumber
      ? this.riskState.peakPortfolioValue
      : 0;
    const drawdownReferenceValue = Math.max(startingBalance, peakPortfolioValue);
    const drawdownPct = portfolioDrawdownPct(portfolio.portfolioValue, drawdownReferenceValue);
    const standing = assessStanding(leaderboard, {
      handle: this.config.handle,
      walletAddress: this.config.walletAddress,
    });
    const tiers = standingTiers(leaderboard?.volumeMultiplierTiers, competition.featuredRound?.volumeMultiplierTiers);
    const volumeMultiplier = volumeMultiplierForStanding(tiers, standing.volume);

    if (drawdownPct >= this.config.maxDrawdownPct) {
      if (this.config.tradingEnabled) {
        const result = await this.api.cancelAll();
        actions.push({ action: "cancel", result: `drawdown-breaker: cancelled ${result.cancelledOrderIds.length}` });
      } else {
        actions.push({ action: "skip", result: "drawdown-breaker dry-run" });
      }
      warnings.push(`Drawdown ${drawdownPct.toFixed(2)}% breached ${this.config.maxDrawdownPct}% limit.`);
      return {
        runId,
        timestamp: new Date(startedAt).toISOString(),
        mode: "halted",
        competition: {
          active: Boolean(activeRound),
          roundNumber: activeRound?.roundNumber ?? null,
          roundStatus: activeRound?.status ?? null,
          admitted,
        },
        fees,
        portfolio: {
          value: portfolio.portfolioValue,
          cash: portfolio.cash,
          frozen: portfolio.frozen,
          pnl: portfolio.portfolioPnl,
          drawdownPct,
        },
        leaderboard: {
          ...standing,
          volumeMultiplier: volumeMultiplier.currentMultiplier,
          nextVolumeThreshold: volumeMultiplier.nextThreshold,
          nextVolumeMultiplier: volumeMultiplier.nextMultiplier,
        },
        decisions,
        actions,
        warnings,
        durationMs: Date.now() - startedAt,
      };
    }

    const positions = positionMap(portfolio.positions);
    const live = marketList.properties.filter((market) => market.status === "LIVE");
    const explicitCompetitionMarkets = activeRound ? live.filter((market) => market.isCompetition === true) : [];
    let eligible = explicitCompetitionMarkets.length > 0 ? explicitCompetitionMarkets : live;
    if (this.config.targetTokens.length > 0) {
      const allowlist = new Set(this.config.targetTokens);
      eligible = eligible.filter((market) => allowlist.has(market.tokenName.toLowerCase()));
    }

    const eligibleByToken = new Map(eligible.map((market) => [market.tokenName.toLowerCase(), market]));
    const positionedMarkets = portfolio.positions
      .map((position) => eligibleByToken.get(position.tokenName.toLowerCase()))
      .filter((market): market is MarketSummary => Boolean(market));
    const ranked = [...eligible]
      .sort(
        (left, right) =>
          marketScore(right, explicitMarketMultiplier(tiers, right)) -
          marketScore(left, explicitMarketMultiplier(tiers, left)),
      );
    const selected: MarketSummary[] = [];
    for (const market of [...positionedMarkets, ...ranked]) {
      if (selected.some((item) => item.propertyId === market.propertyId)) continue;
      selected.push(market);
      if (selected.length >= this.config.maxMarketsPerTick) break;
    }

    const marketSnapshots = await Promise.all(
      selected.map(async (market) => {
        try {
          const [detail, candles] = await Promise.all([
            this.api.getMarketDetail(market.tokenName),
            this.api.getCandles(market.tokenName, "5m", 120),
          ]);
          return { market, detail, candles: candles.candles, error: null as string | null };
        } catch (error) {
          return {
            market,
            detail: null,
            candles: [],
            error: error instanceof Error ? error.message : "unknown market-data error",
          };
        }
      }),
    );

    const grossExposure = portfolioGrossExposure(portfolio);
    for (const snapshot of marketSnapshots) {
      if (!snapshot.detail) {
        warnings.push(`${snapshot.market.tokenName}: ${snapshot.error}`);
        continue;
      }
      decisions.push(
        decideMarket({
          config: this.config,
          market: snapshot.market,
          detail: snapshot.detail,
          candles: snapshot.candles,
          position: positions.get(snapshot.market.tokenName.toLowerCase()),
          portfolioValue: portfolio.portfolioValue,
          cash: portfolio.cash,
          grossExposure,
          drawdownPct,
          makerFeeBps: Number(portfolio.applicableFees?.makerFeeBps ?? competition.makerFeeBps ?? 0),
          takerFeeBps: Number(portfolio.applicableFees?.takerFeeBps ?? competition.takerFeeBps ?? 0),
          riskMode: standing.riskMode,
          multiplier: Math.max(
            volumeMultiplier.currentMultiplier,
            explicitMarketMultiplier(tiers, snapshot.market),
          ),
          calibration: this.calibrations[snapshot.market.tokenName.toLowerCase()],
        }),
      );
    }

    await this.reconcile(activeOrders, decisions, actions, warnings);

    return {
      runId,
      timestamp: new Date(startedAt).toISOString(),
      mode: this.config.tradingEnabled ? "live" : "dry-run",
      competition: {
        active: Boolean(activeRound),
        roundNumber: activeRound?.roundNumber ?? null,
        roundStatus: activeRound?.status ?? null,
        admitted,
      },
      fees: {
        makerFeeBps: Number(portfolio.applicableFees?.makerFeeBps ?? competition.makerFeeBps ?? 0),
        takerFeeBps: Number(portfolio.applicableFees?.takerFeeBps ?? competition.takerFeeBps ?? 0),
      },
      portfolio: {
        value: portfolio.portfolioValue,
        cash: portfolio.cash,
        frozen: portfolio.frozen,
        pnl: portfolio.portfolioPnl,
        drawdownPct,
      },
      leaderboard: {
        ...standing,
        volumeMultiplier: volumeMultiplier.currentMultiplier,
        nextVolumeThreshold: volumeMultiplier.nextThreshold,
        nextVolumeMultiplier: volumeMultiplier.nextMultiplier,
      },
      decisions,
      actions,
      warnings,
      durationMs: Date.now() - startedAt,
    };
  }

  private async reconcile(
    activeOrders: ActiveOrder[],
    decisions: MarketDecision[],
    actions: RunReport["actions"],
    warnings: string[],
  ): Promise<void> {
    const desired = decisions
      .flatMap((decision) => decision.desiredOrders)
      .sort((left, right) => Number(right.side === "SELL") - Number(left.side === "SELL"));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const keep = new Set<number>();
    const coveredKeys = new Set<string>();
    const cancel: ActiveOrder[] = [];

    for (const order of activeOrders) {
      const id = orderId(order);
      if (!id) {
        warnings.push("Ignored an active order with an incomplete API shape.");
        continue;
      }
      if (!order.price || order.price <= 0) {
        warnings.push(`Active order #${id} had no usable price and was marked for cancellation.`);
        cancel.push(order);
        continue;
      }
      const candidate = desired.find(
        (item) =>
          item.propertyId === order.propertyId &&
          item.side === order.side &&
          priceDifferenceBps(item.price, order.price!) <= this.config.repriceThresholdBps,
      );
      const fresh = orderAgeSeconds(order, nowSeconds) <= this.config.quoteTtlSeconds;
      const key = `${order.propertyId}:${order.side}`;
      if (candidate && fresh && !coveredKeys.has(key)) {
        keep.add(id);
        coveredKeys.add(key);
        continue;
      }
      cancel.push(order);
    }

    const blockedProperties = new Set(cancel.slice(20).map((order) => order.propertyId));
    if (cancel.length > 20) {
      warnings.push(`Cancel safety cap reached; ${cancel.length - 20} stale orders deferred and their markets were blocked.`);
    }
    for (const order of cancel.slice(0, 20)) {
      const id = orderId(order);
      if (!id) continue;
      if (!this.config.tradingEnabled) {
        actions.push({
          action: "cancel",
          tokenName: order.tokenName,
          side: order.side,
          orderId: id,
          result: "dry-run",
        });
        continue;
      }
      try {
        const result = await this.api.cancelOrder(id);
        actions.push({
          action: "cancel",
          tokenName: order.tokenName,
          side: order.side,
          orderId: id,
          result: result.success ? "cancelled" : result.errorMessage ?? "cancel rejected",
        });
        if (!result.success) blockedProperties.add(order.propertyId);
      } catch (error) {
        blockedProperties.add(order.propertyId);
        warnings.push(`Cancel #${id} failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }

    let placed = 0;
    for (const order of desired) {
      if (placed >= this.config.maxOrdersPerTick) break;
      if (blockedProperties.has(order.propertyId)) {
        actions.push({
          action: "skip",
          tokenName: order.tokenName,
          side: order.side,
          price: order.price,
          quantity: order.quantity,
          result: "placement blocked because a stale order could not be cancelled",
        });
        continue;
      }
      const alreadyCovered = activeOrders.some((active) => {
        const id = orderId(active);
        return (
          id !== null &&
          keep.has(id) &&
          active.propertyId === order.propertyId &&
          active.side === order.side &&
          active.price !== null &&
          priceDifferenceBps(active.price, order.price) <= this.config.repriceThresholdBps
        );
      });
      if (alreadyCovered) {
        actions.push({
          action: "skip",
          tokenName: order.tokenName,
          side: order.side,
          price: order.price,
          quantity: order.quantity,
          result: "fresh equivalent order already active",
        });
        continue;
      }
      if (!this.config.tradingEnabled) {
        actions.push({
          action: "place",
          tokenName: order.tokenName,
          side: order.side,
          price: order.price,
          quantity: order.quantity,
          result: `dry-run: ${order.rationale.join(",")}`,
        });
        placed += 1;
        continue;
      }
      try {
        const result = await this.api.placeOrder({
          propertyId: order.propertyId,
          tokenName: order.tokenName,
          price: order.price,
          quantity: order.quantity,
          side: order.side,
          type: order.type,
          timeInForce: order.timeInForce,
          deadline: 0,
        });
        actions.push({
          action: "place",
          tokenName: order.tokenName,
          side: order.side,
          orderId: result.orderId,
          price: order.price,
          quantity: order.quantity,
          result: "accepted (fill not guaranteed)",
        });
        placed += 1;
      } catch (error) {
        warnings.push(
          `${order.tokenName} ${order.side} placement failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
  }
}

export function summarizeDesiredOrders(decisions: MarketDecision[]): DesiredOrder[] {
  return decisions.flatMap((decision) => decision.desiredOrders);
}
