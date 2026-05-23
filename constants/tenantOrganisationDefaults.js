const { defaultAddress } = require("./tenantOfficeDefaults");

const ORGANISATION_PROFILE_FIELDS = [
  "legalName",
  "tradingName",
  "registrationNumber",
  "charityNumber",
  "vatNumber",
  "website",
  "email",
  "contactNumber",
  "bankName",
  "bankAddress",
  "iban",
  "bic",
  "sepaOriginatorIdentificationNumber",
];

const trimString = (value) =>
  typeof value === "string" ? value.trim() : value ?? "";

const normalizeBankAddress = (address = {}) => ({
  ...defaultAddress(),
  buildingOrHouse: trimString(address.buildingOrHouse),
  streetOrRoad: trimString(address.streetOrRoad),
  areaOrTown: trimString(address.areaOrTown),
  countyCityOrPostCode: trimString(address.countyCityOrPostCode),
  eircode: trimString(address.eircode),
  country: trimString(address.country) || "Ireland",
});

const normalizeOrganisationProfile = (profile = {}) => ({
  legalName: trimString(profile.legalName),
  tradingName: trimString(profile.tradingName),
  registrationNumber: trimString(profile.registrationNumber),
  charityNumber: trimString(profile.charityNumber),
  vatNumber: trimString(profile.vatNumber),
  website: trimString(profile.website).toLowerCase(),
  email: trimString(profile.email ?? profile.supportEmail).toLowerCase(),
  contactNumber: trimString(profile.contactNumber),
  bankName: trimString(profile.bankName),
  bankAddress: normalizeBankAddress(profile.bankAddress),
  iban: trimString(profile.iban).replace(/\s+/g, "").toUpperCase(),
  bic: trimString(profile.bic).replace(/\s+/g, "").toUpperCase(),
  sepaOriginatorIdentificationNumber: trimString(
    profile.sepaOriginatorIdentificationNumber
  ),
});

const pickOrganisationProfilePayload = (body = {}) => {
  const picked = {};
  for (const key of ORGANISATION_PROFILE_FIELDS) {
    if (body[key] !== undefined) {
      picked[key] = body[key];
    }
  }
  if (body.supportEmail !== undefined && picked.email === undefined) {
    picked.email = body.supportEmail;
  }
  return picked;
};

const mergeOrganisationProfile = (existing = {}, patch = {}) => {
  const merged = {
    ...(existing?.toObject?.() ?? existing),
    ...patch,
  };

  if (patch.bankAddress !== undefined) {
    merged.bankAddress = {
      ...(existing?.bankAddress?.toObject?.() ?? existing?.bankAddress ?? {}),
      ...patch.bankAddress,
    };
  }

  return merged;
};

module.exports = {
  ORGANISATION_PROFILE_FIELDS,
  normalizeBankAddress,
  normalizeOrganisationProfile,
  pickOrganisationProfilePayload,
  mergeOrganisationProfile,
};
