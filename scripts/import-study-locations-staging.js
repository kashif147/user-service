#!/usr/bin/env node

require("dotenv").config({ path: ".env.staging" });

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Lookup = require("../models/lookup.model");
const LookupType = require("../models/lookupType.model");

const STUDY_LOCATION_TYPE = "Study Location";
const BRANCH_TYPE = "Branch";

const normalize = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const stripBranchSuffix = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+branch$/i, "")
    .trim();

const toCodePart = (value) =>
  String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

const buildAddress = (rawAddress, countyCityOrPostCode) => {
  const address = String(rawAddress || "").trim();
  const area = String(countyCityOrPostCode || "").trim();
  if (!address) return null;
  return {
    eircode: "",
    buildingOrHouse: address,
    streetOrRoad: "",
    areaOrTown: "",
    countyCityOrPostCode: area,
    country: "Ireland",
    fullAddress: [address, area, "Ireland"].filter(Boolean).join(", "),
  };
};

const readRows = (filePath) => {
  const resolved = path.resolve(filePath);
  const rows = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(rows)) {
    throw new Error(`Import file must contain a JSON array: ${resolved}`);
  }
  return rows;
};

const findLookupType = async (lookuptype) => {
  const lookupType = await LookupType.findOne({
    lookuptype: { $regex: `^${lookuptype}$`, $options: "i" },
    isdeleted: { $ne: true },
  }).lean();
  if (!lookupType) {
    throw new Error(`Lookup type not found: ${lookuptype}`);
  }
  return lookupType;
};

const buildBranchMap = async (branchTypeId) => {
  const branches = await Lookup.find({
    lookuptypeId: branchTypeId,
    isdeleted: { $ne: true },
  }).lean();

  const byName = new Map();
  for (const branch of branches) {
    const names = [
      branch.lookupname,
      branch.DisplayName,
      stripBranchSuffix(branch.lookupname),
      stripBranchSuffix(branch.DisplayName),
    ];
    for (const name of names) {
      const key = normalize(name);
      if (key && !byName.has(key)) byName.set(key, branch);
    }
  }
  return byName;
};

const resolveBranch = (branchName, branchMap) => {
  const exact = branchMap.get(normalize(branchName));
  if (exact) return exact;
  return branchMap.get(normalize(stripBranchSuffix(branchName))) || null;
};

const generateCode = async (row, index, studyLocationTypeId) => {
  const base =
    `SL${toCodePart(row.accountName)}`.slice(0, 8) ||
    `SL${String(index + 1).padStart(4, "0")}`;

  for (let counter = 0; counter < 100; counter += 1) {
    const suffix = counter === 0 ? "" : String(counter).padStart(2, "0");
    const code = `${base}${suffix}`.slice(0, 10);
    const existing = await Lookup.findOne({ code }).lean();
    if (!existing) return code;
  }
  throw new Error(`Could not generate unique code for ${row.accountName}`);
};

const main = async () => {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const dataArg = process.argv.find((arg) => arg.startsWith("--data="));
  const dataFile = dataArg ? dataArg.slice("--data=".length) : null;

  if (!dataFile) {
    throw new Error("Usage: node scripts/import-study-locations-staging.js --data=/path/to/study-locations.json [--dry-run]");
  }
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is missing. Ensure .env.staging is present.");
  }

  const rows = readRows(dataFile).filter((row) => row.accountName);
  await mongoose.connect(process.env.MONGO_URI);

  const studyLocationType = await findLookupType(STUDY_LOCATION_TYPE);
  const branchType = await findLookupType(BRANCH_TYPE);
  const branchMap = await buildBranchMap(branchType._id);

  const summary = {
    sourceRows: rows.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    unmatchedBranches: [],
  };

  for (const [index, row] of rows.entries()) {
    const branch = resolveBranch(row.branch, branchMap);
    if (!branch) {
      summary.unmatchedBranches.push({
        row: index + 2,
        accountName: row.accountName,
        branch: row.branch,
      });
      continue;
    }

    const existing = await Lookup.findOne({
      lookuptypeId: studyLocationType._id,
      lookupname: row.accountName,
      isdeleted: { $ne: true },
    });

    const nextValues = {
      lookupname: row.accountName,
      DisplayName: row.accountName,
      Parentlookupid: branch._id,
      lookuptypeId: studyLocationType._id,
      userid: studyLocationType.userid,
      isactive: true,
      isdeleted: false,
      officer: null,
      worklocationAddress: buildAddress(
        row.workplaceAddress || row.accountName,
        row.branch
      ),
      processSalaryDeduction: false,
    };

    if (existing) {
      const changed =
        existing.DisplayName !== nextValues.DisplayName ||
        String(existing.Parentlookupid || "") !== String(nextValues.Parentlookupid) ||
        JSON.stringify(existing.worklocationAddress || null) !==
          JSON.stringify(nextValues.worklocationAddress || null) ||
        !!existing.processSalaryDeduction !== false;

      if (changed) {
        summary.updated += 1;
        if (!dryRun) {
          Object.assign(existing, nextValues);
          existing.processSalaryDeduction = false;
          await existing.save();
        }
      } else {
        summary.unchanged += 1;
      }
      continue;
    }

    summary.inserted += 1;
    if (!dryRun) {
      const code = await generateCode(row, index, studyLocationType._id);
      await Lookup.create({
        ...nextValues,
        code,
      });
    }
  }

  console.log(JSON.stringify({ dryRun, ...summary }, null, 2));

  if (summary.unmatchedBranches.length > 0) {
    process.exitCode = 2;
  }

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error.message);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  process.exit(1);
});
