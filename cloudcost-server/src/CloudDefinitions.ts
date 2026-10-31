import { Span } from "@opentelemetry/sdk-trace";
import { AlibabaCloudGetMonthCurrent } from "./cloud/AlibabaCloudCost";
import { AWSGetMonthCurrent } from "./cloud/AWSCost";
import { AzureGetMonthCurrent } from "./cloud/AzureCost";
import { GoogleCloudGetMonthCurrent } from "./cloud/GoogleCloudCost";
import { CloudflareGetMonthCurrent } from "./cloud/CloudflareCost";
import { GitHubGetMonthCurrent } from "./cloud/GitHubCost";
import { Config } from "./Config";

export interface CloudCost {
  total: number;
  services: Record<string, number>;
}

export interface CloudDefinition {
  key: string;
  label: string;
  configFlag: keyof Config;
  fetcher: (span: Span, config?: Config) => Promise<CloudCost>;
}

export const CLOUDS: CloudDefinition[] = [
  {
    key: "aws",
    label: "AWS",
    configFlag: "COST_ENABLED_AWS",
    fetcher: AWSGetMonthCurrent,
  },
  {
    key: "azure",
    label: "Azure",
    configFlag: "COST_ENABLED_AZURE",
    fetcher: AzureGetMonthCurrent,
  },
  {
    key: "alibabacloud",
    label: "AlibabaCloud",
    configFlag: "COST_ENABLED_ALIBABACLOUD",
    fetcher: AlibabaCloudGetMonthCurrent,
  },
  {
    key: "googlecloud",
    label: "GoogleCloud",
    configFlag: "COST_ENABLED_GOOGLECLOUD",
    fetcher: GoogleCloudGetMonthCurrent,
  },
  {
    key: "cloudflare",
    label: "Cloudflare",
    configFlag: "COST_ENABLED_CLOUDFLARE",
    fetcher: CloudflareGetMonthCurrent,
  },
  {
    key: "github",
    label: "GitHub",
    configFlag: "COST_ENABLED_GITHUB",
    fetcher: GitHubGetMonthCurrent,
  },
];

// Known currencies are initialized to `undefined` (not 0) so a gauge is
// registered for each at startup without reporting a fabricated zero before
// the first successful fetch. A successful fetch replaces the whole set.
export const deepseekBalances: Record<string, number | undefined> = {
  CNY: undefined,
  USD: undefined,
};

export const moonshotAIBalances: Record<string, number | undefined> = {
  USD: undefined,
};

export const zaiBalances: Record<string, number | undefined> = {
  USD: undefined,
};

export const jevBalances: Record<string, number | undefined> = {
  USD: undefined,
};

export const cost: Record<string, CloudCost> = {
  aws: { total: 0, services: {} },
  azure: { total: 0, services: {} },
  alibabacloud: { total: 0, services: {} },
  googlecloud: { total: 0, services: {} },
  cloudflare: { total: 0, services: {} },
  github: { total: 0, services: {} },
};

// GitHub currently has no documented API for a remaining raw-token balance.
// Keep the source extensible without substituting Copilot usage for a balance.
export const githubTokenBalance: { remaining: number | undefined } = {
  remaining: undefined,
};
