import { NotificationsClient } from "@devopsplaybook.io/common-utils";
import { Config } from "./Config";
import { CLOUDS, cost } from "./CloudDefinitions";
import { LLM_BALANCE_SOURCES } from "./Metrics";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("notification-service");

let notificationClient: NotificationsClient | null = null;
let config: Config;

// Track the threshold multiple observed at the previous measurement so a
// notification is sent only when a new multiple is reached between two
// consecutive cost measurements. `null` means no previous measurement yet
// (startup baseline), which never notifies.
let previousThresholdMultiple: number | null = null;

/**
 * Initialize the notification service.
 *
 * The shared client logs the integration status (enabled or disabled) once
 * at construction and never throws on partially configured settings.
 */
export function NotificationInit(configIn: Config): void {
  config = configIn;
  notificationClient = new NotificationsClient({
    apiEndpoint: config.NOTIFICATIONS_API,
    apiToken: config.NOTIFICATIONS_TOKEN,
    logger,
  });
}

/**
 * Check if the total cost has reached a new threshold multiple compared to the
 * previous measurement and send a notification.
 * The first measurement (startup baseline) never notifies; afterwards a
 * notification is sent only when the threshold multiple is higher than the one
 * observed at the previous measurement (e.g., $10, $20, $30).
 */
export async function NotificationCheckThreshold(): Promise<void> {
  if (!notificationClient || !notificationClient.isEnabled()) {
    return;
  }

  const threshold = config.COST_NOTIFICATION_THRESHOLD;
  if (threshold <= 0) {
    return;
  }

  const totalCost = getEnabledTotalCost();
  const projectedMonthEnd = projectMonthEnd(totalCost);

  // Calculate which threshold multiple the current cost corresponds to
  const currentMultiple = Math.floor(totalCost / threshold);
  const previousMultiple = previousThresholdMultiple;
  previousThresholdMultiple = currentMultiple;

  // Only notify when a threshold multiple is newly reached between two
  // consecutive measurements: the baseline measurement never notifies
  if (
    previousMultiple !== null &&
    currentMultiple > previousMultiple &&
    currentMultiple > 0
  ) {
    const thresholdAmount = currentMultiple * threshold;
    const budget = config.COST_BUDGET_MONTHLY_USD;

    const title = `Cloud cost threshold reached: $${thresholdAmount.toFixed(2)}`;
    const body = `Total month-to-date cost has reached ${formatUsd(totalCost)} (${buildEnabledCostBreakdown()}). Projected month-end: ${formatUsd(projectedMonthEnd)}${budget > 0 ? ` (${budgetPercent(projectedMonthEnd, budget)}% of budget)` : ""}`;

    const response = await notificationClient.warning(
      title,
      body,
      "cloudcost",
    );
    if (response) {
      logger.info(`Threshold notification sent: ${title}`);
    }
  }
}

/**
 * Total month-to-date cost summed over every enabled cloud provider.
 */
function getEnabledTotalCost(): number {
  let totalCost = 0;
  for (const cloud of CLOUDS) {
    if (config[cloud.configFlag]) {
      totalCost += cost[cloud.key].total;
    }
  }
  return totalCost;
}

/**
 * Per-cloud breakdown of the month-to-date cost of every enabled provider,
 * e.g. `AWS: $12.00, Azure: $5.00`.
 */
function buildEnabledCostBreakdown(): string {
  return CLOUDS.filter((c) => config[c.configFlag])
    .map((c) => `${c.label}: $${cost[c.key].total.toFixed(2)}`)
    .join(", ");
}

/**
 * Project the month-end cost from the month-to-date total using a linear
 * run-rate in UTC: MTD / days-elapsed × days-in-month.
 */
export function projectMonthEnd(
  totalMtd: number,
  now: Date = new Date(),
): number {
  const daysInMonthUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return (totalMtd / now.getUTCDate()) * daysInMonthUtc;
}

const formatUsd = (amount: number): string => `$${amount.toFixed(2)}`;

const budgetPercent = (amount: number, budget: number): number =>
  Math.round((amount / budget) * 100);

/**
 * Reset the threshold tracking (useful for testing or month rollover).
 * The next measurement re-establishes the baseline and never notifies.
 */
export function NotificationResetThreshold(): void {
  previousThresholdMultiple = null;
}

type LLMBalanceState = "ok" | "warning" | "error";

// Track the severity observed at the previous check for each LLM provider so a
// notification is sent only when a provider crosses into a low-credit state
// between two consecutive checks. A missing entry means no previous
// measurement yet (startup baseline), which never notifies.
const previousLLMBalanceStates = new Map<string, LLMBalanceState>();

/**
 * Check the USD credit balance of every enabled LLM provider and send a
 * notification when a provider drops below the low-credit alert threshold
 * (`warning`) or runs empty (`error`).
 * The first check (startup baseline) never notifies; afterwards a notification
 * is sent only when the state changes into `warning` or `error` between two
 * consecutive checks. Recovering to `ok` is silent but re-arms the alert.
 */
export async function NotificationCheckLLMBalances(): Promise<void> {
  if (!notificationClient || !notificationClient.isEnabled()) {
    return;
  }

  const threshold = config.COST_LLM_BALANCE_ALERT_USD;
  if (threshold <= 0) {
    return;
  }

  for (const source of LLM_BALANCE_SOURCES) {
    if (!config[source.configFlag]) {
      continue;
    }
    const balance = source.balances["USD"];
    if (balance === undefined) {
      continue;
    }
    const state: LLMBalanceState =
      balance <= 0 ? "error" : balance < threshold ? "warning" : "ok";
    const previousState = previousLLMBalanceStates.get(source.provider);
    previousLLMBalanceStates.set(source.provider, state);

    // Only notify when a provider crosses into a low-credit state between two
    // consecutive checks: the baseline measurement never notifies and
    // recovering to `ok` is silent
    if (
      state === "ok" ||
      previousState === undefined ||
      previousState === state
    ) {
      continue;
    }

    const title =
      state === "error"
        ? `LLM credit depleted: ${source.provider}`
        : `LLM credit low: ${source.provider}`;
    const body =
      state === "error"
        ? `${source.provider} remaining credit is empty (${formatUsd(balance)} USD).\n\n${buildLLMCreditsTable()}`
        : `${source.provider} remaining credit dropped below the low-credit alert threshold (${formatUsd(threshold)} USD).\n\n${buildLLMCreditsTable()}`;

    const response =
      state === "error"
        ? await notificationClient.error(title, body, "cloudcost")
        : await notificationClient.warning(title, body, "cloudcost");
    if (response) {
      logger.info(`LLM balance notification sent: ${title}`);
    }
  }
}

/**
 * Reset the LLM balance tracking (useful for testing).
 * The next check re-establishes the baseline and never notifies.
 */
export function NotificationResetLLMBalances(): void {
  previousLLMBalanceStates.clear();
}

// Percentage levels of the monthly budget that trigger a notification when
// the actual month-to-date spend crosses them.
const BUDGET_ALERT_LEVELS = [50, 75, 100];

// Track the highest budget percentage level crossed at the previous check
// (index into BUDGET_ALERT_LEVELS, `-1` when none) so a notification is sent
// only for levels newly crossed between two consecutive checks. `null` means
// no previous check yet (startup baseline), which never notifies.
let previousBudgetLevel: number | null = null;

// Track whether the month-end projection exceeded the budget at the previous
// check so a single forecast notification is sent when it first does.
// `null` means no previous check yet (startup baseline), which never notifies.
let previousForecastExceeded: boolean | null = null;

/**
 * Check the month-to-date spend against the configured monthly budget
 * (`COST_BUDGET_MONTHLY_USD`) and send notifications when it crosses one of
 * the fixed percentage levels (50/75/100%), plus a single notification when
 * the projected month-end cost first exceeds the budget (linear UTC run-rate).
 * Both checks are transition-only: the first check after startup establishes
 * the baseline and never notifies, drops to a lower level or below the budget
 * are silent but re-arm the alerts.
 */
export async function NotificationCheckBudget(): Promise<void> {
  if (!notificationClient || !notificationClient.isEnabled()) {
    return;
  }

  const budget = config.COST_BUDGET_MONTHLY_USD;
  if (budget <= 0) {
    return;
  }

  const totalCost = getEnabledTotalCost();
  const projectedMonthEnd = projectMonthEnd(totalCost);

  let currentLevelIndex = -1;
  for (let i = 0; i < BUDGET_ALERT_LEVELS.length; i++) {
    if (totalCost >= (BUDGET_ALERT_LEVELS[i] / 100) * budget) {
      currentLevelIndex = i;
    }
  }

  const previousLevelIndex = previousBudgetLevel;
  previousBudgetLevel = currentLevelIndex;

  // Notify once per newly crossed level, in ascending order: the baseline
  // never notifies and a drop to a lower level is silent but re-arms
  if (previousLevelIndex !== null && currentLevelIndex > previousLevelIndex) {
    const breakdown = buildEnabledCostBreakdown();
    for (let i = previousLevelIndex + 1; i <= currentLevelIndex; i++) {
      const level = BUDGET_ALERT_LEVELS[i];
      const title = `Cloud cost budget reached: ${level}% of ${formatUsd(budget)} used`;
      const body = `Total month-to-date cost has reached ${formatUsd(totalCost)} (${breakdown}) — ${level}% of the ${formatUsd(budget)} monthly budget. Projected month-end: ${formatUsd(projectedMonthEnd)} (${budgetPercent(projectedMonthEnd, budget)}% of budget).`;

      const response = await notificationClient.warning(
        title,
        body,
        "cloudcost",
      );
      if (response) {
        logger.info(`Budget notification sent: ${title}`);
      }
    }
  }

  const forecastExceeded = projectedMonthEnd > budget;
  const previousForecast = previousForecastExceeded;
  previousForecastExceeded = forecastExceeded;

  // Notify once when the projection first exceeds the budget: the baseline
  // never notifies and falling back below the budget is silent but re-arms
  if (previousForecast === false && forecastExceeded) {
    const title = "Cloud cost forecast exceeds monthly budget";
    const body = `The projected month-end cost of ${formatUsd(projectedMonthEnd)} exceeds the ${formatUsd(budget)} monthly budget (${budgetPercent(projectedMonthEnd, budget)}%). Total month-to-date cost is currently ${formatUsd(totalCost)} (${buildEnabledCostBreakdown()}).`;

    const response = await notificationClient.warning(title, body, "cloudcost");
    if (response) {
      logger.info(`Forecast notification sent: ${title}`);
    }
  }
}

/**
 * Reset the budget and forecast tracking (useful for testing or month
 * rollover). The next check re-establishes the baseline and never notifies.
 */
export function NotificationResetBudget(): void {
  previousBudgetLevel = null;
  previousForecastExceeded = null;
}

/**
 * Build the Markdown "LLM remaining credits" table (all enabled providers ×
 * currencies with totals) shared by the monthly summary and the low-credit
 * alert bodies.
 */
function buildLLMCreditsTable(): string {
  const lines: string[] = ["## LLM remaining credits", ""];
  const currencies = new Set<string>();
  for (const source of LLM_BALANCE_SOURCES) {
    if (config[source.configFlag]) {
      for (const currency of Object.keys(source.balances)) {
        currencies.add(currency);
      }
    }
  }
  const currencyList = Array.from(currencies).sort();
  if (currencyList.length === 0) {
    lines.push("No LLM credit tracking enabled.");
  } else {
    lines.push(
      `| Provider | ${currencyList.join(" | ")} |`,
      `| ${currencyList.map(() => "---").join(" | ")} |`,
    );
    for (const source of LLM_BALANCE_SOURCES) {
      if (!config[source.configFlag]) {
        continue;
      }
      const cells = currencyList.map((currency) => {
        const value = source.balances[currency];
        return value !== undefined && value > 0 ? value.toFixed(2) : "-";
      });
      lines.push(`| ${source.provider} | ${cells.join(" | ")} |`);
    }
    const totalCells = currencyList.map((currency) => {
      let currencyTotal = 0;
      let hasCredit = false;
      for (const source of LLM_BALANCE_SOURCES) {
        if (!config[source.configFlag]) {
          continue;
        }
        const value = source.balances[currency];
        if (value !== undefined && value > 0) {
          currencyTotal += value;
          hasCredit = true;
        }
      }
      return hasCredit ? `**${currencyTotal.toFixed(2)}**` : "-";
    });
    lines.push(`| **Total** | ${totalCells.join(" | ")} |`);
  }

  return lines.join("\n");
}

/**
 * Build the Markdown body of the monthly cost summary from the latest known
 * in-memory metrics (the same data the OTel gauges in Metrics.ts expose).
 */
export function NotificationBuildSummaryBody(): string {
  const lines: string[] = [];
  const enabledClouds = CLOUDS.filter((cloud) => config[cloud.configFlag]);

  lines.push("## Month-to-date cloud costs", "");
  lines.push("| Cloud | Cost |", "| --- | --- |");
  let totalCost = 0;
  for (const cloud of enabledClouds) {
    totalCost += cost[cloud.key].total;
    lines.push(`| ${cloud.label} | ${formatUsd(cost[cloud.key].total)} |`);
  }
  lines.push(`| **Total** | **${formatUsd(totalCost)}** |`, "");

  const now = new Date();
  const projectedMonthEnd = projectMonthEnd(totalCost, now);
  const budget = config.COST_BUDGET_MONTHLY_USD;

  lines.push("## Month-end projection", "");
  lines.push("| Metric | Value |", "| --- | --- |");
  lines.push(
    `| Daily average | ${formatUsd(totalCost / now.getUTCDate())} |`,
    `| Projected month-end | ${formatUsd(projectedMonthEnd)} |`,
  );
  if (budget > 0) {
    lines.push(`| Monthly budget | ${formatUsd(budget)} |`);
    lines.push(
      `| Budget usage | ${budgetPercent(totalCost, budget)}% (${formatUsd(totalCost)} of ${formatUsd(budget)}) |`,
      `| Projected vs budget | ${budgetPercent(projectedMonthEnd, budget)}% |`,
    );
  }
  lines.push("");

  lines.push("## Cost by service", "");
  for (const cloud of enabledClouds) {
    lines.push(`### ${cloud.label}`, "");
    lines.push("| Service | Cost |", "| --- | --- |");
    const serviceEntries = Object.entries(cost[cloud.key].services);
    if (serviceEntries.length === 0) {
      lines.push("| (none) | |");
    } else {
      for (const [service, amount] of serviceEntries) {
        lines.push(`| ${service} | ${formatUsd(amount)} |`);
      }
    }
    lines.push("");
  }

  lines.push(buildLLMCreditsTable());

  return lines.join("\n");
}

/**
 * Send a Markdown summary of the latest known cost metrics for the month:
 * per-cloud month-to-date totals, per-service breakdown and LLM credits.
 * No-op when the notifications integration is disabled.
 */
export async function NotificationSendSummary(): Promise<void> {
  if (!notificationClient || !notificationClient.isEnabled()) {
    return;
  }

  const title = "Cloud cost monthly summary";
  const response = await notificationClient.info(
    title,
    NotificationBuildSummaryBody(),
    "cloudcost",
  );
  if (response) {
    logger.info("Monthly cost summary notification sent");
  }
}
