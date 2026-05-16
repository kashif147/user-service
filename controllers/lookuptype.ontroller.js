// const LookupType = require('../model/LookupType');
const { AppError } = require("../errors/AppError");

// const getAllLookupType = async (req, res) =>
// {
//     try {
//         const lookupTypes = await LookupType.find();
//         if (!lookupTypes) return res.status(204).json({ 'message': 'No Lookup types found.' });
//         res.json(lookupTypes);
//       }
//       catch (error) {
//         res.status(500).json({ error: 'Server error' });
//       }
// }

// const getLookupType =  async (req, res) => {
//     try {
//         const { id } = req.params;
//         const lookupType = await LookupType.findById(id);
//         if (!lookupType) {
//           return res.status(404).json({ error: 'LookupType not found' });
//         }
//         res.json(lookupType);
//       } catch (error) {
//         res.status(500).json({ error: 'Server error' });
//       }
// }

// const createNewLookupType =  async (req, res) => {
//     try {
//         const { code, lookuptype, DisplayName, isdeleted, isactive, userid } = req.body;

//         // Validate required fields
//         if (!code || !lookuptype || !userid) {
//            return res.status(400).json({ error: 'Code, LookupType, User ID are required' });
//          }

//         // Assign fields individually to control which properties are saved
//         const lookupType = await LookupType.create({
//           code: req.body.code,
//           lookuptype: req.body.lookuptype,
//           DisplayName: req.body.DisplayName,
//           isdeleted: req.body.isdeleted || false, // Defaults to false if not provided
//           isactive: req.body.isactive || true, // Defaults to true if not provided
//           userid: req.body.userid
//         });

//         res.status(201).json(lookupType);
//       } catch (error) {
//         if (error.name === 'ValidationError') {
//           return res.status(400).json({ error: error.message });
//         }
//         if (error.code === 11000) {
//           // Duplicate key error for 'code' field
//           return res.status(400).json({ error: 'Code must be unique' });
//         }
//         if (error.lookuptype === 11000) {
//           // Duplicate key error for 'code' field
//           return res.status(400).json({ error: 'Code must be unique' });
//         }
//         res.status(500).json({ error: 'Server error' });
//       }
// }

// const updateLookupType = async (req, res) => {
//     try {
//         const { id, code, lookuptype, displayname, isdeleted, isactive, userid } = req.body;
//         // Find the LookupType document by ID
//         const lookupTypes = await LookupType.findById(id);
//         if (!lookupTypes) {
//         return res.status(404).json({ error: 'LookupType not found' });
//         }

//         // Update fields individually only if they are provided in the request
//         if (code) lookupTypes.code = code;
//         if (lookuptype) lookupTypes.lookuptype = lookuptype;
//         if (displayname) lookupTypes.displayname = displayname;
//         if (typeof isdeleted !== 'undefined') lookupTypes.isdeleted = isdeleted;
//         if (typeof isactive !== 'undefined') lookupTypes.isactive = isactive;
//         if (userid) lookupTypes.userid = userid;

//         // Save the updated document, applying validation
//         await lookupTypes.save();
//         res.json(lookupTypes);
//     } catch (error) {
//         if (error.name === 'ValidationError') {
//         return res.status(400).json({ error: error.message });
//         }
//         res.status(500).json({ error: 'Server error' });
//     }
// }

// const deleteLookupType = async (req, res) => {
//     if (!req?.body?.id) return res.status(400).json({ 'message': 'LookupType ID required.'});

//     const lookuptype = await LookupType.findOne({ _id: req.body.id}).exec();
//     if (!lookuptype) {
//         return res.status(240).json({ "message": ` No lookuptype matches ID ${req.body.id}. ` });
//     }

//    const result = await lookuptype.deleteOne({ _id: req.body.id });
//     res.json(result);
// }

// module.exports = {
//       getAllLookupType,
//       getLookupType,
//       createNewLookupType,
//       updateLookupType,
//       deleteLookupType
//    }

const LookupType = require("../models/lookupType.model");
const lookupCacheService = require("../services/lookupCacheService");
const mongoose = require("mongoose");

const LOOKUP_TYPE_POPULATE = {
  path: "ParentlookuptypeId",
  select: "code lookuptype displayname",
};

const formatLookupType = (lookupType) => {
  if (!lookupType) return null;
  const doc =
    typeof lookupType.toObject === "function"
      ? lookupType.toObject()
      : lookupType;
  const parent = doc.ParentlookuptypeId;

  return {
    _id: doc._id,
    code: doc.code,
    lookuptype: doc.lookuptype,
    displayname: doc.displayname,
    ParentlookuptypeId: parent?._id ?? parent ?? null,
    Parentlookuptype: parent?.lookuptype ?? null,
    isdeleted: doc.isdeleted,
    isactive: doc.isactive,
    userid: doc.userid,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

const resolveParentLookupTypeId = async (parentId, currentId = null) => {
  if (parentId === null || parentId === "" || typeof parentId === "undefined") {
    return null;
  }

  if (!mongoose.Types.ObjectId.isValid(parentId)) {
    throw AppError.badRequest("Invalid parent lookup type ID");
  }

  if (currentId && parentId.toString() === currentId.toString()) {
    throw AppError.badRequest("Lookup type cannot be its own parent");
  }

  const parent = await LookupType.findById(parentId).select(
    "ParentlookuptypeId lookuptype"
  );
  if (!parent) {
    throw AppError.badRequest("Parent lookup type not found");
  }

  if (currentId) {
    const seen = new Set([currentId.toString()]);
    let walker = parent;

    while (walker?.ParentlookuptypeId) {
      const nextId = walker.ParentlookuptypeId.toString();
      if (seen.has(nextId)) {
        throw AppError.badRequest("Circular parent lookup type chain detected");
      }
      seen.add(nextId);
      walker = await LookupType.findById(walker.ParentlookuptypeId).select(
        "ParentlookuptypeId"
      );
    }
  }

  return parentId;
};

const getAllLookupType = async (req, res, next) => {
  try {
    // Use cache service to get all lookup types
    const lookupTypes = await lookupCacheService.getAllLookupTypes(async () => {
      // Database query function
      return await LookupType.find().populate(LOOKUP_TYPE_POPULATE);
    });

    if (!lookupTypes) {
      return res.status(204).json({ message: "No Lookup types found." });
    }

    res.json(lookupTypes.map(formatLookupType));
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to retrieve lookup types")
    );
  }
};

const getLookupType = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Use cache service to get lookup type by ID
    const lookupType = await lookupCacheService.getLookupTypeById(
      id,
      async () => {
        // Database query function
        return await LookupType.findById(id).populate(LOOKUP_TYPE_POPULATE);
      }
    );

    if (!lookupType) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    res.json(formatLookupType(lookupType));
  } catch (error) {
    return next(AppError.internalServerError("Failed to retrieve lookup type"));
  }
};

const createNewLookupType = async (req, res, next) => {
  try {
    const {
      code,
      lookuptype,
      DisplayName,
      ParentlookuptypeId,
      isdeleted,
      isactive,
      userid,
    } = req.body;

    // Validate required fields
    if (!code || !lookuptype || !userid) {
      return res
        .status(400)
        .json({ error: "Code, LookupType, User ID are required" });
    }

    let parentLookupTypeId = null;
    try {
      parentLookupTypeId = await resolveParentLookupTypeId(ParentlookuptypeId);
    } catch (err) {
      return next(err);
    }

    // Assign fields individually to control which properties are saved
    const lookupType = await LookupType.create({
      code: req.body.code,
      lookuptype: req.body.lookuptype,
      displayname: req.body.DisplayName,
      ParentlookuptypeId: parentLookupTypeId,
      isdeleted: req.body.isdeleted || false,
      isactive: req.body.isactive || true,
      userid: req.body.userid,
    });

    // Event emission can be added here when needed

    const populated = await LookupType.findById(lookupType._id).populate(
      LOOKUP_TYPE_POPULATE
    );
    res.status(201).json(formatLookupType(populated));

    // Invalidate cache after successful creation
    await lookupCacheService.invalidateLookupTypeCache();
    await lookupCacheService.invalidateHierarchyCache();
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      return next(AppError.badRequest("Code must be unique"));
    }
    return next(AppError.internalServerError("Failed to create lookup type"));
  }
};

const updateLookupType = async (req, res, next) => {
  try {
    const {
      id,
      code,
      lookuptype,
      displayname,
      DisplayName,
      ParentlookuptypeId,
      isdeleted,
      isactive,
      userid,
    } = req.body;
    // Find the LookupType document by ID
    const lookupTypes = await LookupType.findById(id);
    if (!lookupTypes) {
      return next(AppError.notFound("LookupType not found"));
    }

    // Update fields individually only if they are provided in the request
    if (code) lookupTypes.code = code;
    if (lookuptype) lookupTypes.lookuptype = lookuptype;
    if (displayname) lookupTypes.displayname = displayname;
    if (DisplayName) lookupTypes.displayname = DisplayName;
    if (typeof isdeleted !== "undefined") lookupTypes.isdeleted = isdeleted;
    if (typeof isactive !== "undefined") lookupTypes.isactive = isactive;
    if (userid) lookupTypes.userid = userid;

    if (typeof ParentlookuptypeId !== "undefined") {
      try {
        lookupTypes.ParentlookuptypeId = await resolveParentLookupTypeId(
          ParentlookuptypeId,
          lookupTypes._id
        );
      } catch (err) {
        return next(err);
      }
    }

    // Save the updated document, applying validation
    await lookupTypes.save();

    // Invalidate cache after successful update
    await lookupCacheService.invalidateLookupTypeCache();
    await lookupCacheService.invalidateLookupTypeCache(
      lookupTypes._id.toString()
    );
    await lookupCacheService.invalidateHierarchyCache(
      null,
      lookupTypes._id.toString()
    );

    const populated = await LookupType.findById(lookupTypes._id).populate(
      LOOKUP_TYPE_POPULATE
    );

    // Event emission can be added here when needed

    res.json(formatLookupType(populated));
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    return next(AppError.internalServerError("Failed to update lookup type"));
  }
};

const deleteLookupType = async (req, res, next) => {
  if (!req?.body?.id)
    return next(AppError.badRequest("LookupType ID required"));

  const lookuptype = await LookupType.findOne({ _id: req.body.id }).exec();
  if (!lookuptype) {
    return next(AppError.notFound(`No lookuptype matches ID ${req.body.id}.`));
  }

  const childCount = await LookupType.countDocuments({
    ParentlookuptypeId: req.body.id,
  });
  if (childCount > 0) {
    return next(
      AppError.badRequest(
        "Cannot delete lookup type that is parent of other lookup types"
      )
    );
  }

  // Store values for audit before deletion
  const deletedLookupType = {
    lookupTypeId: lookuptype._id,
    code: lookuptype.code,
    lookuptype: lookuptype.lookuptype,
    displayname: lookuptype.displayname,
    userid: lookuptype.userid,
    timestamp: new Date(),
  };

  const result = await lookuptype.deleteOne({ _id: req.body.id });

  // Invalidate cache after successful deletion
  await lookupCacheService.invalidateLookupTypeCache();
  await lookupCacheService.invalidateLookupTypeCache(req.body.id);
  await lookupCacheService.invalidateHierarchyCache(null, req.body.id);

  // Event emission can be added here when needed

  res.json(result);
};

module.exports = {
  getAllLookupType,
  getLookupType,
  createNewLookupType,
  updateLookupType,
  deleteLookupType,
};
