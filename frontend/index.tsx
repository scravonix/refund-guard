import {
  Field,
  TextField,
  Toggle,
  ChromeDevToolsProtocol,
  Navigation,
  definePlugin,
  findModuleExport,
  getParentWindow,
  toaster,
} from "millennium";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const DEBUG_DIAGNOSTICS = false;
const PLUGIN_VERSION = "1.0.0";
const BACKEND_API_VERSION = 1;
const MIN_MILLENNIUM_VERSION = "3.4.1";
const CURRENT_STATE_SCHEMA_VERSION = 1;
const BUILD_CHANNEL = "RELEASE";

function debugLog(...args: unknown[]): void {
  if (DEBUG_DIAGNOSTICS) {
    console.log(...args);
  }
}

const MAX_PERSISTED_RESULTS = 100;
const MAX_PRICE_BASELINES = 500;
const MAX_PAID_PRICE_CACHE_ENTRIES = 1000;
const MAX_PERSISTED_JSON_CHARACTERS = 2_000_000;
const CACHE_RETENTION_SECONDS = 365 * 86400;
const LIBRARY_READY_ATTEMPTS = 4;
const LIBRARY_READY_RETRY_MS = 450;
const AUTO_SCAN_FAILURE_BACKOFF_MINUTES = 10;
const VALID_CURRENCY_CODE = /^[A-Z]{3}$/;

type PriceAvailabilityReason =
  | "store_unavailable"
  | "free_or_zero"
  | "package_not_sold"
  | "currency_mismatch";

type DataFreshness = "fresh" | "saved";

type GuardTab = "status" | "config";

type SteamAppOverviewLike = {
  appid?: number;
  display_name?: string;
  rt_purchased_time?: number;
  minutes_playtime_forever?: number;
  app_type?: number;
  mastersub_appid?: number;
  mastersub_includedwith_logo?: string;
  BIsModOrShortcut?: () => boolean;
};

type SteamAppStoreLike = {
  GetAppOverviewByAppID?: (appId: number) => SteamAppOverviewLike | undefined;
  m_mapApps?: {
    values?: () => IterableIterator<SteamAppOverviewLike>;
  };
};

type StorePackageOption = {
  package_id: number;
  option_text: string;
  price: number;
  percent_savings: number;
};

type StoreDetails = {
  ok: boolean;
  app_id: number;
  error?: string;
  name?: string;
  header_image?: string;
  store_type?: string;
  fullgame_app_id?: number;
  fullgame_name?: string;
  is_free?: boolean;
  has_price?: boolean;
  currency?: string;
  initial?: number;
  final?: number;
  discount_percent?: number;
  formatted_initial?: string;
  formatted_final?: string;
  package_options?: StorePackageOption[];
};

type PackageApp = {
  id: number;
  name: string;
};

type PackageDetails = {
  ok: boolean;
  package_id: number;
  error?: string;
  name?: string;
  apps?: PackageApp[];
  has_price?: boolean;
  currency?: string;
  initial?: number;
  final?: number;
  discount_percent?: number;
  formatted_initial?: string;
  formatted_final?: string;
};

type DlcLike = {
  unAppID?: number;
  strName?: string;
  rtPurchaseDate?: number;
  bEnabled?: boolean;
  bAvailableOnStore?: boolean;
};

type PurchaseKind = "app" | "package" | "edition_unresolved";

type PlaytimeEligibility = "within" | "outside" | "uncertain";

type DlcPlaytimeEvidence =
  | "not_applicable"
  | "no_play_since_purchase"
  | "lifetime_upper_bound"
  | "last_two_weeks_upper_bound"
  | "last_two_weeks_lower_bound"
  | "aggregate_only"
  | "unavailable";

type SteamPlaytimeLike = {
  nPlaytimeLastTwoWeeks?: number;
  nPlaytimeForever?: number;
  rtLastTimePlayed?: number;
};

type DlcPlaytimeResolution = {
  eligibility: PlaytimeEligibility;
  evidence: DlcPlaytimeEvidence;
  recentMinutes: number;
  foreverMinutes: number;
  lastPlayed: number;
  upperBoundMinutes?: number;
  lowerBoundMinutes?: number;
  explanation: string;
};

type PriceBaseline = {
  price: number;
  currency: string;
  formatted: string;
  observed_at: number;
};

type PriceBaselineMap = Record<string, PriceBaseline>;

type PurchaseHistoryRow = {
  itemText: string;
  itemLines: string[];
  typeText: string;
  totalText: string;
  dateText: string;
  dateSeconds: number;
  itemCount: number;
  transactionId: string;
};

type PurchaseHistorySnapshot = {
  status: "ok" | "signed_out" | "unavailable";
  rows: PurchaseHistoryRow[];
  error?: string;
  pagesLoaded?: number;
  hasMore?: boolean;
  // Ephemeral authentication material. Never logged or persisted.
  cookieHeader?: string;
};

type PaidPriceMatch = {
  price: number;
  formatted: string;
  currency: string;
  source: "steam_purchase_history" | "cached_purchase_history";
  confidence: "exact_single_item" | "exact_receipt_line_item";
};

type PaidPriceCacheEntry = {
  appId: number;
  purchaseTime: number;
  purchaseKind: PurchaseKind;
  packageId: number;
  price: number;
  formatted: string;
  currency: string;
  source: "steam_purchase_history";
  confidence: "exact_single_item" | "exact_receipt_line_item";
  resolvedAt: number;
};

type PaidPriceCacheMap = Record<string, PaidPriceCacheEntry>;

type ScanState =
  | "monitoring"
  | "opportunity"
  | "price_drop_outside_playtime"
  | "price_drop_outside_window"
  | "price_drop_outside_both"
  | "price_drop_playtime_uncertain"
  | "price_drop_not_eligible"
  | "over_playtime"
  | "price_unavailable";

type PriceComparisonSource = "actual_paid" | "observed_baseline";

type OpportunityEvaluation = {
  referencePrice: number;
  currentPrice: number;
  savings: number;
  dropPercent: number;
  minimumDropPercent: number;
  meaningfulDrop: boolean;
  withinDate: boolean;
  withinPlaytime: boolean | null;
  playtimeEligibility: PlaytimeEligibility;
  eligibleByRules: boolean;
  state: ScanState;
};

type ScanResult = {
  appId: number;
  name: string;
  headerImage: string;
  purchaseTime: number;
  ageDays: number;
  playtimeMinutes: number;
  currentPrice: number;
  currentPriceFormatted: string;
  currency: string;
  dataFreshness?: DataFreshness;
  refreshError?: string;
  priceAvailabilityReason?: PriceAvailabilityReason;
  historicalPaidPriceFormatted?: string;
  historicalPaidCurrency?: string;
  steamDiscountPercent: number;
  baselinePrice: number;
  baselineFormatted: string;
  observedDropPercent: number;
  observedSavings: number;
  priceDropPercent?: number;
  savings?: number;
  comparisonSource?: PriceComparisonSource;
  comparisonPrice?: number;
  comparisonPriceFormatted?: string;
  comparisonEstablished?: boolean;
  minimumDropPercent?: number;
  refundWindowDays?: number;
  playtimeLimitMinutes?: number;
  withinDate?: boolean;
  withinPlaytime?: boolean | null;
  playtimeEligibility?: PlaytimeEligibility;
  meaningfulDrop?: boolean;
  isStandaloneDlc?: boolean;
  underlyingAppId?: number;
  underlyingGameName?: string;
  underlyingPlaytimeLastTwoWeeks?: number;
  underlyingPlaytimeForever?: number;
  underlyingLastPlayed?: number;
  dlcPlaytimeEvidence?: DlcPlaytimeEvidence;
  dlcPlaytimeExplanation?: string;
  dlcPlaytimeUpperBoundMinutes?: number;
  dlcPlaytimeLowerBoundMinutes?: number;
  eligibleByRules: boolean;
  state: ScanState;
  reason: string;
  purchaseKind: PurchaseKind;
  packageId: number;
  baseGameName: string;
  baseGamePriceFormatted: string;
  components: string[];
  separateComponents?: string[];
  purchaseClassification?: "base_only" | "edition" | "separate" | "uncertain" | "dlc";
  paidPrice?: number;
  paidPriceFormatted?: string;
  paidPriceSource?: "steam_purchase_history" | "cached_purchase_history";
  paidPriceConfidence?: "exact_single_item" | "exact_receipt_line_item";
};

const VALID_SCAN_STATES = new Set<ScanState>([
  "monitoring",
  "opportunity",
  "price_drop_outside_playtime",
  "price_drop_outside_window",
  "price_drop_outside_both",
  "price_drop_playtime_uncertain",
  "price_drop_not_eligible",
  "over_playtime",
  "price_unavailable",
]);

const VALID_PURCHASE_KINDS = new Set<PurchaseKind>([
  "app",
  "package",
  "edition_unresolved",
]);

type ScannerSummary = {
  total: number;
  opportunities: number;
  otherPriceDrops: number;
  monitoring: number;
  unresolved: number;
};

type NotificationFingerprintEntry = {
  appId: number;
  packageId: number;
  purchaseTime: number;
  fingerprint: string;
  state: ScanState;
  currentPrice: number;
  comparisonPrice: number;
  currency: string;
  notifiedAt: number;
};

type NotificationFingerprintMap = Record<string, NotificationFingerprintEntry>;

type RefundGuardUserConfig = {
  enabled: boolean;
  notify_price_drops: boolean;
  auto_scan_enabled: boolean;
  include_dlc: boolean;
  strict_eligibility: boolean;
  refund_window_days: number;
  playtime_limit_minutes: number;
  minimum_discount_percent: number;
  scan_interval_minutes: number;
};

type RefundGuardPersistentSnapshot = RefundGuardUserConfig & {
  price_baselines_json: string;
  paid_price_cache_json: string;
  notification_fingerprints_json: string;
  last_results_json: string;
  last_scan_time: number;
  state_schema_version: number;
};

type BackendOperationResult = {
  ok?: boolean;
  error?: string;
};

type BackendAutoScheduleResult = BackendOperationResult & {
  first?: boolean;
  claimed?: boolean;
};

type BackendRuntimeInfo = BackendOperationResult & {
  plugin_version?: string;
  backend_api_version?: number;
  state_schema_version?: number;
  millennium_version?: string;
};

type RuntimeCompatibility = {
  compatible: boolean;
  message: string;
  millenniumVersion: string;
};

const DEFAULT_USER_CONFIG: RefundGuardUserConfig = {
  enabled: true,
  notify_price_drops: true,
  auto_scan_enabled: false,
  include_dlc: false,
  strict_eligibility: true,
  refund_window_days: 14,
  playtime_limit_minutes: 120,
  minimum_discount_percent: 10,
  scan_interval_minutes: 60,
};

const DEFAULT_PERSISTENT_SNAPSHOT: RefundGuardPersistentSnapshot = {
  ...DEFAULT_USER_CONFIG,
  price_baselines_json: "{}",
  paid_price_cache_json: "{}",
  notification_fingerprints_json: "{}",
  last_results_json: "[]",
  last_scan_time: 0,
  state_schema_version: CURRENT_STATE_SCHEMA_VERSION,
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asFiniteNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, numeric));
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizePersistentSnapshot(
  raw: unknown,
): RefundGuardPersistentSnapshot {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  return {
    enabled: asBoolean(value.enabled, DEFAULT_USER_CONFIG.enabled),
    notify_price_drops: asBoolean(
      value.notify_price_drops,
      DEFAULT_USER_CONFIG.notify_price_drops,
    ),
    auto_scan_enabled: asBoolean(
      value.auto_scan_enabled,
      DEFAULT_USER_CONFIG.auto_scan_enabled,
    ),
    include_dlc: asBoolean(
      value.include_dlc,
      DEFAULT_USER_CONFIG.include_dlc,
    ),
    strict_eligibility: asBoolean(
      value.strict_eligibility,
      DEFAULT_USER_CONFIG.strict_eligibility,
    ),
    refund_window_days: asFiniteNumber(
      value.refund_window_days,
      DEFAULT_USER_CONFIG.refund_window_days,
      1,
      90,
    ),
    playtime_limit_minutes: asFiniteNumber(
      value.playtime_limit_minutes,
      DEFAULT_USER_CONFIG.playtime_limit_minutes,
      1,
      10000,
    ),
    minimum_discount_percent: asFiniteNumber(
      value.minimum_discount_percent,
      DEFAULT_USER_CONFIG.minimum_discount_percent,
      1,
      100,
    ),
    scan_interval_minutes: asFiniteNumber(
      value.scan_interval_minutes,
      DEFAULT_USER_CONFIG.scan_interval_minutes,
      30,
      1440,
    ),
    price_baselines_json: asString(
      value.price_baselines_json,
      DEFAULT_PERSISTENT_SNAPSHOT.price_baselines_json,
    ),
    paid_price_cache_json: asString(
      value.paid_price_cache_json,
      DEFAULT_PERSISTENT_SNAPSHOT.paid_price_cache_json,
    ),
    notification_fingerprints_json: asString(
      value.notification_fingerprints_json,
      DEFAULT_PERSISTENT_SNAPSHOT.notification_fingerprints_json,
    ),
    last_results_json: asString(
      value.last_results_json,
      DEFAULT_PERSISTENT_SNAPSHOT.last_results_json,
    ),
    last_scan_time: asFiniteNumber(
      value.last_scan_time,
      DEFAULT_PERSISTENT_SNAPSHOT.last_scan_time,
      0,
      4102444800,
    ),
    state_schema_version: Math.max(
      0,
      Math.floor(
        asFiniteNumber(
          value.state_schema_version,
          DEFAULT_PERSISTENT_SNAPSHOT.state_schema_version,
          0,
          1000,
        ),
      ),
    ),
  };
}

function parseVersionTuple(value: string): number[] {
  const matched = String(value || "").match(/\d+/g) ?? [];
  return matched.slice(0, 4).map((part) => Math.max(0, Number(part) || 0));
}

function versionAtLeast(current: string, minimum: string): boolean {
  const left = parseVersionTuple(current);
  const right = parseVersionTuple(minimum);
  const length = Math.max(left.length, right.length, 3);

  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }

  return true;
}

function frontendCapabilityFailures(): string[] {
  const failures: string[] = [];
  const cdp = ChromeDevToolsProtocol as unknown as { send?: unknown };

  if (typeof cdp?.send !== "function") {
    failures.push("Steam webhelper CDP bridge");
  }
  if (typeof Navigation.NavigateToSteamWeb !== "function") {
    failures.push("Steam-native navigation");
  }
  if (typeof Navigation.NavigateToExternalWeb !== "function") {
    failures.push("external navigation fallback");
  }
  if (typeof toaster?.toast !== "function") {
    failures.push("Steam notification toaster");
  }

  return failures;
}

async function verifyRuntimeCompatibility(): Promise<RuntimeCompatibility> {
  if (typeof backend.getRuntimeInfoJson !== "function") {
    return {
      compatible: false,
      message: "Refund Guard backend compatibility API is unavailable. Fully restart Steam after updating the plugin.",
      millenniumVersion: "",
    };
  }

  const raw = await backend.getRuntimeInfoJson();
  const info = parseBackendObject<BackendRuntimeInfo>(raw);

  if (!info || info.ok !== true) {
    return {
      compatible: false,
      message: info?.error || "Refund Guard could not verify its backend runtime.",
      millenniumVersion: "",
    };
  }

  const backendVersion = String(info.plugin_version || "").trim();
  const millenniumVersion = String(info.millennium_version || "").trim();
  const backendApiVersion = Math.floor(Number(info.backend_api_version) || 0);
  const backendSchemaVersion = Math.floor(Number(info.state_schema_version) || 0);

  if (backendVersion !== PLUGIN_VERSION) {
    return {
      compatible: false,
      message: `Refund Guard frontend ${PLUGIN_VERSION} is paired with backend ${backendVersion || "unknown"}. Fully restart Steam after updating the plugin.`,
      millenniumVersion,
    };
  }

  if (backendApiVersion !== BACKEND_API_VERSION) {
    return {
      compatible: false,
      message: `Refund Guard backend API ${backendApiVersion || "unknown"} does not match required API ${BACKEND_API_VERSION}. Fully restart Steam or reinstall this Refund Guard build.`,
      millenniumVersion,
    };
  }

  if (backendSchemaVersion !== CURRENT_STATE_SCHEMA_VERSION) {
    return {
      compatible: false,
      message: `Refund Guard backend supports state schema ${backendSchemaVersion}, but this frontend expects schema ${CURRENT_STATE_SCHEMA_VERSION}.`,
      millenniumVersion,
    };
  }

  if (!millenniumVersion || !versionAtLeast(millenniumVersion, MIN_MILLENNIUM_VERSION)) {
    return {
      compatible: false,
      message: `Refund Guard ${PLUGIN_VERSION} requires Millennium ${MIN_MILLENNIUM_VERSION} or newer. Detected: ${millenniumVersion || "unknown"}.`,
      millenniumVersion,
    };
  }

  const capabilityFailures = frontendCapabilityFailures();
  if (capabilityFailures.length > 0) {
    return {
      compatible: false,
      message: `This Steam/Millennium runtime is missing required capability: ${capabilityFailures.join(", ")}.`,
      millenniumVersion,
    };
  }

  return { compatible: true, message: "", millenniumVersion };
}

async function readPersistentSnapshot(): Promise<RefundGuardPersistentSnapshot> {
  const raw = await backend.getConfigSnapshotJson();
  const decoded = parseBackendObject<Record<string, unknown>>(raw);

  if (!decoded) {
    throw new Error("Refund Guard backend returned an invalid config snapshot.");
  }

  return normalizePersistentSnapshot(decoded);
}

async function persistUserConfig(
  config: RefundGuardUserConfig,
): Promise<void> {
  // Important: the FFI boundary receives ONE string argument only.
  // This avoids Millennium 3.4.1's frontend config bridge type mismatch.
  const raw = await backend.setUserConfigJson(JSON.stringify(config));
  const result = parseBackendObject<BackendOperationResult>(raw);

  if (!result || result.ok !== true) {
    throw new Error(result?.error || "Refund Guard could not save Config.");
  }
}

async function persistScanState(
  baselinesJson: string,
  paidPriceCacheJson: string,
  notificationFingerprintsJson: string,
  resultsJson: string,
  lastScanTime: number,
): Promise<void> {
  const raw = await backend.saveScanStateJson(
    JSON.stringify({
      price_baselines_json: baselinesJson,
      paid_price_cache_json: paidPriceCacheJson,
      notification_fingerprints_json: notificationFingerprintsJson,
      last_results_json: resultsJson,
      last_scan_time: lastScanTime,
    }),
  );

  const result = parseBackendObject<BackendOperationResult>(raw);

  if (!result || result.ok !== true) {
    throw new Error(
      result?.error || "Refund Guard could not persist scanner state.",
    );
  }
}

async function registerAutoScheduleOnce(scheduleKey: string): Promise<boolean> {
  try {
    const raw = await backend.registerAutoScheduleJson(scheduleKey);
    const result = parseBackendObject<BackendAutoScheduleResult>(raw);
    return Boolean(result?.ok && result.first);
  } catch (error) {
    console.warn(
      "[Refund Guard] Automatic schedule registration failed; continuing silently",
      error,
    );
    return false;
  }
}

async function claimAutomaticScanDue(scheduleKey: string): Promise<boolean> {
  try {
    const raw = await backend.claimAutoScanDueJson(
      scheduleKey,
      Math.floor(Date.now() / 1000),
    );
    const result = parseBackendObject<BackendAutoScheduleResult>(raw);
    return Boolean(result?.ok && result.claimed);
  } catch (error) {
    console.warn(
      "[Refund Guard] Automatic due-claim failed; automatic scan skipped",
      error,
    );
    return false;
  }
}

let cachedAppStore: SteamAppStoreLike | null = null;

// Steam can mount more than one copy of the plugin panel. Component-local refs
// are therefore not sufficient to prevent duplicate startup scans. Keep a
// module-level lock so only one Refund Guard scan can execute at a time.
let globalScanRunning = false;
let globalAutoScanTimer: number | null = null;
let globalAutoScheduleKey = "";
let globalAutoScheduleAnchorMs = 0;
let globalAutoRetryNotBeforeMs = 0;
let globalAutoScanEnabled = false;
let globalAutomaticScanRunner: (() => Promise<void>) | null = null;
let globalAutomaticReschedule: (() => void) | null = null;

function clearGlobalAutoScanTimer(): void {
  if (globalAutoScanTimer !== null) {
    window.clearTimeout(globalAutoScanTimer);
    globalAutoScanTimer = null;
  }

  globalAutoScheduleKey = "";
}

function locateSteamAppStore(): SteamAppStoreLike {
  if (
    cachedAppStore &&
    cachedAppStore.m_mapApps &&
    typeof cachedAppStore.m_mapApps.values === "function"
  ) {
    return cachedAppStore;
  }

  const located = findModuleExport((candidate: unknown) => {
    try {
      if (!candidate || typeof candidate !== "object") {
        return false;
      }

      const value = candidate as SteamAppStoreLike;

      return (
        typeof value.GetAppOverviewByAppID === "function" &&
        !!value.m_mapApps &&
        typeof value.m_mapApps.values === "function"
      );
    } catch {
      return false;
    }
  }) as SteamAppStoreLike | undefined;

  if (!located) {
    throw new Error(
      "Refund Guard could not locate Steam's loaded library store on this Steam client build.",
    );
  }

  cachedAppStore = located;
  return located;
}

function getLoadedSteamApps(): SteamAppOverviewLike[] {
  const store = locateSteamAppStore();

  if (!store.m_mapApps || typeof store.m_mapApps.values !== "function") {
    throw new Error("Steam library app map is not available.");
  }

  return Array.from(store.m_mapApps.values());
}

async function getLoadedSteamAppsWhenReady(): Promise<SteamAppOverviewLike[]> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= LIBRARY_READY_ATTEMPTS; attempt += 1) {
    try {
      const apps = getLoadedSteamApps();
      if (apps.length > 0) return apps;
      lastError = new Error("Steam library metadata is still empty.");
    } catch (error) {
      lastError = error;
    }

    if (attempt < LIBRARY_READY_ATTEMPTS) {
      await waitMs(LIBRARY_READY_RETRY_MS);
    }
  }

  throw new Error(
    `Steam library metadata is not ready after ${LIBRARY_READY_ATTEMPTS} attempts. Saved results were kept unchanged.${
      lastError instanceof Error && lastError.message ? ` (${lastError.message})` : ""
    }`,
  );
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumberOr(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cleanStringArray(value: unknown, maximum = 32): string[] {
  if (!Array.isArray(value)) return [];

  const output: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const text = String(entry ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= maximum) break;
  }

  return output;
}

function normalizeCurrencyCode(value: unknown): string {
  const currency = String(value ?? "").trim().toUpperCase();
  return VALID_CURRENCY_CODE.test(currency) ? currency : "";
}

function currenciesMatch(left: unknown, right: unknown): boolean {
  const a = normalizeCurrencyCode(left);
  const b = normalizeCurrencyCode(right);
  return Boolean(a && b && a === b);
}

function purchaseScopedBaselineKey(target: {
  appId: number;
  purchaseTime: number;
  purchaseKind: PurchaseKind;
  packageId: number;
}): string {
  const purchaseTime = Math.max(0, Math.floor(Number(target.purchaseTime) || 0));
  const productKey =
    target.purchaseKind === "package" && target.packageId > 0
      ? `package:${Math.floor(target.packageId)}`
      : `app:${Math.floor(target.appId)}`;
  return `${productKey}:purchase:${purchaseTime}`;
}

function pruneLegacyUnscopedBaselines(cache: PriceBaselineMap): number {
  let removed = 0;

  for (const key of Object.keys(cache)) {
    if (/^(?:app|package):\d+$/.test(key)) {
      delete cache[key];
      removed += 1;
    }
  }

  return removed;
}

function safeParseBaselines(raw: string | undefined): PriceBaselineMap {
  if (!raw || raw.length > MAX_PERSISTED_JSON_CHARACTERS) return {};

  try {
    const parsed = safeRecord(JSON.parse(raw) as unknown);
    if (!parsed) return {};

    const output: PriceBaselineMap = {};

    for (const [key, rawEntry] of Object.entries(parsed)) {
      if (Object.keys(output).length >= MAX_PRICE_BASELINES) break;
      if (!key || key.length > 160) continue;

      const entry = safeRecord(rawEntry);
      if (!entry) continue;

      const price = finiteNumberOr(entry.price, -1);
      const observedAt = Math.max(0, Math.floor(finiteNumberOr(entry.observed_at)));
      const currency = normalizeCurrencyCode(entry.currency);

      if (price < 0) continue;

      output[key] = {
        price,
        currency,
        formatted: String(entry.formatted ?? "").trim().slice(0, 80),
        observed_at: observedAt,
      };
    }

    return output;
  } catch {
    return {};
  }
}

function prunePriceBaselines(
  cache: PriceBaselineMap,
  nowSeconds: number,
): number {
  let removed = 0;

  for (const [key, entry] of Object.entries(cache)) {
    if (
      entry.observed_at > 0 &&
      nowSeconds > entry.observed_at &&
      nowSeconds - entry.observed_at > CACHE_RETENTION_SECONDS
    ) {
      delete cache[key];
      removed += 1;
    }
  }

  const entries = Object.entries(cache);
  if (entries.length > MAX_PRICE_BASELINES) {
    entries
      .sort((left, right) => right[1].observed_at - left[1].observed_at)
      .slice(MAX_PRICE_BASELINES)
      .forEach(([key]) => {
        delete cache[key];
        removed += 1;
      });
  }

  return removed;
}

function normalizeScanResults(
  raw: unknown,
  source: "persisted" | "generated" = "persisted",
): ScanResult[] {
  if (!Array.isArray(raw)) return [];

  const output: ScanResult[] = [];
  const seen = new Set<string>();

  for (const rawItem of raw) {
    if (output.length >= MAX_PERSISTED_RESULTS) break;

    const item = safeRecord(rawItem);
    if (!item) continue;

    const appId = Math.trunc(finiteNumberOr(item.appId));
    const purchaseTime = Math.trunc(finiteNumberOr(item.purchaseTime));
    const packageId = Math.max(0, Math.trunc(finiteNumberOr(item.packageId)));
    const rawPurchaseKind = String(item.purchaseKind ?? "");
    const purchaseKind: PurchaseKind = VALID_PURCHASE_KINDS.has(
      rawPurchaseKind as PurchaseKind,
    )
      ? (rawPurchaseKind as PurchaseKind)
      : packageId > 0
        ? "package"
        : "app";
    const rawState = String(item.state ?? "");
    const state: ScanState = VALID_SCAN_STATES.has(rawState as ScanState)
      ? (rawState as ScanState)
      : "monitoring";

    if (appId <= 0 || purchaseTime <= 0) continue;

    const identity = `${appId}:${purchaseTime}:${purchaseKind}:${packageId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    const currentPrice = Math.max(0, finiteNumberOr(item.currentPrice));
    const baselinePrice = Math.max(0, finiteNumberOr(item.baselinePrice));
    const ageDays = Math.max(0, finiteNumberOr(item.ageDays));
    const playtimeMinutes = Math.max(0, finiteNumberOr(item.playtimeMinutes));
    const currency = normalizeCurrencyCode(item.currency);
    const rawPlaytimeEligibility = String(item.playtimeEligibility ?? "");
    const playtimeEligibility: PlaytimeEligibility | undefined =
      rawPlaytimeEligibility === "within" ||
      rawPlaytimeEligibility === "outside" ||
      rawPlaytimeEligibility === "uncertain"
        ? rawPlaytimeEligibility
        : undefined;
    const rawComparisonSource = String(item.comparisonSource ?? "");
    const comparisonSource: PriceComparisonSource | undefined =
      rawComparisonSource === "actual_paid" || rawComparisonSource === "observed_baseline"
        ? rawComparisonSource
        : undefined;
    const withinDate = typeof item.withinDate === "boolean" ? item.withinDate : undefined;
    const withinPlaytime =
      item.withinPlaytime === null
        ? null
        : typeof item.withinPlaytime === "boolean"
          ? item.withinPlaytime
          : undefined;

    output.push({
      ...(item as unknown as ScanResult),
      appId,
      purchaseTime,
      packageId,
      purchaseKind,
      state,
      name: String(item.name ?? `Steam App ${appId}`).trim().slice(0, 240),
      headerImage: String(item.headerImage ?? "").trim().slice(0, 1024),
      ageDays,
      playtimeMinutes,
      currentPrice,
      currentPriceFormatted: String(item.currentPriceFormatted ?? "").trim().slice(0, 80),
      currency,
      dataFreshness: item.dataFreshness === "saved" ? "saved" : "fresh",
      refreshError: String(item.refreshError ?? "").trim().slice(0, 500) || undefined,
      priceAvailabilityReason:
        item.priceAvailabilityReason === "store_unavailable" ||
        item.priceAvailabilityReason === "free_or_zero" ||
        item.priceAvailabilityReason === "package_not_sold" ||
        item.priceAvailabilityReason === "currency_mismatch"
          ? item.priceAvailabilityReason
          : undefined,
      historicalPaidPriceFormatted: String(item.historicalPaidPriceFormatted ?? "").trim().slice(0, 80) || undefined,
      historicalPaidCurrency: normalizeCurrencyCode(item.historicalPaidCurrency) || undefined,
      steamDiscountPercent: Math.min(100, Math.max(0, finiteNumberOr(item.steamDiscountPercent))),
      baselinePrice,
      baselineFormatted: String(item.baselineFormatted ?? "").trim().slice(0, 80),
      observedDropPercent: Math.max(0, finiteNumberOr(item.observedDropPercent)),
      observedSavings: Math.max(0, finiteNumberOr(item.observedSavings)),
      priceDropPercent: Math.max(0, finiteNumberOr(item.priceDropPercent)),
      savings: Math.max(0, finiteNumberOr(item.savings)),
      comparisonSource,
      comparisonPrice: Math.max(0, finiteNumberOr(item.comparisonPrice)),
      comparisonPriceFormatted: String(item.comparisonPriceFormatted ?? "").trim().slice(0, 80),
      comparisonEstablished:
        typeof item.comparisonEstablished === "boolean" ? item.comparisonEstablished : undefined,
      minimumDropPercent: Math.max(0, finiteNumberOr(item.minimumDropPercent)),
      refundWindowDays: Math.max(1, finiteNumberOr(item.refundWindowDays, 14)),
      playtimeLimitMinutes: Math.max(1, finiteNumberOr(item.playtimeLimitMinutes, 120)),
      withinDate,
      withinPlaytime,
      playtimeEligibility,
      meaningfulDrop: typeof item.meaningfulDrop === "boolean" ? item.meaningfulDrop : undefined,
      isStandaloneDlc: item.isStandaloneDlc === true,
      underlyingAppId: Math.max(0, Math.trunc(finiteNumberOr(item.underlyingAppId))),
      underlyingGameName: String(item.underlyingGameName ?? "").trim().slice(0, 240),
      underlyingPlaytimeLastTwoWeeks: Math.max(0, finiteNumberOr(item.underlyingPlaytimeLastTwoWeeks)),
      underlyingPlaytimeForever: Math.max(0, finiteNumberOr(item.underlyingPlaytimeForever)),
      underlyingLastPlayed: Math.max(0, Math.trunc(finiteNumberOr(item.underlyingLastPlayed))),
      dlcPlaytimeUpperBoundMinutes: Math.max(0, finiteNumberOr(item.dlcPlaytimeUpperBoundMinutes)),
      dlcPlaytimeLowerBoundMinutes: Math.max(0, finiteNumberOr(item.dlcPlaytimeLowerBoundMinutes)),
      eligibleByRules: item.eligibleByRules === true,
      reason: String(item.reason ?? "").trim().slice(0, 2000),
      baseGameName: String(item.baseGameName ?? "").trim().slice(0, 240),
      baseGamePriceFormatted: String(item.baseGamePriceFormatted ?? "").trim().slice(0, 80),
      components: cleanStringArray(item.components),
      separateComponents: cleanStringArray(item.separateComponents),
      paidPrice: Math.max(0, finiteNumberOr(item.paidPrice)),
      paidPriceFormatted: String(item.paidPriceFormatted ?? "").trim().slice(0, 80),
      paidPriceSource:
        item.paidPriceSource === "steam_purchase_history" ||
        item.paidPriceSource === "cached_purchase_history"
          ? item.paidPriceSource
          : undefined,
      paidPriceConfidence:
        item.paidPriceConfidence === "exact_single_item" ||
        item.paidPriceConfidence === "exact_receipt_line_item"
          ? item.paidPriceConfidence
          : undefined,
    });
  }

  let blocked = 0;
  const guarded = output.map((item) => {
    const failures = scanResultInvariantFailures(item);
    if (failures.length === 0) return item;

    blocked += 1;
    console.error("[Refund Guard] Result invariant guard blocked inconsistent result", {
      source,
      appId: item.appId,
      purchaseKind: item.purchaseKind,
      packageId: item.packageId,
      classification: item.purchaseClassification ?? "",
      state: item.state,
      failures,
    });
    return quarantineInconsistentResult(item);
  });

  if (blocked > 0) {
    console.warn("[Refund Guard] Result invariant guard summary", { source, blocked });
  }

  return guarded;
}

function safeParseResults(raw: string | undefined): ScanResult[] {
  if (!raw || raw.length > MAX_PERSISTED_JSON_CHARACTERS) return [];

  try {
    return normalizeScanResults(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function previousResultForPurchase(
  previousResults: ScanResult[],
  appId: number,
  purchaseTime: number,
): ScanResult | null {
  return previousResults.find(
    (item) => item.appId === appId && item.purchaseTime === purchaseTime,
  ) ?? null;
}

function retainSavedResultAfterRefreshFailure(
  previous: ScanResult,
  nowSeconds: number,
  refreshError: string,
): ScanResult {
  return {
    ...previous,
    ageDays: Math.max(0, nowSeconds - previous.purchaseTime) / 86400,
    dataFreshness: "saved",
    refreshError: refreshError.slice(0, 500),
    state: "price_unavailable",
    meaningfulDrop: false,
    eligibleByRules: false,
    priceAvailabilityReason: "store_unavailable",
    reason:
      "Steam Store data could not be refreshed during this scan. Refund Guard kept the last successful result visible, but will not treat saved data as a current price-drop opportunity.",
  };
}

function parseBackendObject<T>(raw: unknown): T | null {
  try {
    if (typeof raw === "string") {
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as unknown;

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as T;
      }

      return null;
    }

    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as T;
    }

    return null;
  } catch {
    return null;
  }
}

function formatAge(days: number): string {
  if (days < 1) {
    const hours = Math.max(1, Math.floor(days * 24));
    return `${hours}h ago`;
  }

  return `${Math.floor(days)}d ago`;
}

function formatPlaytime(minutes: number): string {
  if (minutes < 60) {
    return `${Math.max(0, Math.round(minutes))}m`;
  }

  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}h`;
}


function paidPriceCacheKey(target: {
  appId: number;
  purchaseTime: number;
  purchaseKind: PurchaseKind;
  packageId: number;
}): string {
  return [
    Math.floor(Number(target.appId) || 0),
    Math.floor(Number(target.purchaseTime) || 0),
    target.purchaseKind,
    Math.floor(Number(target.packageId) || 0),
  ].join(":");
}

function safeParsePaidPriceCache(raw: string | undefined): PaidPriceCacheMap {
  if (!raw || raw.length > MAX_PERSISTED_JSON_CHARACTERS) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const output: PaidPriceCacheMap = {};
    for (const value of Object.values(parsed)) {
      if (Object.keys(output).length >= MAX_PAID_PRICE_CACHE_ENTRIES) break;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Partial<PaidPriceCacheEntry>;
      const price = Number(entry.price ?? 0);
      const appId = Number(entry.appId ?? 0);
      const purchaseTime = Number(entry.purchaseTime ?? 0);
      const packageId = Number(entry.packageId ?? 0);
      const purchaseKind = entry.purchaseKind;

      if (
        !Number.isFinite(price) || price <= 0 ||
        !Number.isFinite(appId) || appId <= 0 ||
        !Number.isFinite(purchaseTime) || purchaseTime <= 0 ||
        (purchaseKind !== "app" && purchaseKind !== "package" && purchaseKind !== "edition_unresolved") ||
        (entry.confidence !== "exact_single_item" &&
          entry.confidence !== "exact_receipt_line_item") ||
        entry.source !== "steam_purchase_history"
      ) continue;

      const normalizedEntry: PaidPriceCacheEntry = {
        appId,
        purchaseTime,
        purchaseKind,
        packageId: Number.isFinite(packageId) ? packageId : 0,
        price,
        formatted: String(entry.formatted || ""),
        currency: normalizeCurrencyCode(entry.currency),
        source: "steam_purchase_history",
        confidence: entry.confidence,
        resolvedAt: Number(entry.resolvedAt ?? 0) || 0,
      };
      output[paidPriceCacheKey(normalizedEntry)] = normalizedEntry;
    }
    return output;
  } catch {
    return {};
  }
}

function prunePaidPriceCache(
  cache: PaidPriceCacheMap,
  nowSeconds: number,
): number {
  let removed = 0;

  for (const [key, entry] of Object.entries(cache)) {
    const referenceTime = Math.max(entry.purchaseTime, entry.resolvedAt || 0);
    if (
      referenceTime > 0 &&
      nowSeconds > referenceTime &&
      nowSeconds - referenceTime > CACHE_RETENTION_SECONDS
    ) {
      delete cache[key];
      removed += 1;
    }
  }

  const entries = Object.entries(cache);
  if (entries.length > MAX_PAID_PRICE_CACHE_ENTRIES) {
    entries
      .sort((left, right) =>
        Math.max(right[1].purchaseTime, right[1].resolvedAt || 0) -
        Math.max(left[1].purchaseTime, left[1].resolvedAt || 0),
      )
      .slice(MAX_PAID_PRICE_CACHE_ENTRIES)
      .forEach(([key]) => {
        delete cache[key];
        removed += 1;
      });
  }

  return removed;
}

function paidPriceMatchFromPersistentCache(
  cache: PaidPriceCacheMap,
  target: {
    appId: number;
    purchaseTime: number;
    purchaseKind: PurchaseKind;
    packageId: number;
    currency: string;
  },
): PaidPriceMatch | null {
  const entry = cache[paidPriceCacheKey(target)];
  if (
    !entry ||
    (entry.confidence !== "exact_single_item" &&
      entry.confidence !== "exact_receipt_line_item") ||
    entry.price <= 0
  ) return null;

  if (
    entry.appId !== target.appId ||
    entry.purchaseTime !== target.purchaseTime ||
    entry.purchaseKind !== target.purchaseKind ||
    entry.packageId !== target.packageId
  ) return null;

  const currency = normalizeCurrencyCode(entry.currency || target.currency);
  const targetCurrency = normalizeCurrencyCode(target.currency);
  if (targetCurrency && currency && currency !== targetCurrency) return null;

  return {
    price: entry.price,
    currency,
    formatted: entry.formatted || fallbackPrice(entry.price, currency),
    source: "cached_purchase_history",
    confidence: entry.confidence,
  };
}

function historicalPaidEntryFromCache(
  cache: PaidPriceCacheMap,
  target: { appId: number; purchaseTime: number; purchaseKind: PurchaseKind; packageId: number },
): PaidPriceCacheEntry | null {
  const entry = cache[paidPriceCacheKey(target)];
  if (!entry) return null;

  if (
    entry.appId !== target.appId ||
    entry.purchaseTime !== target.purchaseTime ||
    entry.purchaseKind !== target.purchaseKind ||
    entry.packageId !== target.packageId ||
    entry.price <= 0
  ) return null;

  return entry;
}

function pruneSupersededPaidPriceCache(
  cache: PaidPriceCacheMap,
  results: ScanResult[],
): number {
  const currentByApp = new Map<number, Set<string>>();

  for (const item of results) {
    if (item.purchaseKind === "edition_unresolved") continue;
    const keys = currentByApp.get(item.appId) ?? new Set<string>();
    keys.add(paidPriceCacheKey(item));
    currentByApp.set(item.appId, keys);
  }

  let removed = 0;

  for (const [key, entry] of Object.entries(cache)) {
    const acceptedKeys = currentByApp.get(entry.appId);
    if (acceptedKeys && !acceptedKeys.has(key)) {
      delete cache[key];
      removed += 1;
    }
  }

  return removed;
}

function notificationIdentityKey(item: Pick<ScanResult, "appId" | "packageId" | "purchaseTime" | "purchaseKind">): string {
  return [
    Math.trunc(Number(item.appId) || 0),
    Math.trunc(Number(item.packageId) || 0),
    Math.trunc(Number(item.purchaseTime) || 0),
    item.purchaseKind,
  ].join(":");
}

function notificationFingerprint(item: ScanResult): string {
  return [
    item.state,
    Math.trunc(Number(item.currentPrice) || 0),
    Math.trunc(Number(item.comparisonPrice) || 0),
    String(item.currency || "").toUpperCase(),
  ].join(":");
}

function safeParseNotificationFingerprints(
  raw: string | undefined,
): NotificationFingerprintMap {
  if (!raw || raw.length > MAX_PERSISTED_JSON_CHARACTERS) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const output: NotificationFingerprintMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Partial<NotificationFingerprintEntry>;
      const appId = Number(entry.appId ?? 0);
      const packageId = Number(entry.packageId ?? 0);
      const purchaseTime = Number(entry.purchaseTime ?? 0);
      const currentPrice = Number(entry.currentPrice ?? 0);
      const comparisonPrice = Number(entry.comparisonPrice ?? 0);
      const notifiedAt = Number(entry.notifiedAt ?? 0);
      const fingerprint = String(entry.fingerprint || "");
      const state = entry.state;

      if (
        !key || key.length > 200 ||
        !Number.isFinite(appId) || appId <= 0 ||
        !Number.isFinite(packageId) || packageId < 0 ||
        !Number.isFinite(purchaseTime) || purchaseTime <= 0 ||
        !Number.isFinite(currentPrice) || currentPrice < 0 ||
        !Number.isFinite(comparisonPrice) || comparisonPrice < 0 ||
        !Number.isFinite(notifiedAt) || notifiedAt < 0 ||
        !fingerprint || fingerprint.length > 240 ||
        typeof state !== "string" || !VALID_SCAN_STATES.has(state as ScanState)
      ) continue;

      output[key] = {
        appId,
        packageId,
        purchaseTime,
        fingerprint,
        state: state as ScanState,
        currentPrice,
        comparisonPrice,
        currency: String(entry.currency || "").toUpperCase(),
        notifiedAt,
      };
    }

    return output;
  } catch {
    return {};
  }
}

function pruneNotificationFingerprints(
  cache: NotificationFingerprintMap,
  nowSeconds: number,
): number {
  const maximumAgeSeconds = 180 * 86400;
  let removed = 0;

  for (const [key, entry] of Object.entries(cache)) {
    if (entry.notifiedAt <= 0 || nowSeconds - entry.notifiedAt > maximumAgeSeconds) {
      delete cache[key];
      removed += 1;
    }
  }

  const entries = Object.entries(cache);
  if (entries.length <= 500) return removed;

  entries
    .sort((left, right) => right[1].notifiedAt - left[1].notifiedAt)
    .slice(500)
    .forEach(([key]) => {
      delete cache[key];
      removed += 1;
    });

  return removed;
}

function isNotificationEligible(item: ScanResult, strict: boolean): boolean {
  if (item.dataFreshness === "saved") return false;
  return item.state === "opportunity" || (!strict && isPriceDropState(item.state));
}

function reconcileNotificationFingerprints(
  cache: NotificationFingerprintMap,
  results: ScanResult[],
  strict: boolean,
  nowSeconds: number,
): number {
  let removed = pruneNotificationFingerprints(cache, nowSeconds);
  const currentlyEligible = new Set(
    results
      .filter((item) => isNotificationEligible(item, strict))
      .map((item) => notificationIdentityKey(item)),
  );
  const refreshUnavailable = new Set(
    results
      .filter((item) => item.dataFreshness === "saved")
      .map((item) => notificationIdentityKey(item)),
  );

  for (const identity of Object.keys(cache)) {
    if (!currentlyEligible.has(identity) && !refreshUnavailable.has(identity)) {
      delete cache[identity];
      removed += 1;
    }
  }

  return removed;
}

function clearNotificationFingerprints(
  cache: NotificationFingerprintMap,
): number {
  const keys = Object.keys(cache);
  for (const key of keys) delete cache[key];
  return keys.length;
}

function notificationRuleSummary(item: ScanResult): string {
  switch (item.state) {
    case "opportunity":
      return "Within configured refund rules";
    case "price_drop_outside_playtime":
      return "Outside playtime rule";
    case "price_drop_outside_window":
      return "Outside date window";
    case "price_drop_outside_both":
      return "Outside date and playtime rules";
    case "price_drop_playtime_uncertain":
      return "DLC playtime eligibility uncertain";
    default:
      return "Outside or uncertain under configured rules";
  }
}

function notificationSubtext(item: ScanResult): string {
  const reference =
    item.comparisonPriceFormatted ||
    fallbackPrice(Number(item.comparisonPrice ?? 0), item.currency);
  const current =
    item.currentPriceFormatted ||
    fallbackPrice(item.currentPrice, item.currency);
  const referenceLabel =
    item.comparisonSource === "actual_paid" ? "Paid" : "Baseline";

  return `${referenceLabel} ${reference} -> Now ${current} | ${notificationRuleSummary(item)}`;
}

function showNativePriceDropNotification(item: ScanResult): boolean {
  try {
    const drop = Number(item.priceDropPercent ?? 0);
    const savings = Number(item.savings ?? 0);
    const saved = moneyDifference(savings, item.currency);

    toaster.toast({
      title: "Refund Guard",
      body: `${item.name} - Save ${saved} (${drop.toFixed(1)}%)`,
      subtext: notificationSubtext(item),
      duration: 7500,
      expiration: 86400000,
      critical: false,
      showNewIndicator: true,
      playSound: true,
      showToast: true,
    });

    console.log("[Refund Guard] Native Steam notification shown", {
      appId: item.appId,
      packageId: item.packageId,
      state: item.state,
      currentPrice: item.currentPriceFormatted,
      comparisonPrice: item.comparisonPriceFormatted || "",
      savings: saved,
      dropPercent: drop,
    });

    return true;
  } catch (error) {
    console.error(
      "[Refund Guard] Native Steam notification failed; scan results remain valid",
      error,
    );
    return false;
  }
}

function fallbackPrice(minorUnits: number, currency: string): string {
  if (!Number.isFinite(minorUnits) || minorUnits < 0) {
    return "Unavailable";
  }

  const amount = minorUnits / 100;
  const normalizedCurrency = normalizeCurrencyCode(currency);

  if (!normalizedCurrency) {
    return amount.toFixed(2);
  }

  try {
    const formatted = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);

    // Keep the ISO code too so symbols such as $ remain unambiguous across
    // regional currencies (USD, CAD, AUD, etc.).
    return `${formatted} ${normalizedCurrency}`;
  } catch {
    return `${amount.toFixed(2)} ${normalizedCurrency}`;
  }
}

function moneyDifference(minorUnits: number, currency: string): string {
  return fallbackPrice(Math.max(0, minorUnits), currency);
}

function evaluateOpportunity(input: {
  referencePrice: number;
  currentPrice: number;
  minimumDropPercent: number;
  ageDays: number;
  refundWindowDays: number;
  playtimeMinutes: number;
  playtimeLimitMinutes: number;
  comparisonEstablished: boolean;
  playtimeEligibility?: PlaytimeEligibility;
}): OpportunityEvaluation {
  const referencePrice = Math.max(0, Number(input.referencePrice) || 0);
  const currentPrice = Math.max(0, Number(input.currentPrice) || 0);
  const minimumDropPercent = Math.max(0, Number(input.minimumDropPercent) || 0);
  const withinDate = input.ageDays <= input.refundWindowDays;
  const playtimeEligibility: PlaytimeEligibility =
    input.playtimeEligibility ??
    (input.playtimeMinutes <= input.playtimeLimitMinutes ? "within" : "outside");
  const withinPlaytime =
    playtimeEligibility === "uncertain"
      ? null
      : playtimeEligibility === "within";
  const eligibleByRules = withinDate && playtimeEligibility === "within";
  const savings = Math.max(0, referencePrice - currentPrice);
  const dropPercent =
    referencePrice > 0 ? (savings / referencePrice) * 100 : 0;
  const meaningfulDrop =
    input.comparisonEstablished &&
    savings > 0 &&
    dropPercent + 0.000001 >= minimumDropPercent;

  let state: ScanState = "monitoring";

  if (meaningfulDrop) {
    if (!withinDate && playtimeEligibility === "outside") {
      state = "price_drop_outside_both";
    } else if (!withinDate) {
      state = "price_drop_outside_window";
    } else if (playtimeEligibility === "uncertain") {
      state = "price_drop_playtime_uncertain";
    } else if (playtimeEligibility === "outside") {
      state = "price_drop_outside_playtime";
    } else {
      state = "opportunity";
    }
  }

  return {
    referencePrice,
    currentPrice,
    savings,
    dropPercent,
    minimumDropPercent,
    meaningfulDrop,
    withinDate,
    withinPlaytime,
    playtimeEligibility,
    eligibleByRules,
    state,
  };
}

function isPriceDropState(state: ScanState): boolean {
  return (
    state === "opportunity" ||
    state === "price_drop_outside_playtime" ||
    state === "price_drop_outside_window" ||
    state === "price_drop_outside_both" ||
    state === "price_drop_playtime_uncertain" ||
    state === "price_drop_not_eligible"
  );
}

type RuntimeMatrixScenario =
  | "base_game"
  | "edition_package"
  | "separate_checkout"
  | "standalone_dlc"
  | "unresolved";

function runtimeMatrixScenario(item: ScanResult): RuntimeMatrixScenario {
  if (item.isStandaloneDlc || item.purchaseClassification === "dlc") {
    return "standalone_dlc";
  }
  if (item.purchaseClassification === "edition") return "edition_package";
  if (item.purchaseClassification === "separate") return "separate_checkout";
  if (item.purchaseClassification === "uncertain" || item.purchaseKind === "edition_unresolved") {
    return "unresolved";
  }
  return "base_game";
}

function scanResultInvariantFailures(item: ScanResult): string[] {
  const failures: string[] = [];
  const classification = item.purchaseClassification;

  if (classification === "edition") {
    if (item.purchaseKind !== "package") failures.push("edition classification requires package purchase kind");
    if (item.packageId <= 0) failures.push("edition classification requires a positive PackageID");
    if (!Array.isArray(item.components) || item.components.length === 0) failures.push("edition classification requires at least one edition component");
  }

  if (classification === "dlc" || item.isStandaloneDlc) {
    if (classification !== "dlc" || item.isStandaloneDlc !== true) failures.push("standalone DLC flags disagree");
    if ((item.underlyingAppId ?? 0) <= 0) failures.push("standalone DLC requires an underlying title AppID");
  }

  if (item.purchaseKind === "edition_unresolved") {
    if (classification !== "uncertain") failures.push("unresolved edition requires uncertain classification");
    if (item.packageId !== 0) failures.push("unresolved edition must not claim a resolved PackageID");
  }

  if (item.comparisonSource === "actual_paid") {
    if ((item.paidPrice ?? 0) <= 0 || !String(item.paidPriceFormatted ?? "").trim()) {
      failures.push("actual-paid comparison requires a resolved paid price");
    }
  }

  if (isPriceDropState(item.state)) {
    if (item.meaningfulDrop !== true) failures.push("price-drop state requires meaningfulDrop=true");
    if (item.comparisonEstablished !== true) failures.push("price-drop state requires an established comparison");
    if (item.currentPrice <= 0) failures.push("price-drop state requires a positive current price");
  }

  if (item.state === "opportunity") {
    if (item.eligibleByRules !== true) failures.push("opportunity requires configured refund rules to be satisfied");
    if (item.withinDate !== true || item.playtimeEligibility !== "within") failures.push("opportunity requires date and playtime rules within limits");
    if ((item.comparisonPrice ?? 0) <= item.currentPrice) failures.push("opportunity requires comparison price above current price");
  }

  if (item.eligibleByRules === true && (item.withinDate !== true || item.playtimeEligibility !== "within")) {
    failures.push("eligibleByRules disagrees with date/playtime evidence");
  }

  return failures;
}

function quarantineInconsistentResult(item: ScanResult): ScanResult {
  return {
    ...item,
    state: "price_unavailable",
    eligibleByRules: false,
    meaningfulDrop: false,
    comparisonEstablished: false,
    savings: 0,
    observedSavings: 0,
    priceDropPercent: 0,
    observedDropPercent: 0,
    reason: "Refund Guard blocked this result because internal consistency checks failed. No refund opportunity or price-drop alert will be reported until a later scan resolves it safely.",
    priceAvailabilityReason: item.priceAvailabilityReason ?? "store_unavailable",
  };
}

function runtimeMatrixSummary(results: ScanResult[]): Record<string, number> {
  const summary = {
    baseGame: 0, editionPackage: 0, separateCheckout: 0, standaloneDlc: 0, unresolved: 0,
    opportunity: 0, otherPriceDrop: 0, monitoring: 0, priceUnavailable: 0,
  };
  for (const item of results) {
    switch (runtimeMatrixScenario(item)) {
      case "edition_package": summary.editionPackage += 1; break;
      case "separate_checkout": summary.separateCheckout += 1; break;
      case "standalone_dlc": summary.standaloneDlc += 1; break;
      case "unresolved": summary.unresolved += 1; break;
      default: summary.baseGame += 1; break;
    }
    if (item.state === "opportunity") summary.opportunity += 1;
    else if (isPriceDropState(item.state)) summary.otherPriceDrop += 1;
    else if (item.state === "price_unavailable") summary.priceUnavailable += 1;
    else summary.monitoring += 1;
  }
  return summary;
}

function normalizeHistoryTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseHistoryMoney(
  raw: string,
  expectedCurrency: string,
): { price: number; currency: string } | null {
  const text = String(raw || "").trim();

  if (!text) {
    return null;
  }

  const currency = receiptCurrencyFromText(text, expectedCurrency);
  const numericText = text
    .replace(/\s+/g, "")
    .replace(/[^\d,.\-]/g, "");

  if (!numericText) {
    return null;
  }

  const lastComma = numericText.lastIndexOf(",");
  const lastDot = numericText.lastIndexOf(".");
  let normalized = numericText;

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = numericText.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = numericText.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    const decimals = numericText.length - lastComma - 1;
    normalized =
      decimals === 2
        ? numericText.replace(/\./g, "").replace(",", ".")
        : numericText.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const decimals = numericText.length - lastDot - 1;
    normalized =
      decimals === 2
        ? numericText.replace(/,/g, "")
        : numericText.replace(/\./g, "");
  }

  const amount = Number.parseFloat(normalized);

  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return {
    price: Math.round(amount * 100),
    currency,
  };
}

function parsePurchaseHistoryRows(html: string): PurchaseHistoryRow[] {
  const documentSnapshot = new DOMParser().parseFromString(
    String(html || ""),
    "text/html",
  );

  return Array.from(
    documentSnapshot.querySelectorAll(".wallet_table_row"),
  ).map((row) => {
    const itemCell = row.querySelector(".wht_items");
    const typeCell = row.querySelector(".wht_type");
    const totalCell = row.querySelector(".wht_total");
    const dateCell = row.querySelector(".wht_date");

    let itemText = "";
    let itemLines: string[] = [];

    if (itemCell) {
      const clone = itemCell.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll(".wth_payment,.wht_payment")
        .forEach((node) => node.remove());
      itemLines = String(clone.innerText || clone.textContent || "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      itemText = itemLines.join(" | ");
    }

    const dateText = String(dateCell?.textContent || "").trim();
    const parsedDate = Date.parse(dateText);
    const onclickText = String(row.getAttribute("onclick") || "");
    const transactionMatch = onclickText.match(/transid=(\d+)/i);

    return {
      itemText,
      itemLines,
      itemCount: itemLines.length,
      typeText: String(typeCell?.textContent || "").trim(),
      totalText: String(totalCell?.textContent || "").trim(),
      dateText,
      dateSeconds: Number.isFinite(parsedDate)
        ? Math.floor(parsedDate / 1000)
        : 0,
      transactionId: String(transactionMatch?.[1] || ""),
    };
  });
}

function extractPurchaseHistoryCursor(html: string): unknown | null {
  const match = String(html || "").match(
    /g_historyCursor\s*=\s*([^;]+);/i,
  );

  if (!match?.[1]) {
    return null;
  }

  const raw = match[1].trim();

  if (!raw || raw === "null" || raw === "undefined") {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    const quoted = raw.match(/^['\"]([\s\S]*)['\"]$/);
    return quoted ? quoted[1] : raw;
  }
}

function parseCursorJson(raw: string | undefined): unknown | null {
  const text = String(raw || "").trim();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function oldestHistoryTimestamp(rows: PurchaseHistoryRow[]): number {
  const dates = rows
    .map((row) => Number(row.dateSeconds || 0))
    .filter((value) => Number.isFinite(value) && value > 0);

  return dates.length > 0 ? Math.min(...dates) : 0;
}

function historyTitleScore(
  value: string,
  targetName: string,
  baseName: string,
): number {
  const item = normalizeHistoryTitle(value);

  if (!item) {
    return 0;
  }

  if (targetName && item === targetName) {
    return 10;
  }

  if (baseName && item === baseName) {
    return 9;
  }

  if (
    targetName &&
    targetName.length >= 4 &&
    (item.includes(targetName) || targetName.includes(item))
  ) {
    return 7;
  }

  if (
    baseName &&
    baseName.length >= 4 &&
    (item.includes(baseName) || baseName.includes(item))
  ) {
    return 6;
  }

  return 0;
}

function receiptCurrencyFromText(
  text: string,
  expectedCurrency: string,
): string {
  const upper = String(text || "").toUpperCase();
  const isoMatch = upper.match(/\b(USD|EUR|GBP|TRY|CAD|AUD|NZD|JPY|CNY|RUB|BRL|PLN|CHF|NOK|SEK|DKK|KRW|INR|MXN|ZAR|SGD|HKD|TWD|UAH|KZT)\b/);

  if (isoMatch?.[1]) {
    return isoMatch[1];
  }

  if (text.includes("\u20ac")) return "EUR";
  if (text.includes("\u00a3")) return "GBP";
  if (text.includes("\u20ba")) return "TRY";
  if (text.includes("\u20bd")) return "RUB";
  if (text.includes("\u20b9")) return "INR";
  if (text.includes("\u20a9")) return "KRW";
  if (text.includes("\u20b4")) return "UAH";

  return String(expectedCurrency || "").trim().toUpperCase();
}

function parseReceiptLineWithPrice(
  rawLine: string,
  expectedCurrency: string,
): { name: string; price: number; currency: string } | null {
  const line = String(rawLine || "").replace(/\s+/g, " ").trim();

  if (!line) {
    return null;
  }

  // Match only the trailing money token so digits in titles (for example
  // "Warhammer 40,000") never become part of the price.
  const moneyMatch = line.match(
    /((?:(?:USD|EUR|GBP|TRY|CAD|AUD|NZD|JPY|CNY|RUB|BRL|PLN|CHF|NOK|SEK|DKK|KRW|INR|MXN|ZAR|SGD|HKD|TWD|UAH|KZT)\s*)?(?:\u0024|\u20ac|\u00a3|\u00a5|\u20ba|\u20bd|\u20b9|\u20a9|\u20aa|\u20b4|\u20b8)?\s*\d[\d\s.,]*\s*(?:(?:USD|EUR|GBP|TRY|CAD|AUD|NZD|JPY|CNY|RUB|BRL|PLN|CHF|NOK|SEK|DKK|KRW|INR|MXN|ZAR|SGD|HKD|TWD|UAH|KZT)|\u0024|\u20ac|\u00a3|\u00a5|\u20ba|\u20bd|\u20b9|\u20a9|\u20aa|\u20b4|\u20b8)?)\s*$/i,
  );

  if (!moneyMatch || moneyMatch.index === undefined) {
    return null;
  }

  const moneyText = moneyMatch[1].trim();
  const name = line
    .slice(0, moneyMatch.index)
    .replace(/[\s\-:|]+$/, "")
    .trim();

  if (!name) {
    return null;
  }

  const currency = receiptCurrencyFromText(
    moneyText,
    expectedCurrency,
  );
  const money = parseHistoryMoney(moneyText, currency);

  if (!money || money.price <= 0) {
    return null;
  }

  return { name, price: money.price, currency: money.currency };
}

function isStandaloneMoneyText(value: string): boolean {
  return /^\s*(?:(?:USD|EUR|GBP|TRY|CAD|AUD|NZD|JPY|CNY|RUB|BRL|PLN|CHF|NOK|SEK|DKK|KRW|INR|MXN|ZAR|SGD|HKD|TWD|UAH|KZT)\s*)?(?:\u0024|\u20ac|\u00a3|\u00a5|\u20ba|\u20bd|\u20b9|\u20a9|\u20aa|\u20b4|\u20b8)?\s*\d[\d\s.,]*\s*(?:(?:USD|EUR|GBP|TRY|CAD|AUD|NZD|JPY|CNY|RUB|BRL|PLN|CHF|NOK|SEK|DKK|KRW|INR|MXN|ZAR|SGD|HKD|TWD|UAH|KZT)|\u0024|\u20ac|\u00a3|\u00a5|\u20ba|\u20bd|\u20b9|\u20a9|\u20aa|\u20b4|\u20b8)?\s*$/i.test(
    String(value || ""),
  );
}

function receiptLineItemsFromHtml(
  html: string,
  expectedCurrency: string,
): Array<{ name: string; price: number; currency: string }> {
  const documentSnapshot = new DOMParser().parseFromString(
    String(html || ""),
    "text/html",
  );
  const candidates: Array<{
    name: string;
    price: number;
    currency: string;
  }> = [];
  const seen = new Set<string>();

  const excludedName = (name: string) => {
    const normalized = normalizeHistoryTitle(name);
    return /^(subtotal|tax|vat|total|payment|payment method|transaction id|purchased|purchase|account name|billing|amount charged)\b/.test(
      normalized,
    );
  };

  const addCandidate = (
    value: { name: string; price: number; currency: string } | null,
  ) => {
    if (!value || excludedName(value.name)) {
      return;
    }

    const key = `${normalizeHistoryTitle(value.name)}:${value.price}:${value.currency}`;

    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(value);
    }
  };

  // Table-like receipt layouts are the strongest source because each product
  // and its amount normally live in one row.
  for (const row of Array.from(documentSnapshot.querySelectorAll("tr"))) {
    addCandidate(
      parseReceiptLineWithPrice(
        String((row as HTMLElement).innerText || row.textContent || ""),
        expectedCurrency,
      ),
    );
  }

  const bodyLines = String(
    documentSnapshot.body?.innerText ||
      documentSnapshot.body?.textContent ||
      "",
  )
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < bodyLines.length; index += 1) {
    addCandidate(
      parseReceiptLineWithPrice(bodyLines[index], expectedCurrency),
    );

    // Some receipt layouts render product name and amount in adjacent cells,
    // which become separate lines in innerText.
    if (index + 1 < bodyLines.length) {
      const nextMoney = isStandaloneMoneyText(bodyLines[index + 1])
        ? parseHistoryMoney(
            bodyLines[index + 1],
            receiptCurrencyFromText(
              bodyLines[index + 1],
              expectedCurrency,
            ),
          )
        : null;
      const currentName = bodyLines[index]
        .replace(/\s+/g, " ")
        .trim();

      if (
        nextMoney?.price &&
        currentName &&
        !/[\d][\d\s.,]*$/.test(currentName) &&
        !excludedName(currentName)
      ) {
        addCandidate({
          name: currentName,
          price: nextMoney.price,
          currency: nextMoney.currency,
        });
      }
    }
  }

  return candidates;
}

async function readPurchaseHistoryViaSteamSession(
  cutoffSeconds = 0,
): Promise<PurchaseHistorySnapshot> {
  type CdpResult = Record<string, any>;
  type CookieLike = {
    name?: string;
    value?: string;
    domain?: string;
    path?: string;
  };
  type TargetInfoLike = {
    targetId?: string;
    type?: string;
    url?: string;
  };
  type HistoryHtmlResponse = {
    ok?: boolean;
    status?: number;
    body?: string;
    error?: string;
  };
  type HistoryPageResponse = {
    ok?: boolean;
    status?: number;
    html?: string;
    cursor_json?: string;
    error?: string;
  };

  const cdp = ChromeDevToolsProtocol as unknown as {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<CdpResult>;
  };

  const storeHost = "store.steampowered.com";

  const cookieAppliesToStore = (cookie: CookieLike): boolean => {
    const domain = String(cookie.domain || "")
      .trim()
      .toLowerCase()
      .replace(/^\./, "");

    if (!domain) {
      return false;
    }

    return storeHost === domain || storeHost.endsWith(`.${domain}`);
  };

  const buildCookieHeader = (cookies: CookieLike[]) => {
    const bestByName = new Map<
      string,
      { value: string; specificity: number; pathLength: number }
    >();

    for (const cookie of cookies) {
      const name = String(cookie.name || "").trim();
      const value = String(cookie.value || "");

      if (!name || !value || !cookieAppliesToStore(cookie)) {
        continue;
      }

      const domain = String(cookie.domain || "")
        .trim()
        .replace(/^\./, "");
      const path = String(cookie.path || "/");
      const specificity = domain.split(".").length;
      const previous = bestByName.get(name);

      if (
        !previous ||
        specificity > previous.specificity ||
        (specificity === previous.specificity &&
          path.length > previous.pathLength)
      ) {
        bestByName.set(name, {
          value,
          specificity,
          pathLength: path.length,
        });
      }
    }

    const names = [...bestByName.keys()].sort();
    const header = names
      .map((name) => `${name}=${bestByName.get(name)?.value ?? ""}`)
      .join("; ");

    return {
      header,
      names,
      sessionId: bestByName.get("sessionid")?.value ?? "",
      hasSteamLoginSecure: bestByName.has("steamLoginSecure"),
      hasSessionId: bestByName.has("sessionid"),
    };
  };

  const readCookies = async (): Promise<{
    header: string;
    names: string[];
    source: string;
    sessionId: string;
    hasSteamLoginSecure: boolean;
    hasSessionId: boolean;
  }> => {
    try {
      const result = await cdp.send("Storage.getCookies");
      const built = buildCookieHeader(
        Array.isArray(result?.cookies) ? result.cookies : [],
      );

      if (built.hasSteamLoginSecure && built.header) {
        return { ...built, source: "Storage.getCookies" };
      }
    } catch (error) {
      console.warn(
        "[Refund Guard] Browser-level cookie probe unavailable",
        error instanceof Error ? error.message : error,
      );
    }

    try {
      const targets = await cdp.send("Target.getTargets");
      const targetInfos = Array.isArray(targets?.targetInfos)
        ? (targets.targetInfos as TargetInfoLike[])
        : [];
      const candidates = targetInfos.filter((target) => {
        const type = String(target.type || "").toLowerCase();
        return (
          Boolean(target.targetId) &&
          (type === "page" || type === "webview" || type === "other")
        );
      });

      for (const target of candidates.slice(0, 12)) {
        let sessionId = "";

        try {
          const attached = await cdp.send("Target.attachToTarget", {
            targetId: String(target.targetId),
            flatten: true,
          });
          sessionId = String(attached?.sessionId || "");

          if (!sessionId) {
            continue;
          }

          await cdp.send("Network.enable", {}, sessionId);
          const result = await cdp.send(
            "Network.getAllCookies",
            {},
            sessionId,
          );
          const built = buildCookieHeader(
            Array.isArray(result?.cookies) ? result.cookies : [],
          );

          if (built.hasSteamLoginSecure && built.header) {
            return { ...built, source: "Network.getAllCookies" };
          }
        } catch {
          // Try the next existing Steam webhelper target.
        } finally {
          if (sessionId) {
            try {
              await cdp.send("Target.detachFromTarget", { sessionId });
            } catch {
              // Best-effort debugger cleanup only.
            }
          }
        }
      }
    } catch (error) {
      console.warn(
        "[Refund Guard] Target-level cookie probe unavailable",
        error instanceof Error ? error.message : error,
      );
    }

    return {
      header: "",
      names: [],
      source: "none",
      sessionId: "",
      hasSteamLoginSecure: false,
      hasSessionId: false,
    };
  };

  const cookieSnapshot = await readCookies();

  debugLog(
    "[Refund Guard] Purchase history cookie probe",
    {
      source: cookieSnapshot.source,
      cookieCount: cookieSnapshot.names.length,
      cookieNames: cookieSnapshot.names,
      hasSteamLoginSecure: cookieSnapshot.hasSteamLoginSecure,
      hasSessionId: cookieSnapshot.hasSessionId,
    },
  );

  if (!cookieSnapshot.hasSteamLoginSecure || !cookieSnapshot.header) {
    return {
      status: "unavailable",
      rows: [],
      error:
        "Steam Store authentication cookies are not available from the current Steam webhelper session.",
    };
  }

  try {
    const raw = await backend.getPurchaseHistoryHtml(cookieSnapshot.header);
    const response = parseBackendObject<HistoryHtmlResponse>(raw);
    const body = String(response?.body || "");

    if (!response?.ok || !body) {
      return {
        status: "unavailable",
        rows: [],
        error:
          response?.error ||
          "Steam purchase history HTTP request returned no usable HTML.",
      };
    }

    const lowerBody = body.toLowerCase();
    const initialDocument = new DOMParser().parseFromString(
      body,
      "text/html",
    );
    let rows = parsePurchaseHistoryRows(body);
    let cursor = extractPurchaseHistoryCursor(body);
    let pagesLoaded = 0;
    let hasMore = Boolean(initialDocument.querySelector("#load_more_button"));
    let stoppedByCutoff = false;
    const maxPages = 12;

    while (
      cursor !== null &&
      pagesLoaded < maxPages &&
      cookieSnapshot.sessionId
    ) {
      const oldest = oldestHistoryTimestamp(rows);

      if (cutoffSeconds > 0 && oldest > 0 && oldest <= cutoffSeconds) {
        stoppedByCutoff = true;
        break;
      }

      const pageRaw = await backend.getPurchaseHistoryPage(
        cookieSnapshot.header,
        JSON.stringify(cursor),
        cookieSnapshot.sessionId,
      );
      const page = parseBackendObject<HistoryPageResponse>(pageRaw);

      if (!page?.ok) {
        console.warn(
          "[Refund Guard] Purchase history pagination stopped",
          {
            page: pagesLoaded + 1,
            error: page?.error || "Unknown pagination error",
          },
        );
        break;
      }

      const pageHtml = String(page.html || "");
      const pageRows = parsePurchaseHistoryRows(pageHtml);
      pagesLoaded += 1;

      if (pageRows.length === 0) {
        cursor = null;
        hasMore = false;
        break;
      }

      rows = rows.concat(pageRows);
      cursor = parseCursorJson(page.cursor_json);
      hasMore = cursor !== null;
    }

    const looksSignedOut =
      lowerBody.includes("login.steampowered.com") &&
      !lowerBody.includes("wallet_table_row");

    debugLog(
      "[Refund Guard] Purchase history direct HTTP resolver",
      {
        statusCode: Number(response.status || 0),
        rowCount: rows.length,
        htmlBytes: body.length,
        pagesLoaded,
        hasMore,
        stoppedByCutoff,
        cutoffSeconds,
        signedOut: looksSignedOut,
      },
    );

    if (rows.length > 0) {
      return {
        status: "ok",
        rows,
        pagesLoaded,
        hasMore,
        cookieHeader: cookieSnapshot.header,
      };
    }

    if (looksSignedOut) {
      return {
        status: "signed_out",
        rows: [],
        error:
          "Steam Store purchase history HTTP request was redirected to login.",
      };
    }

    return {
      status: "unavailable",
      rows: [],
      error: "Steam purchase history HTML contained no transaction rows.",
    };
  } catch (error) {
    console.warn(
      "[Refund Guard] Purchase history direct HTTP request failed",
      error instanceof Error ? error.message : error,
    );

    return {
      status: "unavailable",
      rows: [],
      error:
        error instanceof Error
          ? error.message
          : "Steam purchase history direct HTTP request failed.",
    };
  }
}

async function resolvePaidPriceFromHistory(
  history: PurchaseHistorySnapshot,
  target: {
    displayName: string;
    baseGameName: string;
    purchaseTime: number;
    currency: string;
  },
): Promise<PaidPriceMatch | null> {
  if (history.status !== "ok" || history.rows.length === 0) {
    return null;
  }

  const targetName = normalizeHistoryTitle(target.displayName);
  const baseName = normalizeHistoryTitle(target.baseGameName);
  const matches: Array<{
    row: PurchaseHistoryRow;
    score: number;
    titleScore: number;
  }> = [];

  for (const row of history.rows) {
    const type = String(row.typeText || "").toLowerCase();

    if (!type.includes("purchase") || type.includes("refund")) {
      continue;
    }

    const rowLines =
      row.itemLines.length > 0 ? row.itemLines : [row.itemText];
    const titleScore = Math.max(
      0,
      ...rowLines.map((line) =>
        historyTitleScore(line, targetName, baseName),
      ),
    );

    if (titleScore <= 0) {
      continue;
    }

    let score = titleScore;
    const rowTime = Number(row.dateSeconds || 0);

    if (rowTime > 0 && target.purchaseTime > 0) {
      const dateDelta = Math.abs(rowTime - target.purchaseTime);

      if (dateDelta <= 36 * 60 * 60) {
        score += 4;
      } else if (dateDelta <= 72 * 60 * 60) {
        score += 1;
      } else {
        continue;
      }
    }

    matches.push({ row, score, titleScore });
  }

  matches.sort((a, b) => b.score - a.score);

  if (matches.length === 0 || matches[0].score < 10) {
    return null;
  }

  if (
    matches.length > 1 &&
    matches[1].score === matches[0].score
  ) {
    return null;
  }

  const selected = matches[0].row;

  if (Number(selected.itemCount || 0) === 1) {
    const parsedMoney = parseHistoryMoney(
      selected.totalText,
      target.currency,
    );

    if (!parsedMoney || parsedMoney.price <= 0) {
      return null;
    }

    return {
      price: parsedMoney.price,
      currency: parsedMoney.currency,
      formatted: fallbackPrice(
        parsedMoney.price,
        parsedMoney.currency,
      ),
      source: "steam_purchase_history",
      confidence: "exact_single_item",
    };
  }

  // Multi-item transactions are never assigned the transaction total. Resolve
  // the matching receipt line by transaction ID instead.
  if (!selected.transactionId || !history.cookieHeader) {
    console.log(
      "[Refund Guard] Multi-item purchase requires receipt detail",
      {
        itemCount: selected.itemCount,
        hasTransactionId: Boolean(selected.transactionId),
        hasAuthenticatedSession: Boolean(history.cookieHeader),
      },
    );
    return null;
  }

  try {
    const raw = await backend.getPurchaseReceiptHtml(
      history.cookieHeader,
      selected.transactionId,
    );
    const response = parseBackendObject<{
      ok?: boolean;
      status?: number;
      body?: string;
      error?: string;
    }>(raw);
    const body = String(response?.body || "");

    if (!response?.ok || !body) {
      console.warn(
        "[Refund Guard] Purchase receipt lookup unavailable",
        {
          transaction: `...${selected.transactionId.slice(-6)}`,
          error: response?.error || "No receipt HTML",
        },
      );
      return null;
    }

    const receiptItems = receiptLineItemsFromHtml(
      body,
      target.currency,
    );
    const receiptMatches = receiptItems
      .map((item) => ({
        item,
        score: historyTitleScore(
          item.name,
          targetName,
          baseName,
        ),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    if (
      receiptMatches.length === 0 ||
      receiptMatches[0].score < 6 ||
      (receiptMatches.length > 1 &&
        receiptMatches[1].score === receiptMatches[0].score)
    ) {
      console.log(
        "[Refund Guard] Purchase receipt line-item match unresolved",
        {
          transaction: `...${selected.transactionId.slice(-6)}`,
          receiptItemCount: receiptItems.length,
        },
      );
      return null;
    }

    const item = receiptMatches[0].item;
    const transactionTotal = parseHistoryMoney(
      selected.totalText,
      item.currency || target.currency,
    );

    if (
      transactionTotal?.price &&
      item.price > transactionTotal.price + 1
    ) {
      return null;
    }

    console.log(
      "[Refund Guard] Purchase receipt line-item resolved",
      {
        transaction: `...${selected.transactionId.slice(-6)}`,
        itemCount: selected.itemCount,
        matchedName: item.name,
        paidPrice: fallbackPrice(item.price, item.currency),
      },
    );

    return {
      price: item.price,
      currency: item.currency,
      formatted: fallbackPrice(item.price, item.currency),
      source: "steam_purchase_history",
      confidence: "exact_receipt_line_item",
    };
  } catch (error) {
    console.warn(
      "[Refund Guard] Purchase receipt resolver failed",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function scannerSummary(results: ScanResult[]): ScannerSummary {
  return {
    total: results.length,
    opportunities: results.filter((item) => item.state === "opportunity").length,
    otherPriceDrops: results.filter(
      (item) =>
        item.state === "price_drop_outside_playtime" ||
        item.state === "price_drop_outside_window" ||
        item.state === "price_drop_outside_both" ||
        item.state === "price_drop_playtime_uncertain" ||
        item.state === "price_drop_not_eligible",
    ).length,
    monitoring: results.filter(
      (item) => item.state === "monitoring" || item.state === "over_playtime",
    ).length,
    unresolved: results.filter(
      (item) => item.purchaseKind === "edition_unresolved",
    ).length,
  };
}

function parseJsonish(value: unknown, depth = 0): unknown {
  if (depth > 4 || typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  if (
    !trimmed ||
    (!trimmed.startsWith("{") && !trimmed.startsWith("["))
  ) {
    return value;
  }

  try {
    return parseJsonish(JSON.parse(trimmed) as unknown, depth + 1);
  } catch {
    return value;
  }
}

function collectDlcEntries(
  value: unknown,
  output: DlcLike[],
  seenObjects: Set<object>,
  depth = 0,
): void {
  if (depth > 10 || value === null || value === undefined) {
    return;
  }

  const parsed = parseJsonish(value);

  if (parsed !== value) {
    collectDlcEntries(parsed, output, seenObjects, depth + 1);
    return;
  }

  if (typeof parsed !== "object") {
    return;
  }

  if (seenObjects.has(parsed)) {
    return;
  }

  seenObjects.add(parsed);

  if (Array.isArray(parsed)) {
    for (const child of parsed) {
      collectDlcEntries(child, output, seenObjects, depth + 1);
    }

    return;
  }

  const objectValue = parsed as Record<string, unknown>;

  // Some Steam builds put AppDLC entries directly inside nested cached-detail
  // objects. Detect the entry shape as well as vecDLC containers.
  const directAppId = Number(
    objectValue.unAppID ??
    objectValue.unAppId ??
    objectValue.appid ??
    objectValue.appId ??
    0,
  );

  const directPurchaseDate = Number(
    objectValue.rtPurchaseDate ??
    objectValue.rt_purchase_date ??
    0,
  );

  const looksLikeDlcEntry =
    directAppId > 0 &&
    (
      "rtPurchaseDate" in objectValue ||
      "rt_purchase_date" in objectValue ||
      "bAvailableOnStore" in objectValue ||
      "bEnabled" in objectValue
    );

  if (looksLikeDlcEntry) {
    output.push({
      unAppID: directAppId,
      strName: String(
        objectValue.strName ??
        objectValue.name ??
        "",
      ),
      rtPurchaseDate:
        Number.isFinite(directPurchaseDate) ? directPurchaseDate : 0,
      bEnabled:
        typeof objectValue.bEnabled === "boolean"
          ? objectValue.bEnabled
          : undefined,
      bAvailableOnStore:
        typeof objectValue.bAvailableOnStore === "boolean"
          ? objectValue.bAvailableOnStore
          : undefined,
    });
  }

  for (const [key, child] of Object.entries(objectValue)) {
    if (
      key.toLowerCase() === "vecdlc" &&
      Array.isArray(parseJsonish(child))
    ) {
      const list = parseJsonish(child) as unknown[];

      for (const entry of list) {
        collectDlcEntries(entry, output, seenObjects, depth + 1);
      }

      continue;
    }

    collectDlcEntries(child, output, seenObjects, depth + 1);
  }
}

function dedupeDlc(entries: DlcLike[]): DlcLike[] {
  const byAppId = new Map<number, DlcLike>();

  for (const item of entries) {
    const appId = Number(item.unAppID ?? 0);

    if (!Number.isFinite(appId) || appId <= 0) {
      continue;
    }

    const previous = byAppId.get(appId);

    if (!previous) {
      byAppId.set(appId, item);
      continue;
    }

    // Prefer the copy with an actual purchase date/name when multiple cached
    // sections describe the same DLC.
    const previousDate = Number(previous.rtPurchaseDate ?? 0);
    const nextDate = Number(item.rtPurchaseDate ?? 0);

    byAppId.set(appId, {
      ...previous,
      ...item,
      strName: item.strName || previous.strName,
      rtPurchaseDate:
        nextDate > 0
          ? nextDate
          : previousDate,
    });
  }

  return [...byAppId.values()];
}

type SteamAppsBridge = {
  GetCachedAppDetails?: (appId: number) => Promise<unknown>;
  RegisterForAppDetails?: (
    appId: number,
    callback: (details: unknown) => void,
  ) => unknown;
};

function getSteamAppsBridge(): SteamAppsBridge | null {
  const steamClient = (
    globalThis as typeof globalThis & {
      SteamClient?: {
        Apps?: SteamAppsBridge;
      };
    }
  ).SteamClient;

  return steamClient?.Apps ?? null;
}

type SteamPlaytimeBridge = {
  GetPlaytime?: (appId: number) => Promise<SteamPlaytimeLike | undefined>;
};

function getSteamPlaytimeBridge(): SteamPlaytimeBridge | null {
  const steamClient = (
    globalThis as typeof globalThis & {
      SteamClient?: {
        App?: SteamPlaytimeBridge;
        Apps?: SteamPlaytimeBridge;
      };
    }
  ).SteamClient;

  // Generated Millennium 3.4.1 types expose GetPlaytime on SteamClient.App.
  // Keep Apps as a compatibility fallback for Steam builds that mirror the
  // method on the plural bridge.
  return steamClient?.App ?? steamClient?.Apps ?? null;
}

async function resolveStandaloneDlcPlaytime(
  underlyingAppId: number,
  purchaseTime: number,
  playtimeLimitMinutes: number,
  nowSeconds: number,
): Promise<DlcPlaytimeResolution> {
  const unavailable = (explanation: string): DlcPlaytimeResolution => ({
    eligibility: "uncertain",
    evidence: "unavailable",
    recentMinutes: 0,
    foreverMinutes: 0,
    lastPlayed: 0,
    explanation,
  });

  if (!Number.isFinite(underlyingAppId) || underlyingAppId <= 0) {
    return unavailable(
      "Steam Store did not expose the underlying title AppID for this DLC.",
    );
  }

  const bridge = getSteamPlaytimeBridge();

  if (typeof bridge?.GetPlaytime !== "function") {
    return unavailable(
      "SteamClient.App.GetPlaytime is unavailable on this Steam client build.",
    );
  }

  let playtime: SteamPlaytimeLike | undefined;

  try {
    playtime = await bridge.GetPlaytime(underlyingAppId);
  } catch (error) {
    console.warn(
      "[Refund Guard] Underlying-title playtime lookup failed",
      underlyingAppId,
      error,
    );
    return unavailable(
      "Steam did not return aggregate playtime for the underlying title.",
    );
  }

  if (!playtime) {
    return unavailable(
      "Steam did not return aggregate playtime for the underlying title.",
    );
  }

  const rawRecentMinutes = Number(playtime.nPlaytimeLastTwoWeeks);
  const rawForeverMinutes = Number(playtime.nPlaytimeForever);
  const rawLastPlayed = Number(playtime.rtLastTimePlayed);
  const hasRecentMinutes = Number.isFinite(rawRecentMinutes);
  const hasForeverMinutes = Number.isFinite(rawForeverMinutes);
  const hasLastPlayed = Number.isFinite(rawLastPlayed);
  const recentMinutes = hasRecentMinutes ? Math.max(0, rawRecentMinutes) : 0;
  const foreverMinutes = hasForeverMinutes ? Math.max(0, rawForeverMinutes) : 0;
  const lastPlayed = hasLastPlayed ? Math.max(0, rawLastPlayed) : 0;
  const limit = Math.max(1, Number(playtimeLimitMinutes) || 1);
  const ageSeconds = Math.max(0, nowSeconds - purchaseTime);
  const twoWeeksSeconds = 14 * 86400;

  // If Steam says the underlying title has not been launched since the DLC
  // purchase, post-purchase playtime is exactly zero for the purpose of this
  // evidence check.
  if (hasLastPlayed && lastPlayed > 0 && lastPlayed <= purchaseTime) {
    return {
      eligibility: "within",
      evidence: "no_play_since_purchase",
      recentMinutes,
      foreverMinutes,
      lastPlayed,
      upperBoundMinutes: 0,
      explanation:
        "Steam reports no underlying-title launch after the DLC purchase time.",
    };
  }

  // Lifetime playtime is always an upper bound on playtime accumulated after
  // the DLC purchase. If even lifetime usage is under the configured limit,
  // the DLC playtime rule is safely within the configured threshold.
  if (hasForeverMinutes && foreverMinutes <= limit) {
    return {
      eligibility: "within",
      evidence: "lifetime_upper_bound",
      recentMinutes,
      foreverMinutes,
      lastPlayed,
      upperBoundMinutes: foreverMinutes,
      explanation:
        "Underlying-title lifetime playtime is at or below the configured limit, so post-DLC playtime cannot exceed it.",
    };
  }

  // For a DLC bought within the last fourteen days, every minute played after
  // purchase is necessarily contained inside Steam's rolling two-week total.
  // The rolling total can also include minutes from before the DLC purchase,
  // so it is an upper bound, not an exact post-purchase value.
  if (hasRecentMinutes && ageSeconds <= twoWeeksSeconds && recentMinutes <= limit) {
    return {
      eligibility: "within",
      evidence: "last_two_weeks_upper_bound",
      recentMinutes,
      foreverMinutes,
      lastPlayed,
      upperBoundMinutes: recentMinutes,
      explanation:
        "Steam's last-two-weeks total is an upper bound on playtime since this recent DLC purchase and remains within the configured limit.",
    };
  }

  // When the DLC is older than two weeks, every minute in the current rolling
  // two-week total happened after the DLC was purchased. That gives a safe
  // lower bound. This mainly helps users who configured a longer date window;
  // under Steam's standard 14-day DLC window the date rule is already outside.
  if (hasRecentMinutes && ageSeconds > twoWeeksSeconds && recentMinutes > limit) {
    return {
      eligibility: "outside",
      evidence: "last_two_weeks_lower_bound",
      recentMinutes,
      foreverMinutes,
      lastPlayed,
      lowerBoundMinutes: recentMinutes,
      explanation:
        "The DLC is older than two weeks and the underlying title already exceeds the configured limit within the last two weeks alone.",
    };
  }

  return {
    eligibility: "uncertain",
    evidence: "aggregate_only",
    recentMinutes,
    foreverMinutes,
    lastPlayed,
    explanation:
      "Steam exposes aggregate lifetime and last-two-weeks playtime, but not the exact minutes played after this DLC was purchased. Refund Guard will not guess.",
  };
}

type SteamUserBridge = {
  GetIPCountry?: () => Promise<string>;
};

async function getSteamCountryCode(): Promise<string> {
  try {
    const steamClient = (
      globalThis as typeof globalThis & {
        SteamClient?: {
          User?: SteamUserBridge;
        };
      }
    ).SteamClient;

    const rawCountry = await steamClient?.User?.GetIPCountry?.();

    if (typeof rawCountry !== "string") {
      return "";
    }

    const normalized = rawCountry.trim().toUpperCase();

    return /^[A-Z]{2}$/.test(normalized)
      ? normalized
      : "";
  } catch (error) {
    console.warn(
      "[Refund Guard] Could not resolve Steam Store country",
      error,
    );
    return "";
  }
}

function disposeSubscription(subscription: unknown): void {
  try {
    if (typeof subscription === "function") {
      subscription();
      return;
    }

    if (!subscription || typeof subscription !== "object") {
      return;
    }

    const value = subscription as Record<string, unknown>;

    for (const methodName of [
      "unregister",
      "Unregister",
      "dispose",
      "Dispose",
    ]) {
      const method = value[methodName];

      if (typeof method === "function") {
        (method as () => void).call(subscription);
        return;
      }
    }
  } catch {
    // A failed cleanup must not fail the scanner.
  }
}


type SteamConsoleBridge = {
  ExecCommand?: (command: string) => void;
  RegisterForSpewOutput?: (
    callback: (output: unknown) => void,
  ) => unknown;
};

type SteamLicenseBlock = {
  packageId: number;
  appIds: number[];
  raw: string;
};

function getSteamConsoleBridge(): SteamConsoleBridge | null {
  const steamClient = (
    globalThis as typeof globalThis & {
      SteamClient?: {
        Console?: SteamConsoleBridge;
      };
    }
  ).SteamClient;

  return steamClient?.Console ?? null;
}

function getSpewText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  if (!output || typeof output !== "object") {
    return "";
  }

  const record = output as Record<string, unknown>;

  for (const key of ["spew", "text", "output", "message"]) {
    const value = record[key];

    if (typeof value === "string") {
      return value;
    }
  }

  return "";
}

async function captureSteamConsoleCommand(
  command: string,
  hardTimeoutMs = 1800,
): Promise<string> {
  const consoleBridge = getSteamConsoleBridge();

  if (
    !consoleBridge?.ExecCommand ||
    !consoleBridge.RegisterForSpewOutput
  ) {
    return "";
  }

  return await new Promise<string>((resolve) => {
    const chunks: string[] = [];
    let subscription: unknown = null;
    let finished = false;
    let idleTimer: number | undefined;
    let hardTimer: number | undefined;

    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;

      if (idleTimer !== undefined) {
        window.clearTimeout(idleTimer);
      }

      if (hardTimer !== undefined) {
        window.clearTimeout(hardTimer);
      }

      disposeSubscription(subscription);
      resolve(chunks.join("\n"));
    };

    const onOutput = (output: unknown) => {
      const text = getSpewText(output);

      if (!text) {
        return;
      }

      chunks.push(text);

      if (idleTimer !== undefined) {
        window.clearTimeout(idleTimer);
      }

      // Steam normally emits the command result in a short burst. Waiting for
      // a brief quiet period captures multi-line license blocks without making
      // every package lookup wait for the hard timeout.
      idleTimer = window.setTimeout(finish, 220);
    };

    try {
      subscription = consoleBridge.RegisterForSpewOutput?.(onOutput) ?? null;
      hardTimer = window.setTimeout(finish, hardTimeoutMs);
      consoleBridge.ExecCommand?.(command);
    } catch (error) {
      console.warn(
        "[Refund Guard] Steam console command failed",
        command,
        error,
      );
      finish();
    }
  });
}

function parseSteamLicenseBlocks(raw: string): SteamLicenseBlock[] {
  if (!raw) {
    return [];
  }

  const normalized = raw.replace(/\r/g, "");
  const headerPattern = /License packageID\s+(\d+)\s*:/gi;
  const headers = [...normalized.matchAll(headerPattern)];
  const blocks: SteamLicenseBlock[] = [];

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const packageId = Number(header[1] ?? 0);
    const start = header.index ?? 0;
    const end =
      index + 1 < headers.length
        ? (headers[index + 1].index ?? normalized.length)
        : normalized.length;
    const blockText = normalized.slice(start, end);

    if (!Number.isFinite(packageId) || packageId <= 0) {
      continue;
    }

    const appsMatch = blockText.match(
      /-\s*Apps\s*:\s*([\s\S]*?)(?=-\s*Depots\s*:|$)/i,
    );
    const appsText = (appsMatch?.[1] ?? "").replace(
      /\(\s*\d+\s+in total\s*\)/gi,
      "",
    );
    const appIds = [...new Set(
      (appsText.match(/\b\d+\b/g) ?? [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0),
    )];

    blocks.push({
      packageId,
      appIds,
      raw: blockText,
    });
  }

  return blocks;
}

async function getSteamLicensesForApp(
  appId: number,
): Promise<SteamLicenseBlock[]> {
  try {
    const raw = await captureSteamConsoleCommand(
      `licenses_for_app ${appId}`,
    );
    const blocks = parseSteamLicenseBlocks(raw);

    debugLog(
      "[Refund Guard] Active license inspection",
      appId,
      {
        packageIds: blocks.map((block) => block.packageId),
        appsByPackage: blocks.map((block) => ({
          packageId: block.packageId,
          appIds: block.appIds,
        })),
      },
    );

    return blocks;
  } catch (error) {
    console.warn(
      "[Refund Guard] Could not inspect active licenses",
      appId,
      error,
    );
    return [];
  }
}

async function classifyStandaloneDlcLicense(
  dlcAppId: number,
  underlyingAppId: number,
): Promise<{
  isEditionComponent: boolean;
  sharedPackageIds: number[];
  dlcPackageIds: number[];
}> {
  const licenses = await getSteamLicensesForApp(dlcAppId);
  const dlcPackageIds = [...new Set(
    licenses
      .map((block) => Number(block.packageId || 0))
      .filter((packageId) => packageId > 0),
  )];
  const sharedPackageIds = [...new Set(
    licenses
      .filter(
        (block) =>
          block.appIds.includes(dlcAppId) &&
          underlyingAppId > 0 &&
          block.appIds.includes(underlyingAppId),
      )
      .map((block) => Number(block.packageId || 0))
      .filter((packageId) => packageId > 0),
  )];

  return {
    isEditionComponent: sharedPackageIds.length > 0,
    sharedPackageIds,
    dlcPackageIds,
  };
}

async function getLiveAppDetailsSnapshot(
  appId: number,
  appsBridge: SteamAppsBridge,
): Promise<unknown | null> {
  if (typeof appsBridge.RegisterForAppDetails !== "function") {
    return null;
  }

  return await new Promise<unknown | null>((resolve) => {
    let settled = false;
    let subscription: unknown;

    const finish = (value: unknown | null) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      disposeSubscription(subscription);
      resolve(value);
    };

    const timeoutId = window.setTimeout(() => finish(null), 650);

    try {
      subscription = appsBridge.RegisterForAppDetails?.(
        appId,
        (details: unknown) => finish(details),
      );
    } catch (error) {
      console.warn(
        "[Refund Guard] RegisterForAppDetails failed",
        appId,
        error,
      );
      finish(null);
    }
  });
}

async function getAllDlcMetadata(appId: number): Promise<DlcLike[]> {
  const appsBridge = getSteamAppsBridge();

  if (!appsBridge) {
    console.warn("[Refund Guard] SteamClient.Apps is unavailable");
    return [];
  }

  const entries: DlcLike[] = [];

  if (typeof appsBridge.GetCachedAppDetails === "function") {
    try {
      const raw = await appsBridge.GetCachedAppDetails(appId);
      collectDlcEntries(raw, entries, new Set<object>());

      debugLog(
        "[Refund Guard] Cached DLC inspection",
        appId,
        {
          rawType: Array.isArray(raw) ? "array" : typeof raw,
          dlcCount: dedupeDlc(entries).length,
        },
      );
    } catch (error) {
      console.warn(
        "[Refund Guard] GetCachedAppDetails failed",
        appId,
        error,
      );
    }
  }

  // Some Steam builds do not include vecDLC in the cached snapshot but do send
  // it through the AppDetails subscription. Only pay this small wait cost when
  // the cached path found nothing.
  if (entries.length === 0) {
    const liveDetails = await getLiveAppDetailsSnapshot(appId, appsBridge);

    if (liveDetails) {
      collectDlcEntries(
        liveDetails,
        entries,
        new Set<object>(),
      );

      debugLog(
        "[Refund Guard] Live AppDetails DLC inspection",
        appId,
        {
          dlcCount: dedupeDlc(entries).length,
        },
      );
    }
  }

  return dedupeDlc(entries);
}

function dlcPurchasedNear(
  item: DlcLike,
  purchaseTime: number,
  toleranceSeconds: number,
): boolean {
  const dlcPurchaseTime = Number(item.rtPurchaseDate ?? 0);

  return (
    Number.isFinite(dlcPurchaseTime) &&
    dlcPurchaseTime > 0 &&
    Math.abs(dlcPurchaseTime - purchaseTime) <= toleranceSeconds
  );
}

function getPurchasedTogetherDlc(
  allDlc: DlcLike[],
  purchaseTime: number,
): DlcLike[] {
  // Package-granted DLC timestamps should normally be extremely close to the
  // base app timestamp. Two hours is generous enough for Steam-side timing
  // differences without treating old DLC as the same purchase.
  const sameTransactionTolerance = 2 * 60 * 60;

  return allDlc.filter((item) =>
    dlcPurchasedNear(
      item,
      purchaseTime,
      sameTransactionTolerance,
    )
  );
}

function cleanStoreOptionText(value: string): string {
  const text = String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";

  const parts = text.split(/\s+-\s+/);
  const currencyTail = /(?:\$\s*\d)|(?:\d[\d.,]*\s*(?:USD|EUR|GBP|TRY|CAD|AUD|JPY|CNY|RUB|BRL|PLN|KRW|INR|CHF|SEK|NOK|DKK|NZD|MXN|SGD|HKD|TWD|UAH|ZAR)\b)/i;

  while (parts.length > 1 && currencyTail.test(parts[parts.length - 1])) {
    parts.pop();
  }

  return parts.join(" - ").trim();
}

type PackageMatch = {
  details: PackageDetails;
  components: DlcLike[];
  source: "license_console" | "master_sub";
  maxTimestampDelta: number;
};

type PackageResolution = {
  match: PackageMatch | null;
  classification: "base_only" | "edition" | "separate" | "uncertain";
  purchasedTogetherDlc: DlcLike[];
  separateDlc: DlcLike[];
};

async function resolvePurchasedPackage(
  app: SteamAppOverviewLike,
  appId: number,
  purchaseTime: number,
  allDlc: DlcLike[],
  storeDetails: StoreDetails,
  countryCode: string,
): Promise<PackageResolution> {
  const options = Array.isArray(storeDetails.package_options)
    ? storeDetails.package_options
    : [];
  const purchasedTogetherDlc = getPurchasedTogetherDlc(
    allDlc,
    purchaseTime,
  );

  if (purchasedTogetherDlc.length === 0) {
    return {
      match: null,
      classification: "base_only",
      purchasedTogetherDlc: [],
      separateDlc: [],
    };
  }

  const optionIds = new Set(
    options
      .map((option) => Number(option.package_id ?? 0))
      .filter((packageId) => packageId > 0),
  );
  const togetherIds = purchasedTogetherDlc
    .map((item) => Number(item.unAppID ?? 0))
    .filter((value) => value > 0);
  const masterSubId = Number(app.mastersub_appid ?? 0);

  debugLog(
    "[Refund Guard] Package detection inputs",
    appId,
    {
      packageOptions: [...optionIds],
      masterSubId,
      cachedDlcCount: allDlc.length,
      dlcWithPurchaseDate: allDlc.filter(
        (item) => Number(item.rtPurchaseDate ?? 0) > 0,
      ).length,
      purchasedTogetherDlc: togetherIds,
    },
  );

  const detailsCache = new Map<number, PackageDetails | null>();

  const loadPackage = async (
    packageId: number,
  ): Promise<PackageDetails | null> => {
    if (detailsCache.has(packageId)) {
      return detailsCache.get(packageId) ?? null;
    }

    try {
      const raw = await backend.getPackageDetailsJson(
        packageId,
        countryCode,
      );
      const details = parseBackendObject<PackageDetails>(raw);

      if (!details?.ok) {
        console.warn(
          "[Refund Guard] Package Store details unavailable",
          packageId,
          {
            countryCode,
            error: details?.error ?? "Invalid package response",
          },
        );
        detailsCache.set(packageId, null);
        return null;
      }

      debugLog(
        "[Refund Guard] Package Store details loaded",
        packageId,
        {
          countryCode,
          name: details.name ?? "",
          publicAppIds: Array.isArray(details.apps)
            ? details.apps.map((entry) => Number(entry.id ?? 0))
            : [],
          price: details.formatted_final ?? "",
        },
      );

      detailsCache.set(packageId, details);
      return details;
    } catch (error) {
      console.warn(
        "[Refund Guard] Package Store lookup failed",
        packageId,
        error,
      );
      detailsCache.set(packageId, null);
      return null;
    }
  };

  // Steam's active license is the authoritative ownership signal. We do not
  // infer "edition" from timestamp alone. Timestamp only tells us which DLC
  // might belong to the same checkout; the license tells us whether the same
  // package actually grants the base app and each DLC.
  const baseLicenses = await getSteamLicensesForApp(appId);
  const dlcLicensesByApp = new Map<number, SteamLicenseBlock[]>();

  for (const dlcId of togetherIds.slice(0, 16)) {
    dlcLicensesByApp.set(
      dlcId,
      await getSteamLicensesForApp(dlcId),
    );
  }

  const activeLicenseCandidates = baseLicenses
    .filter((block) => block.appIds.includes(appId))
    .map((block) => {
      const coveredDlcIds = togetherIds.filter((dlcId) => {
        if (block.appIds.includes(dlcId)) {
          return true;
        }

        const dlcLicenses = dlcLicensesByApp.get(dlcId) ?? [];
        return dlcLicenses.some(
          (candidate) => candidate.packageId === block.packageId,
        );
      });

      const knownPackageDlcIds = block.appIds.filter((candidateAppId) =>
        allDlc.some(
          (item) => Number(item.unAppID ?? 0) === candidateAppId,
        )
      );
      const unrelatedKnownDlcCount = knownPackageDlcIds.filter(
        (dlcId) => !togetherIds.includes(dlcId),
      ).length;

      return {
        block,
        coveredDlcIds,
        unrelatedKnownDlcCount,
        isStoreOption: optionIds.has(block.packageId),
      };
    })
    // A package must grant the base app AND at least one same-checkout DLC to
    // count as an edition/package. This deliberately supports mixed carts:
    // base + edition + one unrelated standalone DLC can still resolve the
    // edition package while leaving the unrelated DLC separate.
    .filter((candidate) => candidate.coveredDlcIds.length > 0);

  activeLicenseCandidates.sort((left, right) => {
    if (left.isStoreOption !== right.isStoreOption) {
      return left.isStoreOption ? -1 : 1;
    }

    const coverage =
      right.coveredDlcIds.length - left.coveredDlcIds.length;

    if (coverage !== 0) {
      return coverage;
    }

    const extras =
      left.unrelatedKnownDlcCount - right.unrelatedKnownDlcCount;

    if (extras !== 0) {
      return extras;
    }

    return left.block.appIds.length - right.block.appIds.length;
  });

  const activeCandidate = activeLicenseCandidates[0] ?? null;

  if (activeCandidate) {
    const activeLicense = activeCandidate.block;
    const packageId = activeLicense.packageId;
    const option = options.find(
      (candidate) => Number(candidate.package_id ?? 0) === packageId,
    );
    // If this exact active-license package is already exposed as a current
    // purchase option on the app page, we have everything needed for identity
    // and regional price. Avoid the public packagedetails request entirely; it
    // is slower, may omit DLC AppIDs, and can intermittently fail.
    const storePackage = option ? null : await loadPackage(packageId);
    const details: PackageDetails = storePackage ?? {
      ok: true,
      package_id: packageId,
      name: cleanStoreOptionText(option?.option_text || ""),
      apps: activeLicense.appIds.map((licenseAppId) => ({
        id: licenseAppId,
        name: "",
      })),
      has_price: false,
    };

    // Prefer the app page's purchase option for the current regional price.
    // Public packagedetails may omit DLC AppIDs even for a real edition.
    if (option && Number(option.price ?? 0) > 0) {
      details.has_price = true;
      details.currency = storeDetails.currency ?? details.currency ?? "";
      details.final = Number(option.price);
      details.discount_percent = Number(option.percent_savings ?? 0);
      details.formatted_final = fallbackPrice(
        Number(option.price),
        details.currency ?? "",
      );
    }

    if (!details.name && option?.option_text) {
      details.name = cleanStoreOptionText(option.option_text);
    }

    const coveredSet = new Set(activeCandidate.coveredDlcIds);
    const components = purchasedTogetherDlc.filter((item) =>
      coveredSet.has(Number(item.unAppID ?? 0))
    );
    const separateDlc = purchasedTogetherDlc.filter((item) =>
      !coveredSet.has(Number(item.unAppID ?? 0))
    );

    debugLog(
      "[Refund Guard] Matched Steam package from active license",
      appId,
      packageId,
      {
        name: details.name ?? "",
        storeOption: optionIds.has(packageId),
        licenseAppIds: activeLicense.appIds,
        componentIds: components.map(
          (item) => Number(item.unAppID ?? 0),
        ),
        separateSameCheckoutDlcIds: separateDlc.map(
          (item) => Number(item.unAppID ?? 0),
        ),
        price: details.formatted_final ?? "",
      },
    );

    return {
      match: {
        details,
        components,
        source: "license_console",
        maxTimestampDelta: Math.max(
          0,
          ...components.map((item) =>
            Math.abs(
              Number(item.rtPurchaseDate ?? 0) - purchaseTime,
            )
          ),
        ),
      },
      classification: "edition",
      purchasedTogetherDlc,
      separateDlc,
    };
  }

  // Compatibility fallback for a client where console spew is unavailable.
  if (masterSubId > 0 && optionIds.has(masterSubId)) {
    const details = await loadPackage(masterSubId);
    const publicAppIds = (details?.apps ?? [])
      .map((entry) => Number(entry.id ?? 0))
      .filter((value) => value > 0);
    const packageDlcIds = publicAppIds.filter(
      (value) => value !== appId,
    );

    if (
      details?.ok &&
      publicAppIds.includes(appId) &&
      packageDlcIds.length > 0
    ) {
      const components = purchasedTogetherDlc.filter((item) =>
        packageDlcIds.includes(Number(item.unAppID ?? 0))
      );

      if (components.length > 0) {
        const componentIds = new Set(
          components.map((item) => Number(item.unAppID ?? 0)),
        );

        return {
          match: {
            details,
            components,
            source: "master_sub",
            maxTimestampDelta: Math.max(
              0,
              ...components.map((item) =>
                Math.abs(
                  Number(item.rtPurchaseDate ?? 0) - purchaseTime,
                )
              ),
            ),
          },
          classification: "edition",
          purchasedTogetherDlc,
          separateDlc: purchasedTogetherDlc.filter(
            (item) => !componentIds.has(Number(item.unAppID ?? 0)),
          ),
        };
      }
    }
  }

  const reliableLicenseData =
    baseLicenses.length > 0 &&
    togetherIds.every(
      (dlcId) => (dlcLicensesByApp.get(dlcId)?.length ?? 0) > 0,
    );

  if (reliableLicenseData) {
    debugLog(
      "[Refund Guard] Same-time DLC uses separate Steam licenses",
      appId,
      {
        basePackageIds: baseLicenses.map((block) => block.packageId),
        dlcPackages: togetherIds.map((dlcId) => ({
          appId: dlcId,
          packageIds: (dlcLicensesByApp.get(dlcId) ?? []).map(
            (block) => block.packageId,
          ),
        })),
      },
    );

    return {
      match: null,
      classification: "separate",
      purchasedTogetherDlc,
      separateDlc: purchasedTogetherDlc,
    };
  }

  debugLog(
    "[Refund Guard] Edition/package ownership remains uncertain",
    appId,
    {
      purchasedTogetherDlc: purchasedTogetherDlc.map((item) => ({
        appId: Number(item.unAppID ?? 0),
        name: item.strName ?? "",
        purchaseTime: Number(item.rtPurchaseDate ?? 0),
        delta: Math.abs(
          Number(item.rtPurchaseDate ?? 0) - purchaseTime,
        ),
      })),
      activeBaseLicensePackageIds: baseLicenses.map(
        (block) => block.packageId,
      ),
      storePackageOptions: [...optionIds],
    },
  );

  return {
    match: null,
    classification: "uncertain",
    purchasedTogetherDlc,
    separateDlc: [],
  };
}
function RefundGuardIcon() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: "22px",
        height: "22px",
        borderRadius: "7px",
        background: "linear-gradient(145deg, #1a9fff, #1161a8)",
        display: "grid",
        placeItems: "center",
        color: "#ffffff",
        fontWeight: 800,
        fontSize: "14px",
        lineHeight: 1,
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
      }}
    >
      $
    </div>
  );
}

function PrimaryButton({
  children,
  disabled = false,
  onClick,
}: {
  children: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        border: "none",
        borderRadius: "6px",
        padding: "9px 14px",
        cursor: disabled ? "default" : "pointer",
        fontWeight: 700,
        fontSize: "13px",
        color: "#ffffff",
        opacity: disabled ? 0.55 : 1,
        background: "linear-gradient(90deg, #06bfff 0%, #2d73ff 100%)",
      }}
    >
      {children}
    </button>
  );
}

function ToggleSetting({
  label,
  description,
  value,
  setValue,
}: {
  label: string;
  description: string;
  value: boolean | undefined;
  setValue: (next: boolean) => void | Promise<void>;
}) {
  // Millennium 3.4.1 persists config changes correctly, but the visual Toggle
  // can remain on its previous position until a later config refresh. Keep an
  // optimistic local value so the switch immediately reflects the click while
  // persisting through the Lua-backed config bridge.
  const [visualValue, setVisualValue] = useState(value ?? false);

  useEffect(() => {
    if (value !== undefined) {
      setVisualValue(value);
    }
  }, [value]);

  return (
    <Field
      label={label}
      description={description}
      bottomSeparator="standard"
    >
      <Toggle
        value={visualValue}
        onChange={(next: boolean) => {
          setVisualValue(next);

          Promise.resolve(setValue(next)).catch((error: unknown) => {
            console.warn(
              "[Refund Guard] Could not persist toggle setting",
              label,
              error,
            );
            setVisualValue(value ?? false);
          });
        }}
      />
    </Field>
  );
}

function NumberSetting({
  label,
  description,
  value,
  fallback,
  min,
  max,
  setValue,
}: {
  label: string;
  description: string;
  value: number | undefined;
  fallback: number;
  min: number;
  max: number;
  setValue: (next: number) => void | Promise<void>;
}) {
  const [visualValue, setVisualValue] = useState(value ?? fallback);

  useEffect(() => {
    if (value !== undefined) {
      setVisualValue(value);
    }
  }, [value]);

  return (
    <Field
      label={label}
      description={description}
      bottomSeparator="standard"
      childrenLayout="below"
    >
      <div style={{ width: "180px", marginTop: "8px" }}>
        <TextField
          mustBeNumeric
          value={String(visualValue)}
          onChange={(event: { currentTarget: { value: string } }) => {
            const parsed = Number.parseInt(event.currentTarget.value, 10);

            if (!Number.isFinite(parsed)) {
              return;
            }

            const clamped = Math.max(min, Math.min(max, parsed));
            setVisualValue(clamped);

            Promise.resolve(setValue(clamped)).catch((error: unknown) => {
              console.warn(
                "[Refund Guard] Could not persist numeric setting",
                label,
                error,
              );
              setVisualValue(value ?? fallback);
            });
          }}
        />
      </div>
    </Field>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: "1 1 0",
        border: active
          ? "1px solid rgba(26,159,255,0.42)"
          : "1px solid rgba(255,255,255,0.07)",
        borderRadius: "7px",
        padding: "8px 12px",
        cursor: "pointer",
        fontWeight: 750,
        fontSize: "11px",
        letterSpacing: "0.055em",
        color: active ? "#ffffff" : "rgba(255,255,255,0.62)",
        background: active
          ? "rgba(26,159,255,0.18)"
          : "rgba(255,255,255,0.035)",
      }}
    >
      {children}
    </button>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div
      style={{
        padding: "7px 9px",
        borderRadius: "8px",
        background: "rgba(255,255,255,0.042)",
        border: "1px solid rgba(255,255,255,0.055)",
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: "16px",
          fontWeight: 760,
          lineHeight: 1.05,
          marginBottom: "2px",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: "8.75px",
          lineHeight: 1.2,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          opacity: 0.46,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function PriceStat({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div
      style={{
        minWidth: 0,
        padding: "8px 7px",
        borderRadius: "7px",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.055)",
      }}
    >
      <div
        style={{
          marginBottom: "3px",
          fontSize: "8.5px",
          fontWeight: 750,
          letterSpacing: "0.065em",
          textTransform: "uppercase",
          opacity: 0.46,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "12px",
          fontWeight: 720,
          lineHeight: 1.25,
          opacity: muted ? 0.62 : 0.94,
          whiteSpace: "normal",
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
    </div>
  );
}

type RefundRuleVerdict = "within" | "outside" | "uncertain";

type RefundRuleDisplay = {
  verdict: RefundRuleVerdict;
  title: string;
  explanation: string;
  purchaseAgeValue: string;
  purchaseAgeState: "within" | "outside";
  playtimeValue: string;
  playtimeState: PlaytimeEligibility;
};

function refundRuleDisplay(item: ScanResult): RefundRuleDisplay {
  const refundWindowDays = Math.max(1, Number(item.refundWindowDays ?? 14));
  const playtimeLimitMinutes = Math.max(1, Number(item.playtimeLimitMinutes ?? 120));
  const withinDate = item.withinDate ?? item.ageDays <= refundWindowDays;
  const playtimeState: PlaytimeEligibility =
    item.playtimeEligibility ??
    (item.withinPlaytime === null
      ? "uncertain"
      : item.withinPlaytime === false
        ? "outside"
        : item.playtimeMinutes <= playtimeLimitMinutes
          ? "within"
          : "outside");

  let playtimeValue = `${formatPlaytime(item.playtimeMinutes)} / ${formatPlaytime(playtimeLimitMinutes)}`;

  if (item.isStandaloneDlc) {
    if (playtimeState === "uncertain") {
      playtimeValue = "Post-purchase playtime unknown";
    } else if (item.dlcPlaytimeUpperBoundMinutes !== undefined) {
      playtimeValue = `<= ${formatPlaytime(item.dlcPlaytimeUpperBoundMinutes)} / ${formatPlaytime(playtimeLimitMinutes)}`;
    } else if (item.dlcPlaytimeLowerBoundMinutes !== undefined) {
      playtimeValue = `>= ${formatPlaytime(item.dlcPlaytimeLowerBoundMinutes)} / ${formatPlaytime(playtimeLimitMinutes)}`;
    }
  }

  if (item.dataFreshness === "saved") {
    return {
      verdict: "uncertain",
      title: "Refresh unavailable - saved rule data",
      explanation:
        "Steam data could not be refreshed. Purchase age is recalculated, but playtime and price values below are from the last successful scan.",
      purchaseAgeValue: `${formatAge(item.ageDays)} / ${refundWindowDays}d`,
      purchaseAgeState: withinDate ? "within" : "outside",
      playtimeValue,
      playtimeState: "uncertain",
    };
  }

  if (!withinDate && playtimeState === "outside") {
    return {
      verdict: "outside",
      title: "Outside configured standard rules",
      explanation: "Purchase age and playtime are both outside your configured limits.",
      purchaseAgeValue: `${formatAge(item.ageDays)} / ${refundWindowDays}d`,
      purchaseAgeState: "outside",
      playtimeValue,
      playtimeState,
    };
  }

  if (!withinDate) {
    return {
      verdict: "outside",
      title: "Outside configured standard rules",
      explanation: `Purchase age exceeds your configured ${refundWindowDays}-day limit.`,
      purchaseAgeValue: `${formatAge(item.ageDays)} / ${refundWindowDays}d`,
      purchaseAgeState: "outside",
      playtimeValue,
      playtimeState,
    };
  }

  if (playtimeState === "outside") {
    return {
      verdict: "outside",
      title: "Outside configured standard rules",
      explanation: item.isStandaloneDlc
        ? `Available underlying-title playtime evidence is outside your configured ${formatPlaytime(playtimeLimitMinutes)} limit.`
        : `Playtime ${formatPlaytime(item.playtimeMinutes)} exceeds your configured ${formatPlaytime(playtimeLimitMinutes)} limit.`,
      purchaseAgeValue: `${formatAge(item.ageDays)} / ${refundWindowDays}d`,
      purchaseAgeState: "within",
      playtimeValue,
      playtimeState,
    };
  }

  if (playtimeState === "uncertain") {
    return {
      verdict: "uncertain",
      title: "Refund rule check is uncertain",
      explanation: item.isStandaloneDlc
        ? "Steam does not expose exact underlying-title playtime since this DLC purchase, so Refund Guard will not guess."
        : "Playtime eligibility could not be determined safely.",
      purchaseAgeValue: `${formatAge(item.ageDays)} / ${refundWindowDays}d`,
      purchaseAgeState: "within",
      playtimeValue,
      playtimeState,
    };
  }

  return {
    verdict: "within",
    title: "Appears within configured standard rules",
    explanation: item.isStandaloneDlc
      ? "Purchase age and available underlying-title playtime evidence are within your configured limits."
      : "Purchase age and playtime are within your configured limits.",
    purchaseAgeValue: `${formatAge(item.ageDays)} / ${refundWindowDays}d`,
    purchaseAgeState: "within",
    playtimeValue,
    playtimeState,
  };
}

function RefundRuleLine({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state: "within" | "outside" | "uncertain";
}) {
  const stateLabel = state === "within" ? "WITHIN" : state === "outside" ? "OUTSIDE" : "UNCERTAIN";
  const stateColor =
    state === "within"
      ? "rgba(104,214,111,0.95)"
      : state === "outside"
        ? "rgba(245,184,73,0.96)"
        : "rgba(220,220,220,0.72)";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(70px, 0.8fr) minmax(0, 1fr) auto",
        gap: "6px",
        alignItems: "center",
        padding: "4px 0",
        borderTop: "1px solid rgba(255,255,255,0.045)",
        fontSize: "9.5px",
        lineHeight: 1.3,
      }}
    >
      <div style={{ opacity: 0.52 }}>{label}</div>
      <div style={{ opacity: 0.82, minWidth: 0, overflowWrap: "anywhere" }}>{value}</div>
      <div style={{ color: stateColor, fontSize: "8px", fontWeight: 800, letterSpacing: "0.045em" }}>
        {stateLabel}
      </div>
    </div>
  );
}

function RefundRulePanel({ item }: { item: ScanResult }) {
  const assessment = refundRuleDisplay(item);
  const background =
    assessment.verdict === "within"
      ? "rgba(82,190,89,0.075)"
      : assessment.verdict === "outside"
        ? "rgba(245,184,73,0.075)"
        : "rgba(255,255,255,0.035)";
  const border =
    assessment.verdict === "within"
      ? "1px solid rgba(82,190,89,0.20)"
      : assessment.verdict === "outside"
        ? "1px solid rgba(245,184,73,0.20)"
        : "1px solid rgba(255,255,255,0.08)";
  const titleColor =
    assessment.verdict === "within"
      ? "rgba(119,224,126,0.96)"
      : assessment.verdict === "outside"
        ? "rgba(247,193,88,0.98)"
        : "rgba(235,235,235,0.88)";

  return (
    <div
      style={{
        marginTop: "8px",
        padding: "8px 9px",
        borderRadius: "8px",
        background,
        border,
      }}
    >
      <div
        style={{
          fontSize: "8px",
          fontWeight: 800,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          opacity: 0.5,
          marginBottom: "3px",
        }}
      >
        Refund rule check
      </div>
      <div style={{ color: titleColor, fontSize: "11px", fontWeight: 780, lineHeight: 1.25 }}>
        {assessment.title}
      </div>
      <div style={{ marginTop: "3px", marginBottom: "5px", fontSize: "9px", lineHeight: 1.38, opacity: 0.58 }}>
        {assessment.explanation}
      </div>
      <RefundRuleLine
        label="Purchase age"
        value={assessment.purchaseAgeValue}
        state={assessment.purchaseAgeState}
      />
      <RefundRuleLine
        label={item.isStandaloneDlc ? "DLC playtime" : "Playtime"}
        value={assessment.playtimeValue}
        state={assessment.playtimeState}
      />
      {item.isStandaloneDlc ? (
        <div style={{ marginTop: "4px", fontSize: "8.5px", lineHeight: 1.35, opacity: 0.42 }}>
          DLC may have additional Steam restrictions that Refund Guard cannot verify automatically.
        </div>
      ) : null}
      <div style={{ marginTop: "5px", fontSize: "8px", lineHeight: 1.3, opacity: 0.34 }}>
        Valve/Steam makes the final refund eligibility decision.
      </div>
    </div>
  );
}

function PriceComparisonPanel({ item }: { item: ScanResult }) {
  const savedRefresh = item.dataFreshness === "saved";
  const actualPaidAvailable = Number(item.paidPrice ?? 0) > 0;
  const comparisonPrice = Math.max(
    0,
    Number(
      item.comparisonPrice ??
        (actualPaidAvailable ? item.paidPrice : item.baselinePrice) ??
        0,
    ),
  );
  const comparisonSource: PriceComparisonSource =
    item.comparisonSource ??
    (actualPaidAvailable ? "actual_paid" : "observed_baseline");
  const priceDropPercent = Math.max(
    0,
    Number(item.priceDropPercent ?? item.observedDropPercent ?? 0),
  );
  const savings = Math.max(
    0,
    Number(item.savings ?? item.observedSavings ?? 0),
  );
  const threshold = Math.max(0, Number(item.minimumDropPercent ?? 0));
  const meaningfulDrop =
    item.meaningfulDrop ??
    (savings > 0 && threshold > 0 && priceDropPercent >= threshold);

  if (item.currentPrice <= 0 || comparisonPrice <= 0) {
    return null;
  }

  const referenceLabel =
    comparisonSource === "actual_paid" ? "Paid" : "Baseline";
  const referenceFormatted =
    item.comparisonPriceFormatted || fallbackPrice(comparisonPrice, item.currency);
  const savingsFormatted = moneyDifference(savings, item.currency);

  return (
    <div
      style={{
        marginTop: "10px",
        padding: "9px",
        borderRadius: "8px",
        background: "rgba(255,255,255,0.035)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "7px",
          marginBottom: "7px",
        }}
      >
        <div style={{ fontSize: "10px", fontWeight: 750, opacity: 0.72 }}>
          Price check
        </div>
        <div
          style={{
            flex: "0 0 auto",
            padding: "3px 6px",
            borderRadius: "999px",
            background: meaningfulDrop
              ? "rgba(82,190,89,0.12)"
              : "rgba(255,255,255,0.045)",
            border: meaningfulDrop
              ? "1px solid rgba(82,190,89,0.20)"
              : "1px solid rgba(255,255,255,0.06)",
            fontSize: "8.75px",
            fontWeight: 700,
            opacity: meaningfulDrop ? 0.82 : 0.5,
            whiteSpace: "nowrap",
          }}
        >
          {savedRefresh
            ? "Saved snapshot - refresh unavailable"
            : meaningfulDrop
              ? "Meaningful price drop"
              : item.comparisonEstablished === false
                ? "Baseline established"
                : "No meaningful price drop"}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: "5px",
        }}
      >
        <PriceStat label={referenceLabel} value={referenceFormatted} />
        <PriceStat label={savedRefresh ? "Last" : "Now"} value={item.currentPriceFormatted} />
        <PriceStat label="Save" value={savedRefresh ? "--" : savingsFormatted} muted={savedRefresh || savings <= 0} />
      </div>

      <div style={{ marginTop: "5px", fontSize: "8.75px", opacity: 0.46 }}>
        {savedRefresh
          ? "Price drop not evaluated until Steam Store refresh succeeds"
          : `${priceDropPercent.toFixed(1)}% drop - ${threshold > 0 ? `${threshold.toFixed(0)}% required` : "no threshold"}`}
      </div>

      {item.priceAvailabilityReason === "currency_mismatch" && item.historicalPaidPriceFormatted ? (
        <div style={{ marginTop: "5px", fontSize: "8.75px", lineHeight: 1.35, opacity: 0.5 }}>
          Historical paid: {item.historicalPaidPriceFormatted}. Different currencies are never converted automatically.
        </div>
      ) : null}

      {item.isStandaloneDlc && (item.underlyingGameName || item.underlyingAppId) ? (
        <div style={{ marginTop: "4px", fontSize: "9px", opacity: 0.42 }}>
          Underlying title: {item.underlyingGameName || `App ${item.underlyingAppId}`}
        </div>
      ) : null}
    </div>
  );
}

type RefundGuardAction = "support" | "store";

function steamSupportUrl(item: ScanResult): string {
  return `https://help.steampowered.com/wizard/HelpWithGame/?appid=${Math.max(0, Math.trunc(item.appId))}`;
}

function steamStoreUrl(item: ScanResult): string {
  if (item.purchaseKind === "package" && item.packageId > 0) {
    return `https://store.steampowered.com/sub/${Math.trunc(item.packageId)}/`;
  }

  return `https://store.steampowered.com/app/${Math.max(0, Math.trunc(item.appId))}/`;
}

const MILLENNIUM_SIDEBAR_RESTORE_DELAY_MS = 420;
let actionNavigationRunning = false;

function waitMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function closeMillenniumSidebarBeforeNavigation(
  action: RefundGuardAction,
  anchor: HTMLElement,
): Promise<void> {
  // Refund Guard's plugin renderer can execute with a different global document
  // from the Steam host window that owns MillenniumDesktopSidebar. Resolve the
  // actual host from the clicked element exactly like Millennium does internally.
  const hostWindow =
    getParentWindow<Window>(anchor) ??
    anchor.ownerDocument.defaultView ??
    window;
  const hostDocument = hostWindow.document ?? anchor.ownerDocument;

  const sidebar = hostDocument.querySelector<HTMLElement>(
    ".MillenniumDesktopSidebar",
  );
  const overlay = hostDocument.querySelector<HTMLElement>(
    ".MillenniumDesktopSidebar_Overlay",
  );

  debugLog("[Refund Guard] Millennium Library sidebar host probe", {
    action,
    hostWindowFound: Boolean(hostWindow),
    sameAsGlobalDocument: hostDocument === document,
    sidebarFound: Boolean(sidebar),
    overlayFound: Boolean(overlay),
  });

  if (!sidebar || !overlay) {
    throw new Error(
      "Millennium Library sidebar host elements could not be found; navigation was cancelled to avoid leaving a frozen overlay.",
    );
  }

  // Millennium's own quick-access sidebar binds its closeMenu() handler to this
  // overlay. Programmatic click therefore follows the same close path as a user
  // clicking the dimmed area. Its internal closeQuickAccess() restores Steam's
  // browser after 300 ms.
  overlay.click();

  debugLog(
    "[Refund Guard] Millennium Library sidebar close requested in host window",
    { action },
  );

  await waitMs(MILLENNIUM_SIDEBAR_RESTORE_DELAY_MS);

  debugLog(
    "[Refund Guard] Millennium Library sidebar host restore delay completed",
    {
      action,
      delayMs: MILLENNIUM_SIDEBAR_RESTORE_DELAY_MS,
    },
  );
}

async function openSteamAction(
  item: ScanResult,
  action: RefundGuardAction,
  anchor: HTMLElement,
): Promise<void> {
  if (actionNavigationRunning) {
    console.log("[Refund Guard] User action ignored while navigation is already in progress", {
      action,
    });
    return;
  }

  actionNavigationRunning = true;

  const url = action === "support" ? steamSupportUrl(item) : steamStoreUrl(item);

  console.log("[Refund Guard] User action", {
    action,
    appId: item.appId,
    purchaseKind: item.purchaseKind,
    packageId: item.packageId,
    targetKind:
      action === "support"
        ? "steam_support_app"
        : item.purchaseKind === "package" && item.packageId > 0
          ? "steam_store_package"
          : "steam_store_app",
  });

  try {
    // This is a MillenniumDesktopSidebar, not Steam's native side menu. Close
    // Millennium first and let it restore the hidden main browser before URL
    // navigation. Steam CloseSideMenus does not close this Millennium panel.
    await closeMillenniumSidebarBeforeNavigation(action, anchor);

    try {
      Navigation.NavigateToSteamWeb(url);
      console.log("[Refund Guard] Steam-native user navigation completed", {
        action,
      });
      return;
    } catch (error) {
      console.warn(
        `[Refund Guard] Steam-native ${action} navigation failed; trying external web navigation`,
        error,
      );
    }

    try {
      Navigation.NavigateToExternalWeb(url);
      console.log("[Refund Guard] External user navigation completed", {
        action,
      });
    } catch (fallbackError) {
      console.error(
        `[Refund Guard] Could not open ${action} destination`,
        fallbackError,
      );
    }
  } finally {
    actionNavigationRunning = false;
  }
}

function ActionButton({
  children,
  onClick,
  primary = false,
}: {
  children: React.ReactNode;
  onClick: (anchor: HTMLElement) => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(event) => onClick(event.currentTarget)}
      style={{
        flex: "1 1 0",
        minWidth: 0,
        borderRadius: "6px",
        border: primary
          ? "1px solid rgba(82,190,89,0.42)"
          : "1px solid rgba(255,255,255,0.11)",
        background: primary
          ? "rgba(82,190,89,0.19)"
          : "rgba(255,255,255,0.065)",
        color: "#ffffff",
        cursor: "pointer",
        padding: "8px 7px",
        fontSize: "10px",
        lineHeight: 1.2,
        fontWeight: 750,
        letterSpacing: "0.025em",
        whiteSpace: "normal",
      }}
    >
      {children}
    </button>
  );
}

function ResultActions({ item }: { item: ScanResult }) {
  const opportunity = item.state === "opportunity";

  return (
    <div
      style={{
        marginTop: "9px",
        paddingTop: "9px",
        borderTop: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "7px",
        }}
      >
        <ActionButton
          primary={opportunity}
          onClick={(anchor) => void openSteamAction(item, "support", anchor)}
        >
          OPEN STEAM SUPPORT
        </ActionButton>
        <ActionButton onClick={(anchor) => void openSteamAction(item, "store", anchor)}>
          OPEN STORE
        </ActionButton>
      </div>
    </div>
  );
}

function ResultCard({ item }: { item: ScanResult }) {
  const opportunity = item.state === "opportunity";
  return (
    <div
      style={{
        padding: "11px",
        borderRadius: "9px",
        background: opportunity
          ? "rgba(26,159,255,0.10)"
          : "rgba(255,255,255,0.038)",
        border: opportunity
          ? "1px solid rgba(26,159,255,0.30)"
          : "1px solid rgba(255,255,255,0.065)",
        marginBottom: "9px",
      }}
    >
      {item.headerImage ? (
        <img
          src={item.headerImage}
          alt=""
          style={{
            width: "100%",
            height: "auto",
            maxHeight: "108px",
            borderRadius: "7px",
            objectFit: "cover",
            display: "block",
            marginBottom: "9px",
          }}
        />
      ) : null}

      <div
        style={{
          fontSize: "14px",
          fontWeight: 730,
          lineHeight: 1.3,
          whiteSpace: "normal",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        }}
      >
        {item.name}
      </div>

      <RefundRulePanel item={item} />

      {item.purchaseKind === "package" ? (
        <div
          style={{
            marginTop: "8px",
            padding: "7px 8px",
            borderRadius: "7px",
            background: "rgba(26,159,255,0.065)",
            border: "1px solid rgba(26,159,255,0.14)",
            fontSize: "10px",
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontWeight: 720, marginBottom: "2px" }}>
            Edition matched - package #{item.packageId}
          </div>
          {item.components.length > 0 ? (
            <div style={{ opacity: 0.58, marginTop: "2px" }}>
              Includes: {item.components.join(", ")}
            </div>
          ) : null}
          {item.baseGamePriceFormatted ? (
            <div style={{ opacity: 0.48, marginTop: "2px" }}>
              Base game: {item.baseGamePriceFormatted}
            </div>
          ) : null}
        </div>
      ) : null}

      {item.isStandaloneDlc ? (
        <div
          style={{
            marginTop: "8px",
            padding: "7px 8px",
            borderRadius: "7px",
            background: "rgba(26,159,255,0.055)",
            border: "1px solid rgba(26,159,255,0.12)",
            fontSize: "10px",
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontWeight: 720, marginBottom: "2px" }}>
            Standalone DLC purchase
          </div>
          <div style={{ opacity: 0.58 }}>
            Underlying title: {item.underlyingGameName || (item.underlyingAppId ? `App ${item.underlyingAppId}` : "Unavailable")}
          </div>
          {item.dlcPlaytimeExplanation ? (
            <div style={{ opacity: 0.48, marginTop: "2px" }}>
              {item.dlcPlaytimeExplanation}
            </div>
          ) : null}
        </div>
      ) : null}

      {item.purchaseKind === "edition_unresolved" ? (
        <div
          style={{
            marginTop: "8px",
            padding: "7px 8px",
            borderRadius: "7px",
            background: "rgba(245,184,73,0.07)",
            border: "1px solid rgba(245,184,73,0.16)",
            fontSize: "10px",
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontWeight: 720, marginBottom: "2px" }}>
            Edition price unresolved
          </div>
          <div style={{ opacity: 0.58 }}>
            DLC was acquired with this game, so Refund Guard did not substitute the base-game price.
          </div>
          {item.components.length > 0 ? (
            <div style={{ opacity: 0.5, marginTop: "2px" }}>
              Detected together: {item.components.join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}

      {(item.separateComponents?.length ?? 0) > 0 ? (
        <div
          style={{
            marginTop: "7px",
            padding: "7px 8px",
            borderRadius: "7px",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.055)",
            fontSize: "9.5px",
            lineHeight: 1.4,
            opacity: 0.68,
          }}
        >
          Separate DLC license: {item.separateComponents?.join(", ")}
        </div>
      ) : null}

      <PriceComparisonPanel item={item} />

      {item.state === "price_unavailable" ||
      item.state === "price_drop_playtime_uncertain" ||
      item.purchaseClassification === "uncertain" ? (
        <div
          style={{
            marginTop: "7px",
            padding: "7px 8px",
            borderRadius: "7px",
            background: "rgba(255,255,255,0.025)",
            fontSize: "9.5px",
            opacity: 0.5,
            lineHeight: 1.42,
          }}
        >
          {item.reason}
        </div>
      ) : null}

      <ResultActions item={item} />
    </div>
  );
}

const AUTO_SCAN_INTERVAL_OPTIONS = [30, 60, 120, 240, 480, 720, 1440] as const;

function normalizedAutoScanInterval(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 60;

  return AUTO_SCAN_INTERVAL_OPTIONS.reduce((closest, candidate) =>
    Math.abs(candidate - numeric) < Math.abs(closest - numeric)
      ? candidate
      : closest,
  60);
}

function formatAutoScanInterval(minutes: number): string {
  const normalized = normalizedAutoScanInterval(minutes);
  if (normalized < 60) return `${normalized} min`;
  const hours = normalized / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

function ScanIntervalSetting({
  value,
  setValue,
}: {
  value: number;
  setValue: (next: number) => void | Promise<void>;
}) {
  const normalized = normalizedAutoScanInterval(value);

  return (
    <Field
      label="Automatic scan interval"
      description="Refund Guard checks when this interval is due while Steam is running. SCAN NOW always remains available."
      bottomSeparator="standard"
      childrenLayout="below"
    >
      <select
        value={String(normalized)}
        onChange={(event) => {
          const next = normalizedAutoScanInterval(Number(event.currentTarget.value));
          void Promise.resolve(setValue(next)).catch((error: unknown) => {
            console.warn("[Refund Guard] Could not persist automatic scan interval", error);
          });
        }}
        style={{
          width: "180px",
          marginTop: "8px",
          padding: "7px 8px",
          borderRadius: "6px",
          border: "1px solid rgba(255,255,255,0.12)",
          background: "#202832",
          color: "#ffffff",
          fontSize: "11px",
        }}
      >
        {AUTO_SCAN_INTERVAL_OPTIONS.map((minutes) => (
          <option key={minutes} value={minutes}>
            {formatAutoScanInterval(minutes)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ConfigSectionTitle({ children }: { children: string }) {
  return (
    <div
      style={{
        fontSize: "10px",
        textTransform: "uppercase",
        letterSpacing: "0.075em",
        opacity: 0.46,
        margin: "5px 0 7px",
        fontWeight: 750,
      }}
    >
      {children}
    </div>
  );
}

function ConfigPage({
  config,
  onChange,
}: {
  config: RefundGuardUserConfig;
  onChange: (
    key: keyof RefundGuardUserConfig,
    value: boolean | number,
  ) => Promise<void>;
}) {
  return (
    <div>
      <ConfigSectionTitle>Monitoring</ConfigSectionTitle>

      <ToggleSetting
        label="Enable Refund Guard"
        description="Master switch for Refund Guard scanning and monitoring."
        value={config.enabled}
        setValue={(next) => onChange("enabled", next)}
      />

      <ToggleSetting
        label="Steam price-drop notifications"
        description="Alert only when a scan finds a new or meaningfully changed qualifying price drop. No price drop means no notification."
        value={config.notify_price_drops}
        setValue={(next) => onChange("notify_price_drops", next)}
      />

      <ToggleSetting
        label="Automatic scanning"
        description="Off = manual SCAN NOW only. On = scan automatically on the selected interval while Steam is running."
        value={config.auto_scan_enabled}
        setValue={(next) => onChange("auto_scan_enabled", next)}
      />

      {config.auto_scan_enabled ? (
        <ScanIntervalSetting
          value={config.scan_interval_minutes}
          setValue={(next) => onChange("scan_interval_minutes", next)}
        />
      ) : null}

      <ToggleSetting
        label="Include standalone DLC"
        description="Show separately purchased DLC as candidates. DLC bundled with an edition remains grouped with that package."
        value={config.include_dlc}
        setValue={(next) => onChange("include_dlc", next)}
      />

      <ToggleSetting
        label="Strict eligibility mode"
        description="Only notify when configured date and playtime rules appear satisfied. Other meaningful drops remain visible with a separate status."
        value={config.strict_eligibility}
        setValue={(next) => onChange("strict_eligibility", next)}
      />

      <ConfigSectionTitle>Rules</ConfigSectionTitle>

      <NumberSetting
        label="Refund window (days)"
        description="Default: 14 days."
        value={config.refund_window_days}
        fallback={14}
        min={1}
        max={90}
        setValue={(next) => onChange("refund_window_days", next)}
      />

      <NumberSetting
        label="Playtime limit (minutes)"
        description="Default: 120 minutes."
        value={config.playtime_limit_minutes}
        fallback={120}
        min={1}
        max={10000}
        setValue={(next) => onChange("playtime_limit_minutes", next)}
      />

      <NumberSetting
        label="Minimum price drop (%)"
        description="Compared with Actual Paid when available; otherwise with the observed baseline fallback."
        value={config.minimum_discount_percent}
        fallback={10}
        min={1}
        max={100}
        setValue={(next) => onChange("minimum_discount_percent", next)}
      />

      <div
        style={{
          marginTop: "11px",
          padding: "9px 10px",
          borderRadius: "8px",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.055)",
          fontSize: "9.5px",
          opacity: 0.5,
          lineHeight: 1.48,
        }}
      >
        Refund Guard v{PLUGIN_VERSION} {BUILD_CHANNEL} - Schema {CURRENT_STATE_SCHEMA_VERSION} - Millennium {MIN_MILLENNIUM_VERSION}+. Automatic scans run only while Steam is running; notifications require a qualifying price drop.
      </div>
    </div>
  );
}

function RefundGuardPanel() {
  const [activeTab, setActiveTab] = useState<GuardTab>("status");

  const [config, setConfig] =
    useState<RefundGuardUserConfig>(DEFAULT_USER_CONFIG);
  const configRef = useRef<RefundGuardUserConfig>(DEFAULT_USER_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [storageCompatible, setStorageCompatible] = useState(true);
  const [runtimeCompatible, setRuntimeCompatible] = useState(true);
  const [runtimeCompatibilityMessage, setRuntimeCompatibilityMessage] = useState("");
  const [millenniumRuntimeVersion, setMillenniumRuntimeVersion] = useState("");

  const [baselinesJson, setBaselinesJson] = useState(
    DEFAULT_PERSISTENT_SNAPSHOT.price_baselines_json,
  );
  const [paidPriceCacheJson, setPaidPriceCacheJson] = useState(
    DEFAULT_PERSISTENT_SNAPSHOT.paid_price_cache_json,
  );
  const [notificationFingerprintsJson, setNotificationFingerprintsJson] = useState(
    DEFAULT_PERSISTENT_SNAPSHOT.notification_fingerprints_json,
  );
  const [cachedResultsJson, setCachedResultsJson] = useState(
    DEFAULT_PERSISTENT_SNAPSHOT.last_results_json,
  );
  const [visualLastScanTime, setVisualLastScanTime] = useState(
    DEFAULT_PERSISTENT_SNAPSHOT.last_scan_time,
  );

  const [results, setResults] = useState<ScanResult[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scannerError, setScannerError] = useState("");
  const [alertMessage, setAlertMessage] = useState("");
  const scanInProgress = useRef(false);
  const lastScanTimeRef = useRef(DEFAULT_PERSISTENT_SNAPSHOT.last_scan_time);
  const [autoSchedulerRevision, setAutoSchedulerRevision] = useState(0);
  const [nextAutoScanAt, setNextAutoScanAt] = useState(0);

  const enabled = config.enabled;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const runtime = await verifyRuntimeCompatibility();

        if (cancelled) {
          return;
        }

        setRuntimeCompatible(runtime.compatible);
        setRuntimeCompatibilityMessage(runtime.message);
        setMillenniumRuntimeVersion(runtime.millenniumVersion);

        if (!runtime.compatible) {
          setScannerError(runtime.message);
          return;
        }

        const snapshot = await readPersistentSnapshot();

        if (cancelled) {
          return;
        }

        if (snapshot.state_schema_version > CURRENT_STATE_SCHEMA_VERSION) {
          setStorageCompatible(false);
          setScannerError(
            `Saved data uses newer Refund Guard state schema ${snapshot.state_schema_version}. Install a matching/newer Refund Guard version before scanning.`,
          );
        } else {
          setStorageCompatible(true);
        }

        const userConfig: RefundGuardUserConfig = {
          enabled: snapshot.enabled,
          notify_price_drops: snapshot.notify_price_drops,
          auto_scan_enabled: snapshot.auto_scan_enabled,
          include_dlc: snapshot.include_dlc,
          strict_eligibility: snapshot.strict_eligibility,
          refund_window_days: snapshot.refund_window_days,
          playtime_limit_minutes: snapshot.playtime_limit_minutes,
          minimum_discount_percent: snapshot.minimum_discount_percent,
          scan_interval_minutes: snapshot.scan_interval_minutes,
        };

        configRef.current = userConfig;
        setConfig(userConfig);
        setBaselinesJson(snapshot.price_baselines_json);
        setPaidPriceCacheJson(snapshot.paid_price_cache_json);
        setNotificationFingerprintsJson(snapshot.notification_fingerprints_json);
        setCachedResultsJson(snapshot.last_results_json);
        lastScanTimeRef.current = snapshot.last_scan_time;
        setVisualLastScanTime(snapshot.last_scan_time);
        setResults(safeParseResults(snapshot.last_results_json));
      } catch (error) {
        console.error("[Refund Guard] Could not load persisted config", error);

        if (!cancelled) {
          setScannerError(
            error instanceof Error
              ? error.message
              : "Refund Guard could not load its saved Config.",
          );
        }
      } finally {
        if (!cancelled) {
          setConfigReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const updateUserSetting = useCallback(
    async (
      key: keyof RefundGuardUserConfig,
      value: boolean | number,
    ): Promise<void> => {
      const previous = configRef.current;
      const next: RefundGuardUserConfig = {
        ...previous,
        [key]: value,
      };

      configRef.current = next;
      setConfig(next);

      try {
        await persistUserConfig(next);
      } catch (error) {
        // Roll back only if no newer setting write has replaced this snapshot.
        if (configRef.current === next) {
          configRef.current = previous;
          setConfig(previous);
        }

        throw error;
      }
    },
    [],
  );

  const runScan = useCallback(async (trigger: "manual" | "automatic" = "manual") => {
    if (scanInProgress.current || globalScanRunning) {
      console.log("[Refund Guard] Scan skipped; another scan is already running");
      return;
    }

    const scanStartedAtMs = Date.now();
    scanInProgress.current = true;
    globalScanRunning = true;
    setIsScanning(true);
    setScannerError("");
    setAlertMessage("");

    try {
      const nowSeconds = Math.floor(Date.now() / 1000);

      if (!configReady) {
        setScannerError("Refund Guard Config is still loading. Try again in a moment.");
        return;
      }

      if (!runtimeCompatible) {
        setScannerError(
          runtimeCompatibilityMessage ||
            "Refund Guard runtime compatibility check failed. Fully restart Steam after updating the plugin.",
        );
        return;
      }

      if (!storageCompatible) {
        setScannerError(
          "Saved Refund Guard data uses a newer state schema. Scanning is disabled to avoid overwriting it.",
        );
        return;
      }

      const scanConfig = configRef.current;

      if (scanConfig.enabled === false) {
        setScannerError("Refund Guard is disabled in Config.");
        return;
      }

      const windowDays = Math.max(1, scanConfig.refund_window_days);
      const playtimeMax = Math.max(1, scanConfig.playtime_limit_minutes);
      const minDrop = Math.max(1, scanConfig.minimum_discount_percent);
      const strict = scanConfig.strict_eligibility;
      const includeDlcValue = scanConfig.include_dlc;
      const notifyPriceDropsValue = scanConfig.notify_price_drops;

      console.log(
        "[Refund Guard] Scan config",
        {
          trigger,
          includeStandaloneDlc: includeDlcValue,
          refundWindowDays: windowDays,
          playtimeLimitMinutes: playtimeMax,
          minimumDropPercent: minDrop,
          strictEligibility: strict,
          postWindowRetentionDays: 7,
        },
      );

      const storeCountryCode = await getSteamCountryCode();

      debugLog(
        "[Refund Guard] Steam Store country",
        storeCountryCode || "automatic",
      );

      const previousResults = safeParseResults(cachedResultsJson);
      const allApps = await getLoadedSteamAppsWhenReady();
      const previouslyTrackedAppIds = new Set(
        previousResults
          .map((item) => Number(item.appId))
          .filter((appId) => Number.isFinite(appId) && appId > 0),
      );
      const postWindowRetentionDays = 7;
      const recentApps: SteamAppOverviewLike[] = [];

      for (const app of allApps) {
        const appId = Number(app.appid ?? 0);
        const purchaseTime = Number(app.rt_purchased_time ?? 0);

        if (!Number.isFinite(appId) || appId <= 0) {
          continue;
        }

        if (!Number.isFinite(purchaseTime) || purchaseTime <= 0) {
          continue;
        }

        try {
          if (typeof app.BIsModOrShortcut === "function" && app.BIsModOrShortcut()) {
            continue;
          }
        } catch {
          // Fail open for ordinary Steam app overviews.
        }

        const ageDays = Math.max(0, nowSeconds - purchaseTime) / 86400;

        if (ageDays > windowDays) {
          const keepForOutsideWindowStatus =
            previouslyTrackedAppIds.has(appId) &&
            ageDays <= windowDays + postWindowRetentionDays;

          if (!keepForOutsideWindowStatus) {
            continue;
          }
        }

        // DLC app-overviews are optional in Steam's loaded map. When present,
        // this toggle controls whether they are standalone candidates.
        if (!includeDlcValue && Number(app.app_type ?? 0) === 32) {
          continue;
        }

        recentApps.push(app);
      }

      recentApps.sort(
        (a, b) =>
          Number(b.rt_purchased_time ?? 0) -
          Number(a.rt_purchased_time ?? 0),
      );

      const uniqueRecentApps: SteamAppOverviewLike[] = [];
      const candidateIdentity = new Set<string>();

      for (const app of recentApps) {
        const appId = Math.trunc(Number(app.appid ?? 0));
        const purchaseTime = Math.trunc(Number(app.rt_purchased_time ?? 0));
        const identity = `${appId}:${purchaseTime}`;
        if (candidateIdentity.has(identity)) continue;
        candidateIdentity.add(identity);
        uniqueRecentApps.push(app);
      }

      if (uniqueRecentApps.length !== recentApps.length) {
        console.warn("[Refund Guard] Duplicate library candidates removed", {
          before: recentApps.length,
          after: uniqueRecentApps.length,
        });
      }

      const candidates = uniqueRecentApps.slice(0, 30);
      const baselines = safeParseBaselines(baselinesJson);
      const paidPriceCache = safeParsePaidPriceCache(paidPriceCacheJson);
      const notificationFingerprints = safeParseNotificationFingerprints(
        notificationFingerprintsJson,
      );
      const hardenedStateRemoved =
        pruneLegacyUnscopedBaselines(baselines) +
        prunePriceBaselines(baselines, nowSeconds) +
        prunePaidPriceCache(paidPriceCache, nowSeconds) +
        pruneNotificationFingerprints(notificationFingerprints, nowSeconds);

      if (hardenedStateRemoved > 0) {
        debugLog("[Refund Guard] Persisted state housekeeping", {
          removedEntries: hardenedStateRemoved,
        });
      }

      // Seed the dedicated cache from any exact paid-price fact still present
      // in older last_results_json data. This is a one-way migration: once a
      // fact is in paid_price_cache_json, a later Store/history outage cannot
      // erase it by overwriting the latest scan results.
      let migratedPaidPriceCount = 0;

      for (const previous of previousResults) {
        const paidPrice = Number(previous.paidPrice ?? 0);

        if (
          !Number.isFinite(paidPrice) ||
          paidPrice <= 0 ||
          (previous.paidPriceConfidence !== "exact_single_item" &&
            previous.paidPriceConfidence !== "exact_receipt_line_item") ||
          (previous.purchaseKind !== "app" &&
            previous.purchaseKind !== "package" &&
            previous.purchaseKind !== "edition_unresolved")
        ) {
          continue;
        }

        const entry: PaidPriceCacheEntry = {
          appId: Number(previous.appId),
          purchaseTime: Number(previous.purchaseTime),
          purchaseKind: previous.purchaseKind,
          packageId: Number(previous.packageId || 0),
          price: paidPrice,
          formatted:
            previous.paidPriceFormatted ||
            fallbackPrice(paidPrice, previous.currency || ""),
          currency: String(previous.currency || "").toUpperCase(),
          source: "steam_purchase_history",
          confidence: previous.paidPriceConfidence,
          resolvedAt: nowSeconds,
        };
        const key = paidPriceCacheKey(entry);

        if (!paidPriceCache[key]) {
          paidPriceCache[key] = entry;
          migratedPaidPriceCount += 1;
        }
      }

      if (migratedPaidPriceCount > 0) {
        debugLog(
          "[Refund Guard] Migrated exact paid prices into persistent cache",
          { count: migratedPaidPriceCount },
        );
      }

      const recentPurchaseTimes = uniqueRecentApps
        .map((candidate) => Number(candidate.rt_purchased_time ?? 0))
        .filter((value) => Number.isFinite(value) && value > 0);
      const historyCutoffSeconds =
        recentPurchaseTimes.length > 0
          ? Math.max(
              0,
              Math.floor(Math.min(...recentPurchaseTimes) - 3 * 86400),
            )
          : 0;

      let purchaseHistoryPromise: Promise<PurchaseHistorySnapshot> | null = null;
      let lastPurchaseHistoryStatus:
        | PurchaseHistorySnapshot["status"]
        | "not_requested" = "not_requested";

      const getPurchaseHistory = async (): Promise<PurchaseHistorySnapshot> => {
        if (!purchaseHistoryPromise) {
          purchaseHistoryPromise = readPurchaseHistoryViaSteamSession(
            historyCutoffSeconds,
          ).then(
            (snapshot) => {
              lastPurchaseHistoryStatus = snapshot.status;

              console.log(
                "[Refund Guard] Purchase history resolver",
                {
                  status: snapshot.status,
                  rowCount: snapshot.rows.length,
                  error: snapshot.error || "",
                },
              );

              return snapshot;
            },
          );
        }

        return await purchaseHistoryPromise;
      };

      const nextResults: ScanResult[] = [];
      let storeLookupAttempts = 0;
      let storeLookupSuccesses = 0;
      let storeLookupFailures = 0;

      for (const app of candidates) {
        const appId = Number(app.appid);
        const purchaseTime = Number(app.rt_purchased_time);
        const ageDays = Math.max(0, nowSeconds - purchaseTime) / 86400;
        let playtimeMinutes = Math.max(
          0,
          Number(app.minutes_playtime_forever ?? 0),
        );
        let isStandaloneDlcCandidate = Number(app.app_type ?? 0) === 32;
        let underlyingAppId = 0;
        let underlyingGameName = "";
        let dlcPlaytimeResolution: DlcPlaytimeResolution | null = null;

        let storeDetails: StoreDetails | null = null;
        let storeLookupError = "Steam Store returned no usable response.";
        storeLookupAttempts += 1;

        try {
          const rawStoreDetails = await backend.getStoreDetailsJson(
            appId,
            storeCountryCode,
          );
          storeDetails = parseBackendObject<StoreDetails>(rawStoreDetails);
          if (!storeDetails || storeDetails.ok !== true) {
            storeLookupError =
              String(storeDetails?.error || "Steam Store returned no usable app details.");
            storeDetails = null;
          }
        } catch (error) {
          storeLookupError =
            error instanceof Error ? error.message : "Steam Store lookup failed.";
          console.warn(
            "[Refund Guard] Store lookup failed for AppID",
            appId,
            error,
          );
        }

        if (!storeDetails) {
          storeLookupFailures += 1;
          const previous = previousResultForPurchase(
            previousResults,
            appId,
            purchaseTime,
          );

          if (previous) {
            nextResults.push(
              retainSavedResultAfterRefreshFailure(
                previous,
                nowSeconds,
                storeLookupError,
              ),
            );
          } else {
            nextResults.push({
              appId,
              name: app.display_name || `App ${appId}`,
              headerImage: "",
              purchaseTime,
              ageDays,
              playtimeMinutes,
              currentPrice: 0,
              currentPriceFormatted: "Unavailable",
              currency: "",
              dataFreshness: "fresh",
              refreshError: storeLookupError,
              steamDiscountPercent: 0,
              baselinePrice: 0,
              baselineFormatted: "",
              observedDropPercent: 0,
              observedSavings: 0,
              eligibleByRules: false,
              state: "price_unavailable",
              reason:
                "Refund Guard received no usable Store response for this app.",
              purchaseKind: "app",
              packageId: 0,
              baseGameName: app.display_name || `App ${appId}`,
              baseGamePriceFormatted: "",
              components: [],
              purchaseClassification: isStandaloneDlcCandidate ? "dlc" : "base_only",
              isStandaloneDlc: isStandaloneDlcCandidate,
              priceAvailabilityReason: "store_unavailable",
            });
          }

          if (storeLookupFailures >= 2 && storeLookupSuccesses === 0) {
            throw new Error(
              "Steam Store appears unavailable. Refund Guard stopped the scan early and kept saved results unchanged.",
            );
          }

          continue;
        }

        storeLookupSuccesses += 1;

        isStandaloneDlcCandidate =
          isStandaloneDlcCandidate ||
          String(storeDetails.store_type || "").toLowerCase() === "dlc";

        // The Include standalone DLC toggle controls candidate cards only.
        // Edition/package detection for base games continues to inspect DLC
        // regardless of this setting so package prices are never confused with
        // base-game prices.
        if (isStandaloneDlcCandidate && !includeDlcValue) {
          continue;
        }

        underlyingAppId = Math.max(
          0,
          Number(storeDetails.fullgame_app_id ?? 0),
        );
        underlyingGameName = String(storeDetails.fullgame_name || "").trim();

        if (isStandaloneDlcCandidate) {
          const dlcLicense = await classifyStandaloneDlcLicense(
            appId,
            underlyingAppId,
          );

          // A DLC AppID granted by the same active package as its underlying
          // base title is an edition/package component, not a standalone DLC
          // purchase. Suppress the duplicate DLC card; the base-game package
          // candidate is responsible for the edition comparison.
          if (dlcLicense.isEditionComponent) {
            debugLog(
              "[Refund Guard] DLC candidate suppressed as edition/package component",
              appId,
              {
                underlyingAppId,
                sharedPackageIds: dlcLicense.sharedPackageIds,
              },
            );
            continue;
          }

          dlcPlaytimeResolution = await resolveStandaloneDlcPlaytime(
            underlyingAppId,
            purchaseTime,
            playtimeMax,
            nowSeconds,
          );
          playtimeMinutes = dlcPlaytimeResolution.foreverMinutes;

          debugLog(
            "[Refund Guard] Standalone DLC eligibility evidence",
            appId,
            {
              underlyingAppId,
              underlyingGameName,
              dlcPackageIds: dlcLicense.dlcPackageIds,
              playtimeEligibility: dlcPlaytimeResolution.eligibility,
              evidence: dlcPlaytimeResolution.evidence,
              lastTwoWeeksMinutes: dlcPlaytimeResolution.recentMinutes,
              lifetimeMinutes: dlcPlaytimeResolution.foreverMinutes,
              lastPlayed: dlcPlaytimeResolution.lastPlayed,
            },
          );
        }

        const baseGameName =
          storeDetails.name ||
          app.display_name ||
          `App ${appId}`;

        const baseGamePrice =
          storeDetails.has_price === true
            ? Math.max(0, Number(storeDetails.final ?? 0))
            : 0;

        const baseGamePriceFormatted =
          storeDetails.has_price === true
            ? storeDetails.formatted_final ||
              fallbackPrice(baseGamePrice, storeDetails.currency ?? "")
            : "Unavailable";

        const allDlc =
          isStandaloneDlcCandidate
            ? []
            : await getAllDlcMetadata(appId);

        const purchasedTogetherDlc =
          getPurchasedTogetherDlc(allDlc, purchaseTime);

        const packageResolution =
          isStandaloneDlcCandidate
            ? {
                match: null,
                classification: "base_only" as const,
                purchasedTogetherDlc: [],
                separateDlc: [],
              }
            : await resolvePurchasedPackage(
                app,
                appId,
                purchaseTime,
                allDlc,
                storeDetails,
                storeCountryCode,
              );

        const purchaseClassification = isStandaloneDlcCandidate
          ? ("dlc" as const)
          : packageResolution.classification;
        const packageMatch = packageResolution.match;
        const packageDetails = packageMatch?.details ?? null;

        const editionComponents = packageMatch?.components ?? [];
        const components = editionComponents.map(
          (item) =>
            item.strName ||
            `DLC ${Number(item.unAppID ?? 0)}`,
        );
        const separateComponents = packageResolution.separateDlc.map(
          (item) =>
            item.strName ||
            `DLC ${Number(item.unAppID ?? 0)}`,
        );

        if (purchasedTogetherDlc.length > 0) {
          debugLog(
            "[Refund Guard] DLC acquired near base-app purchase",
            appId,
            purchasedTogetherDlc.map((item) => ({
              appId: Number(item.unAppID ?? 0),
              name: item.strName ?? "",
              purchaseTime: Number(item.rtPurchaseDate ?? 0),
              delta: Math.abs(
                Number(item.rtPurchaseDate ?? 0) -
                purchaseTime,
              ),
            })),
          );
        }

        let purchaseKind: PurchaseKind = "app";
        let packageId = 0;
        let displayName = baseGameName;
        let currentPrice = baseGamePrice;
        let currentPriceFormatted = baseGamePriceFormatted;
        let currency = normalizeCurrencyCode(storeDetails.currency);
        let discountPercent = Math.min(100, Math.max(0, Number(storeDetails.discount_percent ?? 0)));

        if (packageDetails?.ok) {
          purchaseKind = "package";
          packageId = Number(packageDetails.package_id ?? 0);
          displayName = packageDetails.name || baseGameName;
          currentPrice =
            packageDetails.has_price === true
              ? Math.max(0, Number(packageDetails.final ?? 0))
              : 0;
          currency = normalizeCurrencyCode(packageDetails.currency) || currency;
          currentPriceFormatted =
            packageDetails.has_price === true
              ? fallbackPrice(currentPrice, currency)
              : "Unavailable";
          discountPercent = Math.min(100, Math.max(0, Number(packageDetails.discount_percent ?? 0)));
        } else if (packageResolution.classification === "uncertain") {
          // Timestamps suggest a shared checkout, but the Steam license bridge
          // could not prove whether the base game and DLC use the same package.
          // Stay conservative and never substitute the base-game price.
          purchaseKind = "edition_unresolved";
          currentPrice = 0;
          currentPriceFormatted = "Edition price unresolved";
        }

        if (purchaseKind === "edition_unresolved") {
          const withinDate = ageDays <= windowDays;
          const withinPlaytime = playtimeMinutes <= playtimeMax;
          const eligibleByRules = withinDate && withinPlaytime;

          nextResults.push({
            appId,
            name: baseGameName,
            headerImage: storeDetails.header_image ?? "",
            purchaseTime,
            ageDays,
            playtimeMinutes,
            currentPrice: 0,
            currentPriceFormatted,
            currency,
            steamDiscountPercent: discountPercent,
            baselinePrice: 0,
            baselineFormatted: "",
            observedDropPercent: 0,
            observedSavings: 0,
            eligibleByRules,
            state: withinPlaytime
              ? "price_unavailable"
              : "over_playtime",
            reason: withinPlaytime
              ? "Refund Guard detected DLC acquired together with this game, but could not safely resolve the exact edition/package price. The base-game price was not used."
              : `Playtime is above your configured ${playtimeMax}-minute limit. The edition/package price is still being resolved separately.`,
            purchaseKind,
            packageId: 0,
            baseGameName,
            baseGamePriceFormatted,
            components,
            separateComponents,
            purchaseClassification,
          });

          continue;
        }

        const currentPriceUnavailable =
          currentPrice <= 0 ||
          !currency ||
          (purchaseKind === "app" && storeDetails.has_price !== true) ||
          (purchaseKind === "package" && packageDetails?.has_price !== true);

        if (currentPriceUnavailable) {
          const packageStillListed =
            purchaseKind === "package" &&
            packageId > 0 &&
            (storeDetails.package_options ?? []).some(
              (option) => Number(option.package_id ?? 0) === packageId,
            );
          const priceAvailabilityReason: PriceAvailabilityReason =
            storeDetails.is_free === true ||
            (purchaseKind === "package" && packageStillListed && currentPrice <= 0)
              ? "free_or_zero"
              : purchaseKind === "package" && packageDetails?.has_price !== true
                ? "package_not_sold"
                : "store_unavailable";
          const unavailableReason =
            priceAvailabilityReason === "free_or_zero"
              ? "Steam currently exposes this item as free or without a standard paid Store price. Refund Guard will not treat a zero/unpriced listing as an automatic refund price drop."
              : priceAvailabilityReason === "package_not_sold"
                ? "The matched Steam package/edition no longer exposes a standard current Store price. Refund Guard did not substitute the base-game price."
                : "Steam Store did not expose a standard comparable current price for this item.";

          nextResults.push({
            appId,
            name: displayName,
            headerImage: storeDetails.header_image ?? "",
            purchaseTime,
            ageDays,
            playtimeMinutes,
            currentPrice: 0,
            currentPriceFormatted: "Unavailable",
            currency,
            steamDiscountPercent: discountPercent,
            baselinePrice: 0,
            baselineFormatted: "",
            observedDropPercent: 0,
            observedSavings: 0,
            withinDate: ageDays <= windowDays,
            withinPlaytime: dlcPlaytimeResolution
              ? (dlcPlaytimeResolution.eligibility === "uncertain"
                  ? null
                  : dlcPlaytimeResolution.eligibility === "within")
              : playtimeMinutes <= playtimeMax,
            playtimeEligibility: dlcPlaytimeResolution?.eligibility ??
              (playtimeMinutes <= playtimeMax ? "within" : "outside"),
            eligibleByRules:
              ageDays <= windowDays &&
              (dlcPlaytimeResolution
                ? dlcPlaytimeResolution.eligibility === "within"
                : playtimeMinutes <= playtimeMax),
            state: "price_unavailable",
            reason: unavailableReason,
            priceAvailabilityReason,
            purchaseKind,
            packageId,
            baseGameName,
            baseGamePriceFormatted,
            components,
            separateComponents,
            purchaseClassification,
            isStandaloneDlc: isStandaloneDlcCandidate,
            underlyingAppId,
            underlyingGameName,
            underlyingPlaytimeLastTwoWeeks: dlcPlaytimeResolution?.recentMinutes,
            underlyingPlaytimeForever: dlcPlaytimeResolution?.foreverMinutes,
            underlyingLastPlayed: dlcPlaytimeResolution?.lastPlayed,
            dlcPlaytimeEvidence: dlcPlaytimeResolution?.evidence,
            dlcPlaytimeExplanation: dlcPlaytimeResolution?.explanation,
            dlcPlaytimeUpperBoundMinutes: dlcPlaytimeResolution?.upperBoundMinutes,
            dlcPlaytimeLowerBoundMinutes: dlcPlaytimeResolution?.lowerBoundMinutes,
          });

          continue;
        }

        const baselineKey = purchaseScopedBaselineKey({
          appId,
          purchaseTime,
          purchaseKind,
          packageId,
        });

        const existingBaseline = baselines[baselineKey];
        const baselineExistedBeforeScan = Boolean(
          existingBaseline &&
            Number.isFinite(Number(existingBaseline.price)) &&
            Number(existingBaseline.price) > 0 &&
            currenciesMatch(existingBaseline.currency, currency),
        );
        let baseline = existingBaseline;

        if (!baselineExistedBeforeScan) {
          baseline = {
            price: currentPrice,
            currency,
            formatted: currentPriceFormatted,
            observed_at: nowSeconds,
          };

          baselines[baselineKey] = baseline;
        }

        // Migrate display strings written by older builds (for example
        // "9.74 USD") to a symbol-aware representation such as
        // "$9.74 USD". Numeric baseline values are unchanged.
        const normalizedBaselineFormatted = fallbackPrice(
          Number(baseline.price),
          baseline.currency || currency,
        );

        if (baseline.formatted !== normalizedBaselineFormatted) {
          baseline = {
            ...baseline,
            formatted: normalizedBaselineFormatted,
          };
          baselines[baselineKey] = baseline;
        }

        const baselinePrice = Math.max(0, Number(baseline.price));

        const paidIdentity = { appId, purchaseTime, purchaseKind, packageId };
        const historicalPaidEntry = historicalPaidEntryFromCache(
          paidPriceCache,
          paidIdentity,
        );
        const cachedPaidPriceMatch = paidPriceMatchFromPersistentCache(
          paidPriceCache,
          {
            ...paidIdentity,
            currency,
          },
        );
        const cachedPaidCurrencyMismatch = Boolean(
          historicalPaidEntry &&
          normalizeCurrencyCode(historicalPaidEntry.currency) &&
          currency &&
          !currenciesMatch(historicalPaidEntry.currency, currency),
        );

        let livePaidPriceMatch: PaidPriceMatch | null = null;

        if (!cachedPaidPriceMatch && !cachedPaidCurrencyMismatch) {
          const purchaseHistory = await getPurchaseHistory();

          livePaidPriceMatch = await resolvePaidPriceFromHistory(
            purchaseHistory,
            {
              displayName,
              baseGameName,
              purchaseTime,
              currency,
            },
          );

          if (livePaidPriceMatch) {
            const cacheEntry: PaidPriceCacheEntry = {
              appId,
              purchaseTime,
              purchaseKind,
              packageId,
              price: livePaidPriceMatch.price,
              formatted: livePaidPriceMatch.formatted,
              currency: livePaidPriceMatch.currency,
              source: "steam_purchase_history",
              confidence: livePaidPriceMatch.confidence,
              resolvedAt: nowSeconds,
            };

            paidPriceCache[paidPriceCacheKey(cacheEntry)] = cacheEntry;
          }
        }

        const rawPaidPriceMatch = cachedPaidPriceMatch ?? livePaidPriceMatch;
        const livePaidCurrencyMismatch = Boolean(
          livePaidPriceMatch &&
          normalizeCurrencyCode(livePaidPriceMatch.currency) &&
          currency &&
          !currenciesMatch(livePaidPriceMatch.currency, currency),
        );
        const paidCurrencyMismatch = cachedPaidCurrencyMismatch || livePaidCurrencyMismatch;
        const paidPriceMatch = paidCurrencyMismatch ? null : rawPaidPriceMatch;
        const historicalPaidFormatted =
          rawPaidPriceMatch?.formatted || historicalPaidEntry?.formatted || "";
        const historicalPaidCurrency = normalizeCurrencyCode(
          rawPaidPriceMatch?.currency || historicalPaidEntry?.currency,
        );

        if (rawPaidPriceMatch) {
          debugLog(
            cachedPaidPriceMatch
              ? "[Refund Guard] Actual paid price reused from persistent cache"
              : "[Refund Guard] Actual paid price resolved",
            appId,
            {
              purchaseKind,
              packageId,
              paidPrice: rawPaidPriceMatch.formatted,
              confidence: rawPaidPriceMatch.confidence,
              source: rawPaidPriceMatch.source,
              comparableToCurrentCurrency: !paidCurrencyMismatch,
            },
          );
        } else if (paidCurrencyMismatch && historicalPaidEntry) {
          console.log(
            "[Refund Guard] Historical paid price retained but currency is not comparable",
            appId,
            {
              purchaseKind,
              packageId,
              historicalPaid: historicalPaidEntry.formatted,
              historicalCurrency: normalizeCurrencyCode(historicalPaidEntry.currency),
              currentCurrency: currency,
            },
          );
        } else {
          debugLog(
            "[Refund Guard] Actual paid price unresolved",
            appId,
            {
              purchaseKind,
              packageId,
              historyStatus: lastPurchaseHistoryStatus,
            },
          );
        }

        const comparisonSource: PriceComparisonSource = paidPriceMatch
          ? "actual_paid"
          : "observed_baseline";
        const comparisonPrice = paidPriceMatch?.price ?? baselinePrice;
        const comparisonPriceFormatted = paidPriceMatch?.formatted ??
          baseline.formatted ??
          fallbackPrice(baselinePrice, currency);
        const comparisonEstablished =
          Boolean(paidPriceMatch) || baselineExistedBeforeScan;
        const evaluation = evaluateOpportunity({
          referencePrice: comparisonPrice,
          currentPrice,
          minimumDropPercent: minDrop,
          ageDays,
          refundWindowDays: windowDays,
          playtimeMinutes,
          playtimeLimitMinutes: playtimeMax,
          comparisonEstablished,
          playtimeEligibility: dlcPlaytimeResolution?.eligibility,
        });

        debugLog(
          "[Refund Guard] Opportunity evaluation",
          appId,
          {
            comparisonSource,
            referencePrice: comparisonPriceFormatted,
            currentPrice: currentPriceFormatted,
            savings: moneyDifference(evaluation.savings, currency),
            dropPercent: Number(evaluation.dropPercent.toFixed(2)),
            minimumDropPercent: minDrop,
            withinDate: evaluation.withinDate,
            withinPlaytime: evaluation.withinPlaytime,
            playtimeEligibility: evaluation.playtimeEligibility,
            state: evaluation.state,
          },
        );

        const referenceText = paidPriceMatch
          ? "the amount Steam purchase history says you paid"
          : "Refund Guard's observed baseline fallback";

        let reason: string;

        if (paidCurrencyMismatch) {
          reason =
            `Steam purchase history is in ${historicalPaidCurrency || "a different currency"}, while the current Store price is in ${currency || "another currency"}. Refund Guard never converts currencies automatically; only a purchase-scoped observed baseline in the current currency may be used for price-drop comparison.`;
        } else if (!comparisonEstablished) {
          reason =
            "Refund Guard recorded the current price as the initial purchase-scoped observed baseline. A future scan can compare against it if an exact Steam purchase price is not available.";
        } else if (evaluation.meaningfulDrop) {
          const dropText = evaluation.dropPercent.toFixed(1);

          if (evaluation.state === "opportunity") {
            reason = isStandaloneDlcCandidate
              ? `Current DLC price is ${dropText}% below ${referenceText}. The purchase date and available underlying-title playtime evidence are within your configured rules. This only appears to be a possible standard DLC refund opportunity; Valve/Steam makes the final eligibility decision.`
              : `Current price is ${dropText}% below ${referenceText}. This appears to be within your configured ${windowDays}-day and ${playtimeMax}-minute standard refund rules. Valve/Steam makes the final refund eligibility decision.`;
          } else if (evaluation.state === "price_drop_playtime_uncertain") {
            reason =
              `Current DLC price is ${dropText}% below ${referenceText}, but Steam does not expose the exact underlying-title minutes played since this DLC purchase. Refund Guard will not guess playtime eligibility.`;
          } else if (evaluation.state === "price_drop_outside_playtime") {
            reason = isStandaloneDlcCandidate
              ? `Current DLC price is ${dropText}% below ${referenceText}, but available evidence proves underlying-title playtime is outside your configured ${playtimeMax}-minute rule.`
              : `Current price is ${dropText}% below ${referenceText}, but playtime is above your configured ${playtimeMax}-minute rule.`;
          } else if (evaluation.state === "price_drop_outside_window") {
            reason =
              `Current price is ${dropText}% below ${referenceText}, but the purchase is outside your configured ${windowDays}-day refund window.`;

            if (isStandaloneDlcCandidate && evaluation.playtimeEligibility === "uncertain") {
              reason += " Underlying-title playtime since the DLC purchase is also uncertain.";
            }
          } else {
            reason =
              `Current price is ${dropText}% below ${referenceText}, but the purchase is outside both your configured date and playtime rules.`;
          }
        } else {
          reason =
            `No meaningful price drop was found. Current drop is ${evaluation.dropPercent.toFixed(1)}% from ${referenceText}; your configured threshold is ${minDrop}%.`;

          if (!evaluation.withinDate) {
            reason += ` The purchase is also outside your configured ${windowDays}-day window.`;
          }

          if (evaluation.playtimeEligibility === "outside") {
            reason += isStandaloneDlcCandidate
              ? ` Available evidence also places underlying-title playtime outside your configured ${playtimeMax}-minute rule.`
              : ` Playtime is also above your configured ${playtimeMax}-minute rule.`;
          } else if (evaluation.playtimeEligibility === "uncertain") {
            reason += isStandaloneDlcCandidate
              ? " Exact underlying-title playtime since the DLC purchase is unavailable, so playtime eligibility remains uncertain."
              : " Playtime eligibility is uncertain.";
          }
        }

        if (isStandaloneDlcCandidate) {
          reason +=
            " Steam may also exclude DLC that has been consumed, modified, transferred, or marked non-refundable; Refund Guard cannot verify those conditions automatically.";
        }

        nextResults.push({
          appId,
          name: displayName,
          headerImage: storeDetails.header_image ?? "",
          purchaseTime,
          ageDays,
          playtimeMinutes,
          currentPrice,
          currentPriceFormatted,
          currency,
          steamDiscountPercent: discountPercent,
          baselinePrice,
          baselineFormatted:
            baseline.formatted ||
            fallbackPrice(baselinePrice, currency),
          observedDropPercent: evaluation.dropPercent,
          observedSavings: evaluation.savings,
          priceDropPercent: evaluation.dropPercent,
          savings: evaluation.savings,
          comparisonSource,
          comparisonPrice,
          comparisonPriceFormatted,
          comparisonEstablished,
          minimumDropPercent: minDrop,
          refundWindowDays: windowDays,
          playtimeLimitMinutes: playtimeMax,
          withinDate: evaluation.withinDate,
          withinPlaytime: evaluation.withinPlaytime,
          playtimeEligibility: evaluation.playtimeEligibility,
          meaningfulDrop: evaluation.meaningfulDrop,
          isStandaloneDlc: isStandaloneDlcCandidate,
          underlyingAppId,
          underlyingGameName,
          underlyingPlaytimeLastTwoWeeks: dlcPlaytimeResolution?.recentMinutes,
          underlyingPlaytimeForever: dlcPlaytimeResolution?.foreverMinutes,
          underlyingLastPlayed: dlcPlaytimeResolution?.lastPlayed,
          dlcPlaytimeEvidence: dlcPlaytimeResolution?.evidence,
          dlcPlaytimeExplanation: dlcPlaytimeResolution?.explanation,
          dlcPlaytimeUpperBoundMinutes: dlcPlaytimeResolution?.upperBoundMinutes,
          dlcPlaytimeLowerBoundMinutes: dlcPlaytimeResolution?.lowerBoundMinutes,
          eligibleByRules: evaluation.eligibleByRules,
          state: evaluation.state,
          reason,
          purchaseKind,
          packageId,
          baseGameName,
          baseGamePriceFormatted,
          components,
          separateComponents,
          purchaseClassification,
          paidPrice: paidPriceMatch?.price ?? 0,
          paidPriceFormatted: paidPriceMatch?.formatted ?? "",
          paidPriceSource: paidPriceMatch?.source,
          paidPriceConfidence: paidPriceMatch?.confidence,
          historicalPaidPriceFormatted: paidCurrencyMismatch ? historicalPaidFormatted : undefined,
          historicalPaidCurrency: paidCurrencyMismatch ? historicalPaidCurrency : undefined,
          priceAvailabilityReason: paidCurrencyMismatch ? "currency_mismatch" : undefined,
        });
      }

      if (storeLookupAttempts > 0 && storeLookupSuccesses === 0) {
        throw new Error(
          `Steam Store could not be refreshed for any of ${storeLookupAttempts} candidate(s). Saved results were kept unchanged.`,
        );
      }

      if (storeLookupFailures > 0) {
        console.warn("[Refund Guard] Partial Store refresh", {
          candidates: storeLookupAttempts,
          refreshed: storeLookupSuccesses,
          retainedOrUnavailable: storeLookupFailures,
        });
      }

      const hardenedResults = normalizeScanResults(nextResults, "generated");
      const supersededPaidPriceEntriesRemoved =
        pruneSupersededPaidPriceCache(paidPriceCache, hardenedResults);
      if (supersededPaidPriceEntriesRemoved > 0) {
        debugLog("[Refund Guard] Superseded paid-price cache entries removed", {
          removedEntries: supersededPaidPriceEntriesRemoved,
        });
      }

      if (hardenedResults.length !== nextResults.length) {
        console.warn("[Refund Guard] Generated scan results were hardened", {
          before: nextResults.length,
          after: hardenedResults.length,
        });
      }
      nextResults.length = 0;
      nextResults.push(...hardenedResults);


      const newlyNotified: ScanResult[] = [];
      let duplicateNotificationsSuppressed = 0;
      let notificationFingerprintsRemoved = 0;
      let notificationFailures = 0;

      try {
        if (notifyPriceDropsValue) {
          notificationFingerprintsRemoved += reconcileNotificationFingerprints(
            notificationFingerprints,
            nextResults,
            strict,
            nowSeconds,
          );

          for (const item of nextResults) {
            if (!isNotificationEligible(item, strict)) continue;

            const identity = notificationIdentityKey(item);
            const fingerprint = notificationFingerprint(item);
            const previousFingerprint =
              notificationFingerprints[identity]?.fingerprint || "";

            if (previousFingerprint === fingerprint) {
              duplicateNotificationsSuppressed += 1;
              continue;
            }

            if (showNativePriceDropNotification(item)) {
              notificationFingerprints[identity] = {
                appId: item.appId,
                packageId: item.packageId,
                purchaseTime: item.purchaseTime,
                fingerprint,
                state: item.state,
                currentPrice: item.currentPrice,
                comparisonPrice: Number(item.comparisonPrice ?? 0),
                currency: String(item.currency || "").toUpperCase(),
                notifiedAt: nowSeconds,
              };
              newlyNotified.push(item);
            } else {
              notificationFailures += 1;
            }
          }
        } else {
          // A disabled notification setting must never emit a real toast. Clear
          // old fingerprints during the next manual scan so re-enabling alerts
          // can notify once for opportunities that are still relevant.
          notificationFingerprintsRemoved +=
            clearNotificationFingerprints(notificationFingerprints);
        }

        notificationFingerprintsRemoved +=
          pruneNotificationFingerprints(notificationFingerprints, nowSeconds);
      } catch (error) {
        // Notification handling is optional UI behavior. Never invalidate a
        // successfully completed price/refund scan because toast logic failed.
        notificationFailures += 1;
        console.error(
          "[Refund Guard] Notification processing failed; scan results remain valid",
          error,
        );
      }

      if (
        newlyNotified.length > 0 ||
        duplicateNotificationsSuppressed > 0 ||
        notificationFingerprintsRemoved > 0 ||
        notificationFailures > 0
      ) {
        console.log("[Refund Guard] Notification evaluation", {
          enabled: notifyPriceDropsValue,
          sent: newlyNotified.length,
          duplicatesSuppressed: duplicateNotificationsSuppressed,
          fingerprintsRemoved: notificationFingerprintsRemoved,
          failures: notificationFailures,
        });
      }

      if (newlyNotified.length === 1) {
        const detected = newlyNotified[0];
        setAlertMessage(
          detected.state === "opportunity"
            ? `Steam notification sent for possible refund opportunity: ${detected.name}`
            : `Steam notification sent for price drop outside configured refund rules: ${detected.name}`,
        );
      } else if (newlyNotified.length > 1) {
        const opportunityCount = newlyNotified.filter(
          (item) => item.state === "opportunity",
        ).length;

        setAlertMessage(
          opportunityCount === newlyNotified.length
            ? `${newlyNotified.length} Steam notifications sent for new possible refund opportunities.`
            : `${newlyNotified.length} Steam price-drop notifications sent; ${opportunityCount} appear to be within your configured refund rules.`,
        );
      }

      const nextBaselinesJson = JSON.stringify(baselines);
      const nextPaidPriceCacheJson = JSON.stringify(paidPriceCache);
      const nextNotificationFingerprintsJson = JSON.stringify(notificationFingerprints);
      const nextResultsJson = JSON.stringify(nextResults);

      setBaselinesJson(nextBaselinesJson);
      setPaidPriceCacheJson(nextPaidPriceCacheJson);
      setNotificationFingerprintsJson(nextNotificationFingerprintsJson);
      setCachedResultsJson(nextResultsJson);
      lastScanTimeRef.current = nowSeconds;
      setVisualLastScanTime(nowSeconds);
      setResults(nextResults);
      globalAutoRetryNotBeforeMs = 0;

      let statePersisted = true;
      try {
        await persistScanState(
          nextBaselinesJson,
          nextPaidPriceCacheJson,
          nextNotificationFingerprintsJson,
          nextResultsJson,
          nowSeconds,
        );
      } catch (error) {
        statePersisted = false;
        console.warn(
          "[Refund Guard] Scan completed, but scanner state could not be persisted",
          error,
        );
      }

      const productionSummary = runtimeMatrixSummary(nextResults);
      console.log("[Refund Guard] Scan completed", {
        trigger,
        candidates: nextResults.length,
        opportunities: productionSummary.opportunity || 0,
        otherPriceDrops: productionSummary.otherPriceDrop || 0,
        monitoring: productionSummary.monitoring || 0,
        priceUnavailable: productionSummary.priceUnavailable || 0,
        notificationsSent: newlyNotified.length,
        statePersisted,
        durationMs: Math.max(0, Date.now() - scanStartedAtMs),
      });
    } catch (error) {
      console.error("[Refund Guard] Scan failed", error);

      if (trigger === "automatic") {
        globalAutoRetryNotBeforeMs =
          Date.now() + AUTO_SCAN_FAILURE_BACKOFF_MINUTES * 60 * 1000;
        console.warn("[Refund Guard] Automatic scan backoff scheduled", {
          retryAfterMinutes: AUTO_SCAN_FAILURE_BACKOFF_MINUTES,
          retryAt: new Date(globalAutoRetryNotBeforeMs).toLocaleString(),
        });
      }

      setScannerError(
        error instanceof Error
          ? error.message
          : "Refund Guard scan failed for an unknown reason.",
      );
    } finally {
      scanInProgress.current = false;
      globalScanRunning = false;
      setIsScanning(false);
    }
  }, [
    baselinesJson,
    paidPriceCacheJson,
    notificationFingerprintsJson,
    cachedResultsJson,
    configReady,
    runtimeCompatible,
    runtimeCompatibilityMessage,
    storageCompatible,
  ]);

  useEffect(() => {
    globalAutomaticScanRunner = () => runScan("automatic");
    globalAutomaticReschedule = () => {
      setAutoSchedulerRevision((revision) => revision + 1);
    };
    globalAutoScanEnabled = Boolean(
      configReady && runtimeCompatible && storageCompatible && config.enabled && config.auto_scan_enabled,
    );

    if (!globalAutoScanEnabled) {
      globalAutoScheduleAnchorMs = 0;
      setNextAutoScanAt(0);
      clearGlobalAutoScanTimer();
      return undefined;
    }

    const intervalMinutes = normalizedAutoScanInterval(
      config.scan_interval_minutes,
    );
    const intervalMs = intervalMinutes * 60 * 1000;
    const nowMs = Date.now();

    if (globalAutoScheduleAnchorMs <= 0) {
      globalAutoScheduleAnchorMs = nowMs;
    }

    const lastCompletedMs = lastScanTimeRef.current > 0
      ? lastScanTimeRef.current * 1000
      : globalAutoScheduleAnchorMs;
    const normalDueAtMs = lastCompletedMs + intervalMs;
    const dueAtMs = Math.max(normalDueAtMs, globalAutoRetryNotBeforeMs);
    const delayMs = Math.max(1000, dueAtMs - nowMs);
    const scheduledAtMs = nowMs + delayMs;
    const scheduledAtSeconds = Math.floor(scheduledAtMs / 1000);
    const logicalDueAtSeconds = Math.floor(dueAtMs / 1000);
    const scheduleKey = `${intervalMinutes}:${logicalDueAtSeconds}:${lastScanTimeRef.current}`;

    setNextAutoScanAt(scheduledAtSeconds);

    if (globalAutoScanTimer !== null && globalAutoScheduleKey === scheduleKey) {
      return undefined;
    }

    clearGlobalAutoScanTimer();
    globalAutoScheduleKey = scheduleKey;

    void registerAutoScheduleOnce(scheduleKey).then((first) => {
      if (!first) {
        return;
      }

      console.log("[Refund Guard] Automatic scan scheduled", {
        intervalMinutes,
        dueAt: new Date(scheduledAtMs).toLocaleString(),
        lastScanTime: lastScanTimeRef.current,
      });
    });

    globalAutoScanTimer = window.setTimeout(() => {
      globalAutoScanTimer = null;
      globalAutoScheduleKey = "";

      if (!globalAutoScanEnabled) {
        globalAutomaticReschedule?.();
        return;
      }

      void (async () => {
        const claimed = await claimAutomaticScanDue(scheduleKey);
        if (!claimed) {
          return;
        }

        console.log("[Refund Guard] Automatic scan due", {
          intervalMinutes,
        });

        const runner = globalAutomaticScanRunner;
        if (!runner) {
          console.warn("[Refund Guard] Automatic scan runner unavailable; rescheduling");
          globalAutomaticReschedule?.();
          return;
        }

        await runner();
        globalAutomaticReschedule?.();
      })();
    }, delayMs);

    return undefined;
  }, [
    autoSchedulerRevision,
    config.auto_scan_enabled,
    config.enabled,
    config.scan_interval_minutes,
    configReady,
    runtimeCompatible,
    storageCompatible,
    runScan,
    visualLastScanTime,
  ]);

  const summary = useMemo(() => scannerSummary(results), [results]);

  const lastScanLabel =
    visualLastScanTime > 0
      ? new Date(visualLastScanTime * 1000).toLocaleString()
      : "Never";

  return (
    <div style={{ padding: "4px 0 12px" }}>
      <div
        style={{
          display: "flex",
          gap: "6px",
          marginBottom: "11px",
        }}
      >
        <TabButton
          active={activeTab === "status"}
          onClick={() => setActiveTab("status")}
        >
          STATUS
        </TabButton>

        <TabButton
          active={activeTab === "config"}
          onClick={() => setActiveTab("config")}
        >
          CONFIG
        </TabButton>
      </div>

      {activeTab === "config" ? (
        <ConfigPage config={config} onChange={updateUserSetting} />
      ) : (
        <div>
          <div
            style={{
              padding: "11px",
              borderRadius: "9px",
              background: "rgba(26,159,255,0.075)",
              border: "1px solid rgba(26,159,255,0.20)",
              marginBottom: "9px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "10px",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    marginBottom: "4px",
                  }}
                >
                  <div
                    style={{
                      width: "7px",
                      height: "7px",
                      borderRadius: "50%",
                      background: enabled === false ? "rgba(255,255,255,0.35)" : "rgba(82,190,89,0.92)",
                      flex: "0 0 auto",
                    }}
                  />
                  <div style={{ fontSize: "13px", fontWeight: 740 }}>
                    {enabled ?? true ? "Refund Guard active" : "Refund Guard paused"}
                  </div>
                </div>
                <div style={{ opacity: 0.56, fontSize: "10.5px" }}>
                  Last scan: {lastScanLabel}
                </div>
                <div style={{ opacity: 0.4, fontSize: "9.5px", marginTop: "2px", lineHeight: 1.35 }}>
                  {config.auto_scan_enabled
                    ? `Automatic every ${formatAutoScanInterval(config.scan_interval_minutes)}`
                    : "Manual mode - saved results stay visible"}
                  {config.auto_scan_enabled && nextAutoScanAt > 0 ? (
                    <>
                      <br />
                      Next auto scan: {new Date(nextAutoScanAt * 1000).toLocaleString()}
                    </>
                  ) : null}
                  {millenniumRuntimeVersion ? (
                    <>
                      <br />
                      Millennium {millenniumRuntimeVersion}
                    </>
                  ) : null}
                </div>
              </div>

              <PrimaryButton
                disabled={isScanning || enabled === false || !runtimeCompatible || !storageCompatible}
                onClick={() => void runScan("manual")}
              >
                {isScanning ? "SCANNING..." : "SCAN NOW"}
              </PrimaryButton>
            </div>
          </div>

          {alertMessage ? (
            <div
              style={{
                marginBottom: "12px",
                padding: "11px 12px",
                borderRadius: "7px",
                background: "rgba(82, 190, 89, 0.12)",
                border: "1px solid rgba(82, 190, 89, 0.30)",
                fontSize: "13px",
                fontWeight: 650,
              }}
            >
              {alertMessage}
            </div>
          ) : null}

          {scannerError ? (
            <div
              style={{
                marginBottom: "12px",
                padding: "11px 12px",
                borderRadius: "7px",
                background: "rgba(224, 72, 72, 0.12)",
                border: "1px solid rgba(224, 72, 72, 0.30)",
                fontSize: "12px",
                lineHeight: 1.45,
              }}
            >
              <div style={{ fontWeight: 720, marginBottom: results.length > 0 ? "3px" : 0 }}>
                Scan couldn't complete
              </div>
              <div>{scannerError}</div>
              {results.length > 0 ? (
                <div style={{ opacity: 0.62, marginTop: "4px" }}>
                  Saved results below were kept unchanged.
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: "5px",
              marginBottom: "9px",
            }}
          >
            <Metric label="Candidates" value={summary.total} />
            <Metric label="Opportunities" value={summary.opportunities} />
            <Metric label="Other drops" value={summary.otherPriceDrops} />
            <Metric label="Monitoring" value={summary.monitoring} />
          </div>

          {summary.unresolved > 0 ? (
            <div
              style={{
                marginBottom: "12px",
                padding: "9px 10px",
                borderRadius: "7px",
                background: "rgba(245,184,73,0.08)",
                border: "1px solid rgba(245,184,73,0.18)",
                fontSize: "11px",
                lineHeight: 1.45,
              }}
            >
              {summary.unresolved} edition/package purchase could not be matched
              safely. Base-game pricing was not used for those entries.
            </div>
          ) : null}

          {results.length === 0 && !isScanning ? (
            <div
              style={{
                padding: "18px 14px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.035)",
                border: "1px solid rgba(255,255,255,0.07)",
                textAlign: "center",
              }}
            >
              <div style={{ fontWeight: 720, marginBottom: "5px" }}>
                No candidates in the current watch window
              </div>
              <div style={{ opacity: 0.5, fontSize: "10.5px", lineHeight: 1.45 }}>
                {!runtimeCompatible
                  ? runtimeCompatibilityMessage || "Refund Guard runtime compatibility check failed. Fully restart Steam after updating."
                  : !storageCompatible
                  ? "Saved data was created by a newer Refund Guard state schema. Install a matching/newer version before scanning."
                  : !config.enabled
                    ? "Refund Guard is paused. Enable it in Config to scan again."
                    : config.auto_scan_enabled
                      ? `Automatic mode is enabled (${formatAutoScanInterval(config.scan_interval_minutes)}). Refund Guard will scan when the next interval is due.`
                      : "Press SCAN NOW after a recent Steam purchase, or enable Automatic scanning in Config."}
              </div>
            </div>
          ) : (
            results.map((item) => (
              <ResultCard
                key={`${item.appId}:${item.packageId}:${item.purchaseKind}`}
                item={item}
              />
            ))
          )}

        </div>
      )}
    </div>
  );
}

function runReleaseSelfCheck(): void {
  const failures: string[] = [];

  if (CURRENT_STATE_SCHEMA_VERSION !== 1) failures.push("unexpected state schema version");
  if (!AUTO_SCAN_INTERVAL_OPTIONS.includes(DEFAULT_USER_CONFIG.scan_interval_minutes as (typeof AUTO_SCAN_INTERVAL_OPTIONS)[number])) failures.push("default automatic scan interval is unsupported");
  if (MAX_PERSISTED_RESULTS <= 0 || MAX_PRICE_BASELINES <= 0 || MAX_PAID_PRICE_CACHE_ENTRIES <= 0) failures.push("persisted-state bounds are invalid");
  if (LIBRARY_READY_ATTEMPTS < 2 || LIBRARY_READY_RETRY_MS < 100) failures.push("library-readiness retry policy is invalid");
  if (AUTO_SCAN_FAILURE_BACKOFF_MINUTES < 1) failures.push("automatic scan failure backoff is invalid");

  const opportunityCases: Array<{ name: string; expected: ScanState; input: Parameters<typeof evaluateOpportunity>[0] }> = [
    { name: "within rules", expected: "opportunity", input: { referencePrice: 10000, currentPrice: 8000, minimumDropPercent: 10, ageDays: 2, refundWindowDays: 14, playtimeMinutes: 60, playtimeLimitMinutes: 120, comparisonEstablished: true } },
    { name: "outside playtime", expected: "price_drop_outside_playtime", input: { referencePrice: 10000, currentPrice: 8000, minimumDropPercent: 10, ageDays: 2, refundWindowDays: 14, playtimeMinutes: 180, playtimeLimitMinutes: 120, comparisonEstablished: true } },
    { name: "below threshold", expected: "monitoring", input: { referencePrice: 10000, currentPrice: 9500, minimumDropPercent: 10, ageDays: 2, refundWindowDays: 14, playtimeMinutes: 60, playtimeLimitMinutes: 120, comparisonEstablished: true } },
    { name: "unchanged price", expected: "monitoring", input: { referencePrice: 974, currentPrice: 974, minimumDropPercent: 10, ageDays: 2, refundWindowDays: 14, playtimeMinutes: 60, playtimeLimitMinutes: 120, comparisonEstablished: true } },
  ];
  for (const testCase of opportunityCases) {
    if (evaluateOpportunity(testCase.input).state !== testCase.expected) failures.push(`opportunity matrix failed: ${testCase.name}`);
  }

  const fixture = (overrides: Partial<ScanResult> = {}): ScanResult => ({
    appId: 100, name: "Release Fixture", headerImage: "", purchaseTime: 1000, ageDays: 2, playtimeMinutes: 60,
    currentPrice: 8000, currentPriceFormatted: "$80.00 USD", currency: "USD", steamDiscountPercent: 0,
    baselinePrice: 10000, baselineFormatted: "$100.00 USD", observedDropPercent: 20, observedSavings: 2000,
    priceDropPercent: 20, savings: 2000, comparisonSource: "actual_paid", comparisonPrice: 10000,
    comparisonPriceFormatted: "$100.00 USD", comparisonEstablished: true, minimumDropPercent: 10, refundWindowDays: 14,
    playtimeLimitMinutes: 120, withinDate: true, withinPlaytime: true, playtimeEligibility: "within", meaningfulDrop: true,
    eligibleByRules: true, state: "opportunity", reason: "Release fixture", purchaseKind: "app", packageId: 0,
    baseGameName: "Release Fixture", baseGamePriceFormatted: "$80.00 USD", components: [], purchaseClassification: "base_only",
    paidPrice: 10000, paidPriceFormatted: "$100.00 USD", paidPriceSource: "steam_purchase_history", paidPriceConfidence: "exact_single_item",
    ...overrides,
  });

  const invariantCases: Array<{ name: string; item: ScanResult; shouldPass: boolean }> = [
    { name: "base game", item: fixture(), shouldPass: true },
    { name: "edition package", item: fixture({ purchaseKind: "package", packageId: 500, purchaseClassification: "edition", components: ["DLC A"] }), shouldPass: true },
    { name: "standalone dlc", item: fixture({ isStandaloneDlc: true, underlyingAppId: 200, underlyingGameName: "Underlying Fixture", purchaseClassification: "dlc" }), shouldPass: true },
    { name: "invalid edition", item: fixture({ purchaseClassification: "edition", components: ["DLC A"] }), shouldPass: false },
    { name: "false opportunity", item: fixture({ meaningfulDrop: false }), shouldPass: false },
  ];
  for (const testCase of invariantCases) {
    const passed = scanResultInvariantFailures(testCase.item).length === 0;
    if (passed !== testCase.shouldPass) failures.push(`classification invariant matrix failed: ${testCase.name}`);
  }

  if (isNotificationEligible(fixture({ dataFreshness: "saved" }), false)) {
    failures.push("saved refresh data must never emit a notification");
  }

  if (failures.length > 0) {
    console.error("[Refund Guard] Release self-check failed", failures);
    return;
  }

  console.log("[Refund Guard] Release self-check passed", {
    stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    automaticIntervals: AUTO_SCAN_INTERVAL_OPTIONS.length,
    opportunityScenarios: opportunityCases.length,
    classificationScenarios: invariantCases.length,
    tests: opportunityCases.length + invariantCases.length + 1,
    diagnostics: DEBUG_DIAGNOSTICS ? "on" : "off",
  });
}

export default definePlugin(() => {
  console.log(`[Refund Guard] Frontend ${PLUGIN_VERSION} initialized`);
  runReleaseSelfCheck();

  return {
    title: "Refund Guard",
    version: PLUGIN_VERSION,
    icon: <RefundGuardIcon />,
    content: <RefundGuardPanel />,
    alwaysRender: true,
  };
});