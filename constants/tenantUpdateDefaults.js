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
  mergeRegionalSettings,
  normalizeRegionalSettings,
  mergeSettings,
  normalizeSettings,
  mergeSubscription,
  normalizeSubscription,
  pickRegionalSettingsPayload,
};
