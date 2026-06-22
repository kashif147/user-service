const REGIONAL_SETTINGS_FIELDS = [
  "timezone",
  "locale",
  "currency",
  "dateFormat",
];

const SETTINGS_FIELDS = [
  "maxUsers",
  "allowSelfRegistration",
  "sessionTimeout",
  "passwordPolicy",
  "lifecycleBatches",
];

const SUBSCRIPTION_FIELDS = ["plan", "startDate", "endDate", "autoRenew"];

const VALID_SUBSCRIPTION_PLANS = ["FREE", "BASIC", "PREMIUM", "ENTERPRISE"];

const trimString = (value) =>
  typeof value === "string" ? value.trim() : value ?? "";

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toBool = (value, fallback) =>
  typeof value === "boolean" ? value : fallback;

const DEFAULT_LIFECYCLE_BATCHES = {
  reminder: {
    generateMode: "manual",
    executeMode: "manual",
  },
  cancellation: {
    generateMode: "manual",
    executeMode: "manual",
  },
  schedule: {
    dayMode: "FIRST_WORKING_DAY",
  },
  notificationRecipientRoleCodes: ["MO"],
};

const normalizeMode = (value, fallback = "manual") => {
  const normalized = String(value || "").trim().toLowerCase();
  return ["manual", "automatic"].includes(normalized) ? normalized : fallback;
};

const normalizeDayMode = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  return ["FIRST_DAY", "FIRST_WORKING_DAY"].includes(normalized)
    ? normalized
    : "FIRST_WORKING_DAY";
};

const normalizeLifecycleBatches = (lifecycle = {}) => {
  const current = lifecycle || {};
  const recipientCodes = Array.isArray(current.notificationRecipientRoleCodes)
    ? current.notificationRecipientRoleCodes
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    : [];

  return {
    reminder: {
      generateMode: normalizeMode(
        current.reminder?.generateMode,
        DEFAULT_LIFECYCLE_BATCHES.reminder.generateMode
      ),
      executeMode: normalizeMode(
        current.reminder?.executeMode,
        DEFAULT_LIFECYCLE_BATCHES.reminder.executeMode
      ),
    },
    cancellation: {
      generateMode: normalizeMode(
        current.cancellation?.generateMode,
        DEFAULT_LIFECYCLE_BATCHES.cancellation.generateMode
      ),
      executeMode: normalizeMode(
        current.cancellation?.executeMode,
        DEFAULT_LIFECYCLE_BATCHES.cancellation.executeMode
      ),
    },
    schedule: {
      dayMode: normalizeDayMode(current.schedule?.dayMode),
    },
    notificationRecipientRoleCodes: recipientCodes.length
      ? recipientCodes
      : [...DEFAULT_LIFECYCLE_BATCHES.notificationRecipientRoleCodes],
  };
};

const pickFields = (body, allowedFields) => {
  const picked = {};
  for (const key of allowedFields) {
    if (body[key] !== undefined) {
      picked[key] = body[key];
    }
  }
  return picked;
};

const mergeRegionalSettings = (existing = {}, patch = {}) => ({
  ...(existing?.toObject?.() ?? existing),
  ...patch,
});

const normalizeRegionalSettings = (regional = {}) => ({
  timezone: trimString(regional.timezone) || "Europe/Dublin",
  locale: trimString(regional.locale) || "en-IE",
  currency: trimString(regional.currency) || "EUR",
  dateFormat: trimString(regional.dateFormat) || "DD/MM/YYYY",
});

const mergeSettings = (existing = {}, patch = {}) => {
  const base = existing?.toObject?.() ?? existing ?? {};
  const merged = { ...base, ...patch };

  if (patch.passwordPolicy !== undefined) {
    merged.passwordPolicy = {
      ...(base.passwordPolicy?.toObject?.() ?? base.passwordPolicy ?? {}),
      ...patch.passwordPolicy,
    };
  }

  if (patch.lifecycleBatches !== undefined) {
    merged.lifecycleBatches = {
      ...(base.lifecycleBatches?.toObject?.() ?? base.lifecycleBatches ?? {}),
      ...patch.lifecycleBatches,
      reminder: {
        ...(base.lifecycleBatches?.reminder?.toObject?.() ??
          base.lifecycleBatches?.reminder ??
          {}),
        ...(patch.lifecycleBatches?.reminder ?? {}),
      },
      cancellation: {
        ...(base.lifecycleBatches?.cancellation?.toObject?.() ??
          base.lifecycleBatches?.cancellation ??
          {}),
        ...(patch.lifecycleBatches?.cancellation ?? {}),
      },
      schedule: {
        ...(base.lifecycleBatches?.schedule?.toObject?.() ??
          base.lifecycleBatches?.schedule ??
          {}),
        ...(patch.lifecycleBatches?.schedule ?? {}),
      },
    };
  }

  return merged;
};

const normalizeSettings = (settings = {}) => {
  const policy = settings.passwordPolicy ?? {};
  return {
    maxUsers: toNumber(settings.maxUsers, 100),
    allowSelfRegistration: toBool(settings.allowSelfRegistration, true),
    sessionTimeout: toNumber(settings.sessionTimeout, 24),
    passwordPolicy: {
      minLength: toNumber(policy.minLength, 8),
      requireUppercase: toBool(policy.requireUppercase, true),
      requireLowercase: toBool(policy.requireLowercase, true),
      requireNumbers: toBool(policy.requireNumbers, true),
      requireSpecialChars: toBool(policy.requireSpecialChars, true),
    },
    lifecycleBatches: normalizeLifecycleBatches(settings.lifecycleBatches),
  };
};

const mergeSubscription = (existing = {}, patch = {}) => ({
  ...(existing?.toObject?.() ?? existing),
  ...patch,
});

const normalizeSubscription = (subscription = {}) => {
  const plan = trimString(subscription.plan).toUpperCase();
  return {
    plan: VALID_SUBSCRIPTION_PLANS.includes(plan) ? plan : "FREE",
    startDate: subscription.startDate || null,
    endDate: subscription.endDate || null,
    autoRenew: toBool(subscription.autoRenew, true),
  };
};

const pickRegionalSettingsPayload = (body = {}) =>
  pickFields(body, REGIONAL_SETTINGS_FIELDS);

module.exports = {
  REGIONAL_SETTINGS_FIELDS,
  SETTINGS_FIELDS,
  SUBSCRIPTION_FIELDS,
  VALID_SUBSCRIPTION_PLANS,
  DEFAULT_LIFECYCLE_BATCHES,
  mergeRegionalSettings,
  normalizeRegionalSettings,
  mergeSettings,
  normalizeSettings,
  normalizeLifecycleBatches,
  mergeSubscription,
  normalizeSubscription,
  pickRegionalSettingsPayload,
};
