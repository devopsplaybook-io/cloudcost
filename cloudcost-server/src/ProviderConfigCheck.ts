import { Config } from "./Config";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("provider-config");

const GITHUB_ACCOUNT_TYPES = ["organization", "user"];
const OPENROUTER_KEY_PREFIX = "sk-or-v1-";

function missingEnvKeys(keys: string[]): string[] {
  return keys.filter((key) => !process.env[key]);
}

const PROVIDER_CHECKS: {
  label: string;
  configFlag: keyof Config;
  missing: (config: Config) => string[];
  invalid?: (config: Config) => string[];
}[] = [
  {
    label: "Azure",
    configFlag: "COST_ENABLED_AZURE",
    missing: () =>
      missingEnvKeys([
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
      ]).concat(
        process.env.AZURE_SUBSCRIPTION_ID || process.env.AZURE_COST_SCOPE
          ? []
          : ["AZURE_SUBSCRIPTION_ID or AZURE_COST_SCOPE"],
      ),
  },
  {
    label: "AlibabaCloud",
    configFlag: "COST_ENABLED_ALIBABACLOUD",
    missing: () =>
      missingEnvKeys(["ALIBABACLOUD_ACCESS_KEY_ID", "ALIBABACLOUD_SECRET_KEY"]),
  },
  {
    label: "GoogleCloud",
    configFlag: "COST_ENABLED_GOOGLECLOUD",
    missing: () =>
      missingEnvKeys([
        "GOOGLECLOUD_BILLING_PROJECT_ID",
        "GOOGLECLOUD_BILLING_DATASET",
        "GOOGLECLOUD_BILLING_TABLE",
      ]),
  },
  {
    label: "Cloudflare",
    configFlag: "COST_ENABLED_CLOUDFLARE",
    missing: () =>
      missingEnvKeys(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]),
  },
  {
    label: "GitHub",
    configFlag: "COST_ENABLED_GITHUB",
    missing: (config) =>
      missingEnvKeys(["GITHUB_TOKEN"]).concat(
        process.env.GITHUB_ACCOUNT || config.GITHUB_ACCOUNT
          ? []
          : ["GITHUB_ACCOUNT"],
      ),
    invalid: (config) => {
      const accountType =
        process.env.GITHUB_ACCOUNT_TYPE ||
        config.GITHUB_ACCOUNT_TYPE ||
        "organization";
      if (GITHUB_ACCOUNT_TYPES.includes(accountType)) {
        return [];
      }
      return [
        `GITHUB_ACCOUNT_TYPE must be one of ${GITHUB_ACCOUNT_TYPES.join(", ")} (got '${accountType}')`,
      ];
    },
  },
  {
    label: "DeepSeek",
    configFlag: "COST_ENABLED_DEEPSEEK",
    missing: () => missingEnvKeys(["DEEPSEEK_API_KEY"]),
  },
  {
    label: "Moonshot AI",
    configFlag: "COST_ENABLED_MOONSHOTAI",
    missing: () => missingEnvKeys(["MOONSHOTAI_API_KEY"]),
  },
  {
    label: "Z.AI",
    configFlag: "COST_ENABLED_ZAI",
    missing: () => missingEnvKeys(["ZAI_API_KEY"]),
  },
  {
    label: "Jev",
    configFlag: "COST_ENABLED_JEV",
    missing: () => missingEnvKeys(["JEV_API_KEY"]),
    invalid: () => {
      const apiKey = process.env.JEV_API_KEY;
      if (!apiKey || apiKey.startsWith(OPENROUTER_KEY_PREFIX)) {
        return [];
      }
      return [
        `JEV_API_KEY must be an OpenRouter key (${OPENROUTER_KEY_PREFIX}...) to read a remaining credit`,
      ];
    },
  },
];

export interface ProviderConfigIssue {
  label: string;
  missing: string[];
  invalid: string[];
}

/**
 * Evaluate the provider configuration rules and return every enabled provider
 * with missing or invalid configuration (AWS is not checked: it relies on the
 * SDK default credential chain).
 */
export function GetProviderConfigIssues(config: Config): ProviderConfigIssue[] {
  return PROVIDER_CHECKS.filter((check) => config[check.configFlag])
    .map((check) => ({
      label: check.label,
      missing: check.missing(config),
      invalid: check.invalid?.(config) ?? [],
    }))
    .filter(
      ({ missing, invalid }) => missing.length > 0 || invalid.length > 0,
    );
}

/**
 * Log a consolidated report of enabled providers with missing or invalid
 * configuration at startup so a misconfiguration is visible immediately
 * instead of being discovered one failed fetch at a time.
 */
export function ValidateProviderConfigs(config: Config): void {
  const issues = GetProviderConfigIssues(config);

  if (issues.length === 0) {
    logger.info("All enabled providers have their required configuration");
    return;
  }
  for (const { label, missing, invalid } of issues) {
    if (missing.length > 0) {
      logger.warn(
        `Provider ${label} is enabled but missing configuration: ${missing.join(", ")}`,
      );
    }
    if (invalid.length > 0) {
      logger.warn(
        `Provider ${label} is enabled but has invalid configuration: ${invalid.join(", ")}`,
      );
    }
  }
}
