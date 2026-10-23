import { NotificationsClient } from "@devopsplaybook.io/common-utils";
import { Config } from "./Config";
import { CLOUDS, cost } from "./CloudDefinitions";
import {
  FETCH_STALE_AFTER_MS,
  GetProviderFetchStatus,
  MarkFetchFailureAlerted,
} from "./FetchStatus";
import { LLM_BALANCE_SOURCES } from "./Metrics";
import { OTelLogger } from "./OTelContext";
import { GetProviderConfigIssues } from "./ProviderConfigCheck";

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

  // Calculate which threshold multiple the current cost corresponds to.
  // The baseline measurement only establishes the reference and never
  // notifies.
  const currentMultiple = Math.floor(totalCost / threshold);
  const previousMultiple = previousThresholdMultiple;
  if (previousMultiple === null) {
    previousThresholdMultiple = currentMultiple;
    return;
  }

  // No new multiple reached (or the cost dropped, e.g. month rollover): stay
  // silent but re-arm the alert.
  if (currentMultiple <= previousMultiple || currentMultiple <= 0) {
    previousThresholdMultiple = currentMultiple;
    return;
  }

  const thresholdAmount = currentMultiple * threshold;
  const budget = config.COST_BUDGET_MONTHLY_USD;

  const title = `Cloud cost threshold reached: $${thresholdAmount.toFixed(2)}`;
  const body = `Total month-to-date cost has reached ${formatUsd(totalCost)} (${buildEnabledCostBreakdown()}). Projected month-end: ${formatUsd(projectedMonthEnd)}${budget > 0 ? ` (${budgetPercent(projectedMonthEnd, budget)}% of budget)` : ""}`;

  const response = await notificationClient.warning(title, body, "cloudcost");
  if (response) {
    // Advance the baseline only after a successful delivery; a failed
    // delivery is retried on the next check.
    previousThresholdMultiple = currentMultiple;
    logger.info(`Threshold notification sent: ${title}`);
  } else {
    logger.warn(
      `Threshold notification delivery failed, retrying on the next check: ${title}`,
    );
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

/**
 * Format a date as `YYYY-MM-DD HH:mm` in UTC (locale-independent) so
 * notification bodies are deterministic regardless of the host locale.
 */
function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Summary table cell for one cloud provider: the latest known cost annotated
 * with the freshness of the underlying data ("data as of ..." when a fetch
 * ever succeeded, "no successful fetch yet" otherwise) plus failure/stale
 * marks when they apply.
 */
function buildSummaryCostCell(cloudKey: string): string {
  const status = GetProviderFetchStatus(cloudKey);
  const total = formatUsd(cost[cloudKey].total);
  const base = status?.lastSuccessAt
    ? `${total} — data as of ${formatTimestamp(status.lastSuccessAt)} UTC`
    : `${total} — no successful fetch yet`;

  const annotations: string[] = [];
  if (status?.lastAttemptSuccess === false) {
    annotations.push("last fetch failed");
  }
  if (
    status?.lastSuccessAt &&
    Date.now() - status.lastSuccessAt.getTime() > FETCH_STALE_AFTER_MS
  ) {
    annotations.push("stale");
  }
  return annotations.length > 0
    ? `${base} (${annotations.join(", ")})`
    : base;
}

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

    // Only notify when a provider crosses into a low-credit state between two
    // consecutive checks: the baseline measurement never notifies and
    // recovering to `ok` is silent
    if (
      state === "ok" ||
      previousState === undefined ||
      previousState === state
    ) {
      previousLLMBalanceStates.set(source.provider, state);
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
      // Commit the new state only after a successful delivery; a failed
      // delivery is retried on the next check while the state still differs.
      previousLLMBalanceStates.set(source.provider, state);
      logger.info(`LLM balance notification sent: ${title}`);
    } else {
      logger.warn(
        `LLM balance notification delivery failed, retrying on the next check: ${title}`,
      );
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

/**
 * Send a `warning` notification for every enabled provider whose fetch has
 * failed at least `COST_FETCH_FAILURE_ALERT_THRESHOLD` consecutive times
 * (`0` disables the check). The notification is transition-only: it fires once
 * when the failure streak first reaches the threshold, stays silent while the
 * streak keeps growing, and is re-armed by a successful fetch (or a restart,
 * which resets the in-memory fetch status). The alert is only marked as
 * delivered after a successful send, so a failed delivery is retried on the
 * next check.
 */
export async function NotificationCheckFetchFailures(): Promise<void> {
  if (!notificationClient || !notificationClient.isEnabled()) {
    return;
  }

  const threshold = config.COST_FETCH_FAILURE_ALERT_THRESHOLD;
  if (threshold <= 0) {
    return;
  }

  for (const cloud of CLOUDS) {
    if (!config[cloud.configFlag]) {
      continue;
    }
    const status = GetProviderFetchStatus(cloud.key);
    if (
      !status ||
      status.consecutiveFailures < threshold ||
      status.failureAlerted
    ) {
      continue;
    }
    const title = `Cloud cost fetch failing: ${cloud.label}`;
    const body = `${cloud.label} cost fetch has failed ${status.consecutiveFailures} consecutive times. Last error: ${status.lastError ?? "unknown"}. Last successful fetch: ${status.lastSuccessAt ? `${formatTimestamp(status.lastSuccessAt)} UTC` : "never"}.`;

    const response = await notificationClient.warning(title, body, "cloudcost");
    if (response) {
      MarkFetchFailureAlerted(cloud.key);
      logger.info(`Fetch failure notification sent: ${title}`);
    } else {
      logger.warn(
        `Fetch failure notification delivery failed, retrying on the next check: ${title}`,
      );
    }
  }

  for (const source of LLM_BALANCE_SOURCES) {
    if (!config[source.configFlag]) {
      continue;
    }
    const status = GetProviderFetchStatus(source.provider);
    if (
      !status ||
      status.consecutiveFailures < threshold ||
      status.failureAlerted
    ) {
      continue;
    }
    const title = `LLM credit fetch failing: ${source.provider}`;
    const body = `${source.provider} credit fetch has failed ${status.consecutiveFailures} consecutive times. Last error: ${status.lastError ?? "unknown"}. Last successful fetch: ${status.lastSuccessAt ? `${formatTimestamp(status.lastSuccessAt)} UTC` : "never"}.`;

    const response = await notificationClient.warning(title, body, "cloudcost");
    if (response) {
      MarkFetchFailureAlerted(source.provider);
      logger.info(`Fetch failure notification sent: ${title}`);
    } else {
      logger.warn(
        `Fetch failure notification delivery failed, retrying on the next check: ${title}`,
      );
    }
  }
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
  if (previousLevelIndex === null) {
    // The baseline measurement only establishes the reference.
    previousBudgetLevel = currentLevelIndex;
  } else if (currentLevelIndex > previousLevelIndex) {
    // Notify once per newly crossed level, in ascending order. Advance the
    // baseline level by level, and only after a successful delivery, so a
    // failed notification is retried (without re-sending the levels already
    // delivered) on the next check.
    let deliveredLevelIndex = previousLevelIndex;
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
      if (!response) {
        logger.warn(
          `Budget notification delivery failed, retrying on the next check: ${title}`,
        );
        break;
      }
      deliveredLevelIndex = i;
      logger.info(`Budget notification sent: ${title}`);
    }
    previousBudgetLevel = deliveredLevelIndex;
  } else {
    // No new level reached (or the spend dropped): stay silent but re-arm.
    previousBudgetLevel = currentLevelIndex;
  }

  const forecastExceeded = projectedMonthEnd > budget;
  const previousForecast = previousForecastExceeded;

  if (previousForecast === null) {
    // The baseline measurement only establishes the reference.
    previousForecastExceeded = forecastExceeded;
  } else if (previousForecast === false && forecastExceeded) {
    const title = "Cloud cost forecast exceeds monthly budget";
    const body = `The projected month-end cost of ${formatUsd(projectedMonthEnd)} exceeds the ${formatUsd(budget)} monthly budget (${budgetPercent(projectedMonthEnd, budget)}%). Total month-to-date cost is currently ${formatUsd(totalCost)} (${buildEnabledCostBreakdown()}).`;

    const response = await notificationClient.warning(title, body, "cloudcost");
    if (response) {
      previousForecastExceeded = true;
      logger.info(`Forecast notification sent: ${title}`);
    } else {
      logger.warn(
        `Forecast notification delivery failed, retrying on the next check: ${title}`,
      );
    }
  } else {
    // Notify once when the projection first exceeds the budget: falling back
    // below the budget is silent but re-arms the alert.
    previousForecastExceeded = forecastExceeded;
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
 * alert bodies. When `includeFetchStatus` is set, provider rows are annotated
 * with the state of their last balance fetch (`(no successful fetch yet)` or
 * `(last fetch failed)`); the Total row is never annotated.
 */
function buildLLMCreditsTable(includeFetchStatus = false): string {
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
      const status = includeFetchStatus
        ? GetProviderFetchStatus(source.provider)
        : undefined;
      const providerLabel = !includeFetchStatus
        ? source.provider
        : status?.lastAttemptSuccess === false
          ? `${source.provider} (last fetch failed)`
          : !status?.lastSuccessAt
            ? `${source.provider} (no successful fetch yet)`
            : source.provider;
      lines.push(`| ${providerLabel} | ${cells.join(" | ")} |`);
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

  const configIssues = GetProviderConfigIssues(config);
  if (configIssues.length > 0) {
    lines.push("## Configuration issues", "");
    for (const { label, missing, invalid } of configIssues) {
      if (missing.length > 0) {
        lines.push(
          `- ${label} is enabled but missing configuration: ${missing.join(", ")}`,
        );
      }
      if (invalid.length > 0) {
        lines.push(
          `- ${label} is enabled but has invalid configuration: ${invalid.join(", ")}`,
        );
      }
    }
    lines.push("");
  }

  lines.push("## Month-to-date cloud costs", "");
  lines.push("| Cloud | Cost |", "| --- | --- |");
  let totalCost = 0;
  for (const cloud of enabledClouds) {
    totalCost += cost[cloud.key].total;
    lines.push(`| ${cloud.label} | ${buildSummaryCostCell(cloud.key)} |`);
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

  lines.push(buildLLMCreditsTable(true));

  return lines.join("\n");
}

// Month names in English for the summary title: formatted in UTC from
// constants so the title is locale-independent.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Send a Markdown summary of the latest known cost metrics for the month:
 * per-cloud month-to-date totals with data freshness, per-service breakdown
 * and LLM credits, plus a configuration-issues section when an enabled
 * provider is missing configuration.
 * No-op when the notifications integration is disabled.
 */
export async function NotificationSendSummary(): Promise<void> {
  if (!notificationClient || !notificationClient.isEnabled()) {
    return;
  }

  const now = new Date();
  const title = `Cloud cost summary — ${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const response = await notificationClient.info(
    title,
    NotificationBuildSummaryBody(),
    "cloudcost",
  );
  if (response) {
    logger.info("Cost summary notification sent");
  }
}
