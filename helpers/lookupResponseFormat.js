const mongoose = require("mongoose");

const SIMPLE_TYPE_BY_CODE = {
  REGION: "region",
  BRANCH: "branch",
  WORKLOC: "workLocation",
};

/** Default responses stay legacy; pass ?format=simple (or plain) for the nested tree */
const isSimpleFormat = (req) => {
  const format = req?.query?.format;
  return format === "simple" || format === "plain";
};

const toSimpleTypeLabel = (lookupType) => {
  const code = lookupType?.code;
  if (code && SIMPLE_TYPE_BY_CODE[code]) return SIMPLE_TYPE_BY_CODE[code];
  const label = lookupType?.lookuptype || "lookup";
  return (
    label.charAt(0).toLowerCase() + label.slice(1).replace(/\s+/g, "")
  );
};

const toDoc = (record) =>
  typeof record?.toObject === "function" ? record.toObject() : record;

const toSimpleNode = (lookup) => {
  const doc = toDoc(lookup);
  return {
    id: doc._id,
    code: doc.code,
    name: doc.DisplayName || doc.lookupname,
    type: toSimpleTypeLabel(doc.lookuptypeId),
  };
};

const attachLookupMeta = (simple, lookup) => {
  const doc = toDoc(lookup);
  return {
    ...simple,
    typeId: doc.lookuptypeId?._id || doc.lookuptypeId || null,
    isactive: doc.isactive,
    isdeleted: doc.isdeleted,
    userid: doc.userid ?? null,
    officer: doc.officer || null,
    worklocationAddress: doc.worklocationAddress || null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
};

const buildSimpleLocationTree = (lookup, ancestors = []) => {
  const root = toSimpleNode(lookup);
  const typeCode = lookup.lookuptypeId?.code;

  const findAncestor = (code) =>
    ancestors.find((ancestor) => toDoc(ancestor).lookuptypeId?.code === code);

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

const collectAncestorsForLookup = (lookup, parentMap) => {
  const ancestors = [];
  const seen = new Set();
  let currentParentId = lookup.Parentlookupid?._id || lookup.Parentlookupid;

  while (currentParentId && !seen.has(currentParentId.toString())) {
    const parentKey = currentParentId.toString();
    seen.add(parentKey);
    const parent = parentMap.get(parentKey);
    if (!parent) break;
    ancestors.push(parent);
    currentParentId = parent.Parentlookupid?._id || parent.Parentlookupid;
  }

  return ancestors.reverse();
};

const buildSimpleLookupType = (lookupType, typeById = null) => {
  const doc = toDoc(lookupType);
  const simple = {
    id: doc._id,
    code: doc.code,
    name: doc.displayname || doc.lookuptype,
    type: toSimpleTypeLabel(doc),
    isactive: doc.isactive,
    isdeleted: doc.isdeleted,
    userid: doc.userid ?? null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };

  const parentRef = doc.ParentlookuptypeId;
  let parentDoc = null;

  if (parentRef && typeof parentRef === "object" && parentRef._id) {
    parentDoc = parentRef;
  } else if (parentRef && typeById) {
    parentDoc = typeById.get(parentRef.toString());
  }

  if (parentDoc) {
    simple.parent = buildSimpleLookupType(parentDoc, typeById);
  }

  return simple;
};

const buildSimpleLookupTypesList = (lookupTypes) => {
  const typeById = new Map(
    lookupTypes.map((type) => [toDoc(type)._id.toString(), type])
  );
  return lookupTypes.map((type) => buildSimpleLookupType(type, typeById));
};

const buildSimpleLookupsList = async (lookups, Lookup, populatePaths) => {
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
    }).populate(populatePaths);

    for (const parent of parents) {
      const parentId = parent._id.toString();
      if (!parentMap.has(parentId)) {
        parentMap.set(parentId, parent);
        const nextParentId = parent.Parentlookupid?._id || parent.Parentlookupid;
        if (nextParentId && !parentMap.has(nextParentId.toString())) {
          pendingIds.add(nextParentId.toString());
        }
      }
    }
  }

  return lookups.map((lookup) => {
    const ancestors = collectAncestorsForLookup(lookup, parentMap);
    return attachLookupMeta(buildSimpleLocationTree(lookup, ancestors), lookup);
  });
};

const buildSimpleLookupRecord = async (lookup, Lookup, populatePaths) => {
  const ancestors = [];
  let currentParentId = lookup.Parentlookupid?._id || lookup.Parentlookupid;

  while (currentParentId) {
    const parent = await Lookup.findById(currentParentId).populate(populatePaths);
    if (!parent) break;
    ancestors.unshift(parent);
    currentParentId = parent.Parentlookupid?._id || parent.Parentlookupid;
  }

  return attachLookupMeta(buildSimpleLocationTree(lookup, ancestors), lookup);
};

module.exports = {
  isSimpleFormat,
  toSimpleTypeLabel,
  toSimpleNode,
  attachLookupMeta,
  buildSimpleLocationTree,
  buildSimpleLookupType,
  buildSimpleLookupTypesList,
  buildSimpleLookupsList,
  buildSimpleLookupRecord,
  buildSimpleLookupTypeMeta: (lookupType) => {
    const doc = toDoc(lookupType);
    return {
      id: doc._id,
      code: doc.code,
      name: doc.displayname || doc.lookuptype,
      type: toSimpleTypeLabel(doc),
    };
  },
};
