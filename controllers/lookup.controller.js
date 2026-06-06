const Lookup = require("../models/lookup.model");
const LookupType = require("../models/lookupType.model");
const { AppError } = require("../errors/AppError");
const lookupCacheService = require("../services/lookupCacheService");
const mongoose = require("mongoose");
const {
  isSimpleFormat,
  buildSimpleLookupTypeMeta,
  buildSimpleLookupsList,
  buildSimpleLookupRecord,
} = require("../helpers/lookupResponseFormat");

const LOOKUP_TYPE_SELECT = "code lookuptype displayname ParentlookuptypeId";
const LOOKUP_TYPE_POPULATE = {
  path: "ParentlookuptypeId",
  select: "code lookuptype displayname",
};

const LOOKUP_QUERY_POPULATE = [
  {
    path: "lookuptypeId",
    select: LOOKUP_TYPE_SELECT,
    populate: LOOKUP_TYPE_POPULATE,
  },
  {
    path: "Parentlookupid",
    select: "code lookupname DisplayName lookuptypeId",
    populate: {
      path: "lookuptypeId",
      select: "code lookuptype displayname",
    },
  },
  {
    path: "officer",
    select: "userEmail userFirstName userLastName userFullName",
  },
];

const formatLookupType = (lookupType) => {
  if (!lookupType) return null;
  const doc =
    typeof lookupType.toObject === "function"
      ? lookupType.toObject()
      : lookupType;
  const parentType = doc.ParentlookuptypeId;

  return {
    _id: doc._id ?? null,
    code: doc.code ?? null,
    lookuptype: doc.lookuptype ?? null,
    displayname: doc.displayname ?? null,
    ParentlookuptypeId: parentType?._id ?? parentType ?? null,
    Parentlookuptype: parentType?.lookuptype ?? null,
  };
};

const formatLookup = (lookup) => {
  if (!lookup) return null;
  const doc =
    typeof lookup.toObject === "function" ? lookup.toObject() : lookup;
  const lookupType = doc.lookuptypeId;
  const parentLookupType = lookupType?.ParentlookuptypeId;
  const parentLookup = doc.Parentlookupid;

  return {
    _id: doc._id,
    code: doc.code,
    lookupname: doc.lookupname,
    DisplayName: doc.DisplayName,
    Parentlookupid: parentLookup?._id ?? parentLookup ?? null,
    Parentlookup: parentLookup?.lookupname ?? null,
    ParentlookuptypeId: parentLookupType?._id ?? parentLookupType ?? null,
    Parentlookuptype: parentLookupType?.lookuptype ?? null,
    lookuptypeId: formatLookupType(lookupType),
    lookuptypeName: lookupType?.lookuptype ?? null,
    officer: doc.officer || null,
    worklocationAddress: doc.worklocationAddress || null,
    processSalaryDeduction: !!doc.processSalaryDeduction,
    userid: doc.userid ?? null,
    isactive: doc.isactive,
    isdeleted: doc.isdeleted,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
};

const validateParentLookup = async (lookuptypeId, parentLookupId) => {
  if (!lookuptypeId) {
    throw AppError.badRequest("Lookup type is required");
  }

  const lookupType = await LookupType.findById(lookuptypeId)
    .select("lookuptype ParentlookuptypeId")
    .lean();

  if (!lookupType) {
    throw AppError.badRequest("Lookup type not found");
  }

  const expectedParentTypeId = lookupType.ParentlookuptypeId?.toString() || null;
  const normalizedParentId =
    parentLookupId === null ||
    parentLookupId === "" ||
    typeof parentLookupId === "undefined"
      ? null
      : parentLookupId.toString();

  if (expectedParentTypeId) {
    if (!normalizedParentId) {
      throw AppError.badRequest(
        `Parent lookup is required for lookup type "${lookupType.lookuptype}"`
      );
    }

    if (!mongoose.Types.ObjectId.isValid(normalizedParentId)) {
      throw AppError.badRequest("Invalid parent lookup ID");
    }

    const parentLookup = await Lookup.findById(normalizedParentId)
      .select("lookuptypeId lookupname")
      .lean();

    if (!parentLookup) {
      throw AppError.badRequest("Parent lookup not found");
    }

    if (parentLookup.lookuptypeId?.toString() !== expectedParentTypeId) {
      const parentType = await LookupType.findById(expectedParentTypeId)
        .select("lookuptype")
        .lean();
      throw AppError.badRequest(
        `Parent lookup must be a "${parentType?.lookuptype || "parent"}" lookup`
      );
    }

    return normalizedParentId;
  }

  if (normalizedParentId) {
    throw AppError.badRequest(
      `Lookup type "${lookupType.lookuptype}" does not support a parent lookup`
    );
  }

  return null;
};

const findPopulatedLookup = (filter) =>
  Lookup.findOne(filter).populate(LOOKUP_QUERY_POPULATE);

const findPopulatedLookups = (filter) =>
  Lookup.find(filter).populate(LOOKUP_QUERY_POPULATE);

const invalidateLookupCaches = async (lookupId = null, lookuptypeId = null) => {
  await lookupCacheService.invalidateLookupCache();
  if (lookupId) {
    await lookupCacheService.invalidateLookupCache(lookupId.toString());
    await lookupCacheService.invalidateHierarchyCache(lookupId.toString());
  } else {
    await lookupCacheService.invalidateHierarchyCache();
  }
  if (lookuptypeId) {
    await lookupCacheService.invalidateHierarchyCache(
      null,
      lookuptypeId.toString()
    );
  }
};

const hierarchyConvenienceFields = (hierarchy) => ({
  region: hierarchy.find((h) => h?.lookuptypeId?.code === "REGION") || null,
  branch: hierarchy.find((h) => h?.lookuptypeId?.code === "BRANCH") || null,
  workLocation:
    hierarchy.find((h) => h?.lookuptypeId?.code === "WORKLOC") || null,
});

const SIMPLE_TYPE_BY_CODE = {
  REGION: "region",
  BRANCH: "branch",
  WORKLOC: "workLocation",
};

const toSimpleType = (lookupType) => {
  const code = lookupType?.code;
  if (code && SIMPLE_TYPE_BY_CODE[code]) return SIMPLE_TYPE_BY_CODE[code];
  const label = lookupType?.lookuptype || "lookup";
  return label.charAt(0).toLowerCase() + label.slice(1).replace(/\s+/g, "");
};

const toSimpleNode = (lookup) => {
  const doc =
    typeof lookup.toObject === "function" ? lookup.toObject() : lookup;

  return {
    id: doc._id,
    code: doc.code,
    name: doc.DisplayName || doc.lookupname,
    type: toSimpleType(doc.lookuptypeId),
  };
};

/**
 * Nested tree: workLocation.branch.region, branch.region, or region only.
 * ancestors: top-to-bottom (region, then branch).
 */
const buildSimpleLocationTree = (lookup, ancestors = []) => {
  const root = toSimpleNode(lookup);
  const typeCode = lookup.lookuptypeId?.code;

  const findAncestor = (code) =>
    ancestors.find((ancestor) => {
      const doc =
        typeof ancestor.toObject === "function"
          ? ancestor.toObject()
          : ancestor;
      return doc.lookuptypeId?.code === code;
    });

  if (typeCode === "WORKLOC") {
    const branchDoc = findAncestor("BRANCH");
    const regionDoc = findAncestor("REGION");
    if (branchDoc) {
      root.branch = toSimpleNode(branchDoc);
      if (regionDoc) {
        root.branch.region = toSimpleNode(regionDoc);
      }
    } else if (regionDoc) {
      root.region = toSimpleNode(regionDoc);
    }
  } else if (typeCode === "BRANCH") {
    const regionDoc = findAncestor("REGION");
    if (regionDoc) {
      root.region = toSimpleNode(regionDoc);
    }
  }

  return root;
};

const buildSimpleLocationTreeFromFormatted = (lookup, hierarchy = []) => {
  const root = {
    id: lookup._id,
    code: lookup.code,
    name: lookup.DisplayName || lookup.lookupname,
    type: toSimpleType(lookup.lookuptypeId),
  };

  const typeCode = lookup.lookuptypeId?.code;
  const findInHierarchy = (code) =>
    hierarchy.find((h) => h?.lookuptypeId?.code === code);

  if (typeCode === "WORKLOC") {
    const branch = findInHierarchy("BRANCH");
    const region = findInHierarchy("REGION");
    if (branch) {
      root.branch = {
        id: branch._id,
        code: branch.code,
        name: branch.DisplayName || branch.lookupname,
        type: "branch",
      };
      if (region) {
        root.branch.region = {
          id: region._id,
          code: region.code,
          name: region.DisplayName || region.lookupname,
          type: "region",
        };
      }
    } else if (region) {
      root.region = {
        id: region._id,
        code: region.code,
        name: region.DisplayName || region.lookupname,
        type: "region",
      };
    }
  } else if (typeCode === "BRANCH") {
    const region = findInHierarchy("REGION");
    if (region) {
      root.region = {
        id: region._id,
        code: region.code,
        name: region.DisplayName || region.lookupname,
        type: "region",
      };
    }
  }

  return root;
};

/** ?lean=true — with default legacy only: omit region/branch/workLocation shortcuts */
const isLeanQuery = (req) => {
  const lean = req?.query?.lean;
  return lean === true || lean === "true" || lean === "1" || lean === "yes";
};

const buildHierarchyResultItem = (lookup, hierarchy, lean) => {
  const item = {
    lookup,
    hierarchy,
  };
  if (!lean) {
    Object.assign(item, hierarchyConvenienceFields(hierarchy));
  }
  return item;
};

const buildSingleHierarchyResponse = (requestedLookup, hierarchy, lean) => {
  const payload = {
    requestedLookup,
    hierarchy,
  };
  if (!lean) {
    Object.assign(payload, hierarchyConvenienceFields(hierarchy));
  } else {
    payload.lean = true;
  }
  return payload;
};

const applyLeanToByTypeResponse = (response, lean) => {
  if (!lean || !response) return response;
  if (!Array.isArray(response.results)) return response;

  return {
    ...response,
    lean: true,
    results: response.results.map(({ lookup, hierarchy }) => ({
      lookup,
      hierarchy,
    })),
  };
};

const buildAncestryHierarchy = async (parentLookupId) => {
  if (!parentLookupId) return [];

  const parentIds = [];
  let currentParentId = parentLookupId._id || parentLookupId;

  while (currentParentId) {
    parentIds.push(currentParentId);
    const tempParent = await Lookup.findById(currentParentId)
      .select("Parentlookupid")
      .lean();
    currentParentId = tempParent?.Parentlookupid || null;
  }

  if (parentIds.length === 0) return [];

  const parents = await Lookup.find({ _id: { $in: parentIds } }).populate(
    LOOKUP_QUERY_POPULATE
  );

  const parentMap = new Map(
    parents.map((parent) => [parent._id.toString(), parent])
  );

  return parentIds
    .slice()
    .reverse()
    .map((id) => formatLookup(parentMap.get(id.toString())))
    .filter(Boolean);
};

const getAllLookup = async (req, res, next) => {
  try {
    const lookups = await lookupCacheService.getAllLookups(async () =>
      findPopulatedLookups({})
    );

    if (!lookups?.length) {
      return res.status(200).json([]);
    }

    if (isSimpleFormat(req)) {
      const simpleLookups = await buildSimpleLookupsList(
        lookups,
        Lookup,
        LOOKUP_QUERY_POPULATE
      );
      return res.status(200).json(simpleLookups);
    }

    res.status(200).json(lookups.map(formatLookup));
  } catch (error) {
    console.error("Error fetching lookups:", error);
    return next(AppError.internalServerError("Failed to retrieve lookups"));
  }
};

const getLookup = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid lookup ID"));
    }

    const lookup = await lookupCacheService.getLookupById(id, async () =>
      findPopulatedLookup({ _id: id })
    );

    if (!lookup) {
      return res.status(200).json({
        data: null,
        message: "Not found",
      });
    }

    if (isSimpleFormat(req)) {
      const simple = await buildSimpleLookupRecord(
        lookup,
        Lookup,
        LOOKUP_QUERY_POPULATE
      );
      return res.status(200).json(simple);
    }

    res.status(200).json(formatLookup(lookup));
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve lookup"));
  }
};

const createNewLookup = async (req, res, next) => {
  try {
    const {
      code,
      lookupname,
      DisplayName,
      Parentlookupid,
      lookuptypeId,
      isdeleted,
      isactive,
      userid,
      officer,
      worklocationAddress,
      processSalaryDeduction,
    } = req.body;

    if (!code || !lookupname || !userid) {
      return next(
        AppError.badRequest("Code, Lookup name, and User ID are required")
      );
    }

    if (!lookuptypeId) {
      return next(AppError.badRequest("Lookup type is required"));
    }

    let validatedParentLookupId = null;
    try {
      validatedParentLookupId = await validateParentLookup(
        lookuptypeId,
        Parentlookupid
      );
    } catch (err) {
      return next(err);
    }

    const lookup = await Lookup.create({
      code,
      lookupname,
      DisplayName,
      Parentlookupid: validatedParentLookupId,
      lookuptypeId,
      isdeleted: isdeleted || false,
      isactive: isactive !== false,
      userid,
      officer: officer || null,
      worklocationAddress: worklocationAddress || null,
      processSalaryDeduction: !!processSalaryDeduction,
    });

    const populated = await findPopulatedLookup({ _id: lookup._id });

    if (isSimpleFormat(req)) {
      const simple = await buildSimpleLookupRecord(
        populated,
        Lookup,
        LOOKUP_QUERY_POPULATE
      );
      res.status(201).json(simple);
    } else {
      res.status(201).json(formatLookup(populated));
    }

    await invalidateLookupCaches(null, lookuptypeId);
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      return next(AppError.badRequest("Code must be unique"));
    }
    return next(AppError.internalServerError("Failed to create lookup"));
  }
};

const updateLookup = async (req, res, next) => {
  try {
    const {
      id,
      code,
      lookupname,
      DisplayName,
      Parentlookupid,
      lookuptypeId,
      isdeleted,
      isactive,
      userid,
      officer,
      worklocationAddress,
      processSalaryDeduction,
    } = req.body;

    if (!id) {
      return next(AppError.badRequest("Lookup ID is required"));
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid lookup ID"));
    }

    const lookup = await Lookup.findById(id);
    if (!lookup) {
      return next(AppError.notFound("Lookup not found"));
    }

    const previousLookupTypeId = lookup.lookuptypeId?.toString();
    const nextLookupTypeId = lookuptypeId || lookup.lookuptypeId;
    const nextParentLookupId =
      typeof Parentlookupid !== "undefined"
        ? Parentlookupid
        : lookup.Parentlookupid;

    try {
      lookup.Parentlookupid = await validateParentLookup(
        nextLookupTypeId,
        nextParentLookupId
      );
    } catch (err) {
      return next(err);
    }

    if (code) lookup.code = code;
    if (lookupname) lookup.lookupname = lookupname;
    if (typeof DisplayName !== "undefined") lookup.DisplayName = DisplayName;
    if (lookuptypeId) lookup.lookuptypeId = lookuptypeId;
    if (typeof isdeleted !== "undefined") lookup.isdeleted = isdeleted;
    if (typeof isactive !== "undefined") lookup.isactive = isactive;
    if (userid) lookup.userid = userid;
    if (typeof officer !== "undefined") lookup.officer = officer;
    if (typeof worklocationAddress !== "undefined") {
      lookup.worklocationAddress = worklocationAddress;
    }
    if (typeof processSalaryDeduction !== "undefined") {
      lookup.processSalaryDeduction = !!processSalaryDeduction;
    }

    await lookup.save();

    const populated = await findPopulatedLookup({ _id: lookup._id });

    if (isSimpleFormat(req)) {
      const simple = await buildSimpleLookupRecord(
        populated,
        Lookup,
        LOOKUP_QUERY_POPULATE
      );
      res.status(200).json(simple);
    } else {
      res.status(200).json(formatLookup(populated));
    }

    await invalidateLookupCaches(
      lookup._id,
      lookuptypeId || previousLookupTypeId
    );
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      return next(AppError.badRequest("Code must be unique"));
    }
    return next(AppError.internalServerError("Failed to update lookup"));
  }
};

const deleteLookup = async (req, res, next) => {
  try {
    if (!req?.body?.id) {
      return next(AppError.badRequest("Lookup ID required"));
    }

    if (!mongoose.Types.ObjectId.isValid(req.body.id)) {
      return next(AppError.badRequest("Invalid lookup ID"));
    }

    const lookup = await findPopulatedLookup({ _id: req.body.id });
    if (!lookup) {
      return next(AppError.notFound(`No lookup matches ID ${req.body.id}.`));
    }

    const childCount = await Lookup.countDocuments({
      Parentlookupid: req.body.id,
    });
    if (childCount > 0) {
      return next(
        AppError.badRequest(
          "Cannot delete lookup that is parent of other lookups"
        )
      );
    }

    const lookuptypeId = lookup.lookuptypeId?._id || lookup.lookuptypeId;

    const deletedPayload = isSimpleFormat(req)
      ? await buildSimpleLookupRecord(lookup, Lookup, LOOKUP_QUERY_POPULATE)
      : formatLookup(lookup);

    await Lookup.deleteOne({ _id: req.body.id });

    res.status(200).json({
      acknowledged: true,
      deletedCount: 1,
      data: deletedPayload,
    });

    await invalidateLookupCaches(req.body.id, lookuptypeId);
  } catch (error) {
    return next(AppError.internalServerError("Failed to delete lookup"));
  }
};

/**
 * Bulk update officer for multiple lookups
 * PATCH /api/lookups/officer
 * Body: { ids: string[], officer: string|null }
 */
const bulkUpdateOfficer = async (req, res, next) => {
  try {
    const { ids, officer } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return next(AppError.badRequest("ids must be a non-empty array"));
    }

    const invalidIds = ids.filter((id) => !mongoose.Types.ObjectId.isValid(id));
    if (invalidIds.length) {
      return next(
        AppError.badRequest(`Invalid lookup ids: ${invalidIds.join(", ")}`)
      );
    }

    if (
      typeof officer !== "undefined" &&
      officer !== null &&
      !mongoose.Types.ObjectId.isValid(officer)
    ) {
      return next(
        AppError.badRequest("officer must be a valid ObjectId or null")
      );
    }

    const result = await Lookup.updateMany(
      { _id: { $in: ids } },
      { $set: { officer: officer ?? null } },
      { runValidators: true }
    );

    const updatedLookups = await findPopulatedLookups({ _id: { $in: ids } });

    await lookupCacheService.invalidateLookupCache();
    await Promise.all(
      ids.map(async (lookupId) => {
        await lookupCacheService.invalidateLookupCache(lookupId);
        await lookupCacheService.invalidateHierarchyCache(lookupId);
      })
    );

    const lookupsPayload = isSimpleFormat(req)
      ? await buildSimpleLookupsList(
          updatedLookups,
          Lookup,
          LOOKUP_QUERY_POPULATE
        )
      : updatedLookups.map(formatLookup);

    return res.status(200).json({
      status: "success",
      data: {
        matchedCount: result.matchedCount ?? result.n ?? 0,
        modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
        lookups: lookupsPayload,
      },
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    return next(AppError.internalServerError("Failed to bulk update officer"));
  }
};

/**
 * Get lookup hierarchy - returns a lookup with its complete parent chain
 */
const getLookupHierarchy = async (req, res, next) => {
  try {
    const { id } = req.params;
    const simple = isSimpleFormat(req);
    const lean = isLeanQuery(req);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid lookup ID"));
    }

    const response = await lookupCacheService.getLookupHierarchy(id, async () => {
      const lookup = await findPopulatedLookup({ _id: id });
      if (!lookup) return null;

      const formattedLookup = formatLookup(lookup);
      const hierarchy = await buildAncestryHierarchy(lookup.Parentlookupid);

      return buildSingleHierarchyResponse(formattedLookup, hierarchy, false);
    });

    if (!response) {
      return res.status(200).json({
        data: null,
        message: "Not found",
      });
    }

    if (simple) {
      return res.status(200).json(
        buildSimpleLocationTreeFromFormatted(
          response.requestedLookup,
          response.hierarchy
        )
      );
    }

    res.status(200).json(
      lean
        ? buildSingleHierarchyResponse(
            response.requestedLookup,
            response.hierarchy,
            true
          )
        : response
    );
  } catch (error) {
    console.error("Error fetching lookup hierarchy:", error);
    return next(
      AppError.internalServerError("Failed to retrieve lookup hierarchy")
    );
  }
};

/**
 * Get all lookups by lookup type with their complete parent hierarchy
 */
const getLookupsByTypeWithHierarchy = async (req, res, next) => {
  try {
    const { lookuptypeId } = req.params;
    const simple = isSimpleFormat(req);
    const lean = isLeanQuery(req);

    if (!mongoose.Types.ObjectId.isValid(lookuptypeId)) {
      return next(AppError.badRequest("Invalid lookup type ID"));
    }

    const response = await lookupCacheService.getLookupsByTypeWithHierarchy(
      lookuptypeId,
      async () => {
        const lookupType = await LookupType.findById(lookuptypeId)
          .select(LOOKUP_TYPE_SELECT)
          .populate(LOOKUP_TYPE_POPULATE);

        if (!lookupType) {
          return {
            message: "Lookup type not found",
            lookuptypeId,
            lookuptype: null,
            totalCount: 0,
            results: [],
          };
        }

        const lookups = await Lookup.find({
          lookuptypeId,
          isdeleted: false,
          isactive: true,
        }).populate(LOOKUP_QUERY_POPULATE);

        if (!lookups.length) {
          return {
            message: "No lookups found for the specified type",
            lookuptypeId,
            lookuptype: formatLookupType(lookupType),
            totalCount: 0,
            results: [],
          };
        }

        const parentMap = new Map();
        let pendingIds = new Set(
          lookups
            .map((lookup) => lookup.Parentlookupid?._id || lookup.Parentlookupid)
            .filter(Boolean)
            .map((id) => id.toString())
        );

        while (pendingIds.size > 0) {
          const batchIds = Array.from(pendingIds);
          pendingIds.clear();

          const parents = await Lookup.find({
            _id: {
              $in: batchIds.map((id) => new mongoose.Types.ObjectId(id)),
            },
          }).populate(LOOKUP_QUERY_POPULATE);

          for (const parent of parents) {
            const parentId = parent._id.toString();
            if (!parentMap.has(parentId)) {
              parentMap.set(parentId, parent);
              const nextParentId =
                parent.Parentlookupid?._id || parent.Parentlookupid;
              if (nextParentId && !parentMap.has(nextParentId.toString())) {
                pendingIds.add(nextParentId.toString());
              }
            }
          }
        }

        const results = lookups.map((lookup) => {
          const ancestors = [];
          const seen = new Set();
          let currentParentId =
            lookup.Parentlookupid?._id || lookup.Parentlookupid;

          while (currentParentId && !seen.has(currentParentId.toString())) {
            const parentKey = currentParentId.toString();
            seen.add(parentKey);
            const parent = parentMap.get(parentKey);
            if (!parent) break;

            ancestors.push(parent);

            currentParentId =
              parent.Parentlookupid?._id || parent.Parentlookupid;
          }

          ancestors.reverse();

          return buildHierarchyResultItem(
            formatLookup(lookup),
            ancestors.map((ancestor) => formatLookup(ancestor)),
            false
          );
        });

        return {
          lookuptype: formatLookupType(lookupType),
          totalCount: results.length,
          results,
        };
      }
    );

    if (simple) {
      return res.status(200).json({
        lookuptype: response.lookuptype
          ? buildSimpleLookupTypeMeta(response.lookuptype)
          : null,
        totalCount: response.totalCount ?? response.results?.length ?? 0,
        results: (response.results || []).map(({ lookup, hierarchy }) =>
          buildSimpleLocationTreeFromFormatted(lookup, hierarchy)
        ),
      });
    }

    res.status(200).json(applyLeanToByTypeResponse(response, lean));
  } catch (error) {
    console.error("Error fetching lookups by type with hierarchy:", error);
    return next(
      AppError.internalServerError("Failed to retrieve lookups by type")
    );
  }
};

module.exports = {
  getAllLookup,
  getLookup,
  createNewLookup,
  updateLookup,
  deleteLookup,
  bulkUpdateOfficer,
  getLookupHierarchy,
  getLookupsByTypeWithHierarchy,
  formatLookup,
  hierarchyConvenienceFields,
  isLeanQuery,
  isSimpleFormat,
  buildSimpleLocationTree,
  buildSimpleLocationTreeFromFormatted,
  toSimpleNode,
};
