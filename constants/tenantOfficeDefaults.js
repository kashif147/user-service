const WEEKDAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

const DEFAULT_DAY_HOURS = {
  MONDAY: { openTime: "09:00", closeTime: "17:00", isClosed: false },
  TUESDAY: { openTime: "09:00", closeTime: "17:00", isClosed: false },
  WEDNESDAY: { openTime: "09:00", closeTime: "17:00", isClosed: false },
  THURSDAY: { openTime: "09:00", closeTime: "17:00", isClosed: false },
  FRIDAY: { openTime: "08:30", closeTime: "16:30", isClosed: false },
  SATURDAY: { openTime: "", closeTime: "", isClosed: true },
  SUNDAY: { openTime: "", closeTime: "", isClosed: true },
};

const defaultAddress = () => ({
  buildingOrHouse: "",
  streetOrRoad: "",
  areaOrTown: "",
  countyCityOrPostCode: "",
  eircode: "",
  country: "Ireland",
});

const buildDefaultOpeningHours = () =>
  WEEKDAYS.map((day) => ({
    day,
    openTime: DEFAULT_DAY_HOURS[day].openTime,
    closeTime: DEFAULT_DAY_HOURS[day].closeTime,
    isClosed: DEFAULT_DAY_HOURS[day].isClosed,
  }));

const normalizeOpeningHours = (openingHours) => {
  if (!Array.isArray(openingHours) || openingHours.length === 0) {
    return buildDefaultOpeningHours();
  }

  const byDay = Object.fromEntries(
    openingHours
      .filter((row) => row?.day && WEEKDAYS.includes(row.day))
      .map((row) => [row.day, row])
  );

  return WEEKDAYS.map((day) => {
    const row = byDay[day];
    if (!row) {
      return {
        day,
        ...DEFAULT_DAY_HOURS[day],
      };
    }
    return {
      day,
      openTime: row.openTime ?? DEFAULT_DAY_HOURS[day].openTime,
      closeTime: row.closeTime ?? DEFAULT_DAY_HOURS[day].closeTime,
      isClosed: Boolean(row.isClosed),
    };
  });
};

const NON_WORKING_DAY_CATEGORIES = [
  "BANK_HOLIDAY",
  "CHRISTMAS",
  "EASTER",
  "PUBLIC_HOLIDAY",
  "OTHER",
];

const startOfDay = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

const normalizeNonWorkingDays = (items) => {
  if (!Array.isArray(items)) return [];

  return items
    .map((row) => {
      const startDate = startOfDay(row.startDate);
      if (!startDate || !row.name?.trim()) return null;

      let endDate = startOfDay(row.endDate) || startDate;
      if (endDate < startDate) endDate = startDate;

      const category = NON_WORKING_DAY_CATEGORIES.includes(row.category)
        ? row.category
        : "PUBLIC_HOLIDAY";

      return {
        name: row.name.trim(),
        category,
        startDate,
        endDate,
        notes: row.notes?.trim() || "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startDate - b.startDate);
};

module.exports = {
  WEEKDAYS,
  DEFAULT_DAY_HOURS,
  NON_WORKING_DAY_CATEGORIES,
  defaultAddress,
  buildDefaultOpeningHours,
  normalizeOpeningHours,
  normalizeNonWorkingDays,
};
