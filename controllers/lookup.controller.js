const Lookup = require("../models/lookup.model");
const { AppError } = require("../errors/AppError");
const lookupCacheService = require("../services/lookupCacheService");
const mongoose = require("mongoose");
// const { publishEvent } = require("message-bus");

const getAllLookup = async (req, res, next) => {
  try {
    // Use cache service to get all lookups
    const lookups = await lookupCacheService.getAllLookups(async () => {
      // Database query function
      return await Lookup.find({})
        .populate({
          path: "lookuptypeId",
          select: "code lookuptype displayname",
        })
        .populate({
          path: "Parentlookupid",
          select: "lookupname",
        });
    });

    // Format the data
    const formattedRegions = lookups.map((lookups) => ({
      _id: lookups?._id,
      code: lookups?.code,
      lookupname: lookups?.lookupname,
      DisplayName: lookups?.DisplayName,
      Parentlookupid: lookups?.Parentlookupid
        ? lookups?.Parentlookupid._id
        : null,
      Parentlookup: lookups?.Parentlookupid
        ? lookups?.Parentlookupid.lookupname
        : null,
      lookuptypeId: {
        _id: lookups?.lookuptypeId ? lookups?.lookuptypeId?._id : null,
        code: lookups?.lookuptypeId ? lookups?.lookuptypeId?.code : null,
        lookuptype: lookups?.lookuptypeId
          ? lookups?.lookuptypeId?.lookuptype
          : null,
      },
      isactive: lookups?.isactive,
      isdeleted: lookups?.isdeleted,
    }));

    res.status(200).json(formattedRegions);
  } catch (error) {
    console.error("Error fetching lookups:", error);
    return next(AppError.internalServerError("Failed to retrieve lookups"));
  }
};

const getLookup = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Use cache service to get lookup by ID
    const lookup = await lookupCacheService.getLookupById(id, async () => {
      // Database query function
      return await Lookup.findById(id)
        .populate({
          path: "lookuptypeId",
          select: "code lookuptype displayname",
        })
        .populate({
          path: "Parentlookupid",
          select: "lookupname",
        });
    });

    if (!lookup) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    const formattedLookup = {
      _id: lookup?._id,
      code: lookup?.code,
      lookupname: lookup?.lookupname,
      DisplayName: lookup?.DisplayName,
      Parentlookupid: lookup?.Parentlookupid
        ? lookup?.Parentlookupid._id
        : null,
      Parentlookup: lookup?.Parentlookupid
        ? lookup?.Parentlookupid.lookupname
        : null,
      lookuptypeId: {
        _id: lookup?.lookuptypeId ? lookup?.lookuptypeId?._id : null,
        code: lookup?.lookuptypeId ? lookup?.lookuptypeId?.code : null,
        lookuptype: lookup?.lookuptypeId
          ? lookup?.lookuptypeId?.lookuptype
          : null,
      },
      isactive: lookup?.isactive,
      isdeleted: lookup?.isdeleted,
    };

    res.status(200).json(formattedLookup);
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
    } = req.body;

    if (!code || !lookupname || !userid) {
      return next(AppError.badRequest("Code, Lookup, User ID are required"));
    }

    const lookup = await Lookup.create({
      code: req.body.code,
      lookupname: req.body.lookupname,
      DisplayName: req.body.DisplayName,
      Parentlookupid: req.body.Parentlookupid,
      lookuptypeId: req.body.lookuptypeId,
      isdeleted: req.body.isdeleted || false,
      isactive: req.body.isactive,
      userid: req.body.userid,
    });

    // Emit event for Profile Service
    // try {
    //   await publishEvent("lookup.created", {
    //     lookupId: lookup._id,
    //     code: lookup.code,
    //     lookupname: lookup.lookupname,
    //     DisplayName: lookup.DisplayName,
    //     Parentlookupid: lookup.Parentlookupid,
    //     lookuptypeId: lookup.lookuptypeId,
    //     isdeleted: lookup.isdeleted,
    //     isactive: lookup.isactive,
    //     userid: lookup.userid,
    //     timestamp: new Date(),
    //   });
    //   console.log("✅ [Config] Lookup Created Event published:", lookup._id);
    // } catch (eventError) {
    //   console.error("❌ [Config] Error publishing Lookup Created Event:", eventError.message);
    // }

    res.status(201).json(lookup);

    // Invalidate cache after successful creation
    await lookupCacheService.invalidateLookupCache();
    await lookupCacheService.invalidateHierarchyCache();
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
    } = req.body;

    const lookup = await Lookup.findById(id);
    if (!lookup) {
      return next(AppError.notFound("Lookup not found"));
    }

    // Store old values for event
    const oldValues = {
      code: lookup.code,
      lookupname: lookup.lookupname,
      DisplayName: lookup.DisplayName,
      Parentlookupid: lookup.Parentlookupid,
      lookuptypeId: lookup.lookuptypeId,
      isdeleted: lookup.isdeleted,
      isactive: lookup.isactive,
    };

    if (code) lookup.code = code;
    if (lookupname) lookup.lookupname = lookupname;
    if (DisplayName) lookup.DisplayName = DisplayName;
    if (Parentlookupid) lookup.Parentlookupid = Parentlookupid;
    if (lookuptypeId) lookup.lookuptypeId = lookuptypeId;
    if (typeof isdeleted !== "undefined") lookup.isdeleted = isdeleted;
    if (typeof isactive !== "undefined") lookup.isactive = isactive;
    if (userid) lookup.userid = userid;

    await lookup.save();

    // Invalidate cache after successful update
    await lookupCacheService.invalidateLookupCache();
    await lookupCacheService.invalidateLookupCache(lookup._id.toString());
    await lookupCacheService.invalidateHierarchyCache(lookup._id.toString());

    // Emit event for Profile Service
    // try {
    //   await publishEvent("lookup.updated", {
    //     lookupId: lookup._id,
    //     oldValues,
    //     newValues: {
    //       code: lookup.code,
    //       lookupname: lookup.lookupname,
    //       DisplayName: lookup.DisplayName,
    //       Parentlookupid: lookup.Parentlookupid,
    //       lookuptypeId: lookup.lookuptypeId,
    //       isdeleted: lookup.isdeleted,
    //       isactive: lookup.isactive,
    //     },
    //     userid: lookup.userid,
    //     timestamp: new Date(),
    //   });
    //   console.log("✅ [Config] Lookup Updated Event published:", lookup._id);
    // } catch (eventError) {
    //   console.error("❌ [Config] Error publishing Lookup Updated Event:", eventError.message);
    // }

    res.json(lookup);
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    return next(AppError.internalServerError("Failed to update lookup"));
  }
};

const deleteLookup = async (req, res, next) => {
  if (!req?.body?.id) return next(AppError.badRequest("Lookup ID required"));

  const lookup = await Lookup.findOne({ _id: req.body.id }).lean();
  if (!lookup) {
    return next(AppError.notFound(`No lookups matches ID ${req.body.id}`));
  }

  // Store lookup data for event
  const deletedLookup = {
    lookupId: lookup._id,
    code: lookup.code,
    lookupname: lookup.lookupname,
    DisplayName: lookup.DisplayName,
    Parentlookupid: lookup.Parentlookupid,
    lookuptypeId: lookup.lookuptypeId,
    userid: lookup.userid,
    timestamp: new Date(),
  };

  const result = await Lookup.deleteOne({ _id: req.body.id });

  // Invalidate cache after successful deletion
  await lookupCacheService.invalidateLookupCache();
  await lookupCacheService.invalidateLookupCache(req.body.id);
  await lookupCacheService.invalidateHierarchyCache(req.body.id);

  // Emit event for Profile Service
  // try {
  //   await publishEvent("lookup.deleted", deletedLookup);
  //   console.log("✅ [Config] Lookup Deleted Event published:", lookup._id);
  // } catch (eventError) {
  //   console.error("❌ [Config] Error publishing Lookup Deleted Event:", eventError.message);
  // }

  res.json(result);
};

/**
 * Get lookup hierarchy - returns a lookup with its complete parent chain
 * Example: Given a work location ID, returns work location + branch + region
 */
const getLookupHierarchy = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Use cache service to get lookup hierarchy
    const response = await lookupCacheService.getLookupHierarchy(
      id,
      async () => {
        // Database query function
        const lookup = await Lookup.findById(id)
          .populate({
            path: "lookuptypeId",
            select: "code lookuptype displayname",
          })
          .populate({
            path: "Parentlookupid",
            select: "lookupname DisplayName code Parentlookupid lookuptypeId",
          });

        if (!lookup) {
          return null;
        }

        // Build hierarchy array (only parents/ancestors, not the requested object itself)
        const hierarchy = [];

        // Optimized: Collect all parent IDs first, then fetch in batch
        if (lookup.Parentlookupid) {
          const parentIds = [];
          let currentParentId = lookup.Parentlookupid._id || lookup.Parentlookupid;

          // Collect all parent IDs in the chain (minimal queries - just to get IDs)
          while (currentParentId) {
            parentIds.push(currentParentId);
            // Fetch just the Parentlookupid field to get next parent ID
            const tempParent = await Lookup.findById(currentParentId).select("Parentlookupid").lean();
            currentParentId = tempParent?.Parentlookupid || null;
          }

          // Batch fetch all parents at once (much faster than sequential queries)
          if (parentIds.length > 0) {
            const parents = await Lookup.find({ _id: { $in: parentIds } })
              .populate({
                path: "lookuptypeId",
                select: "code lookuptype displayname",
              })
              .lean();

            // Create a map for quick lookup
            const parentMap = new Map(parents.map(p => [p._id.toString(), p]));

            // Reconstruct hierarchy in correct order (top-to-bottom: region -> branch -> workLocation)
            for (let i = parentIds.length - 1; i >= 0; i--) {
              const parent = parentMap.get(parentIds[i].toString());
              if (parent) {
                hierarchy.unshift({
                  _id: parent._id,
                  code: parent.code,
                  lookupname: parent.lookupname,
                  DisplayName: parent.DisplayName,
                  lookuptypeId: {
                    _id: parent.lookuptypeId?._id,
                    code: parent.lookuptypeId?.code,
                    lookuptype: parent.lookuptypeId?.lookuptype,
                    displayname: parent.lookuptypeId?.displayname,
                  },
                  isactive: parent.isactive,
                  isdeleted: parent.isdeleted,
                });
              }
            }
          }
        }

        // Format response with hierarchy information
        return {
          requestedLookup: {
            _id: lookup._id,
            code: lookup.code,
            lookupname: lookup.lookupname,
            DisplayName: lookup.DisplayName,
            lookuptypeId: {
              _id: lookup.lookuptypeId?._id,
              code: lookup.lookuptypeId?.code,
              lookuptype: lookup.lookuptypeId?.lookuptype,
              displayname: lookup.lookuptypeId?.displayname,
            },
            isactive: lookup.isactive,
            isdeleted: lookup.isdeleted,
          },
          hierarchy: hierarchy,
          // Convenience fields for easy access
          region: hierarchy.find((h) => h.lookuptypeId.code === "REGION"),
          branch: hierarchy.find((h) => h.lookuptypeId.code === "BRANCH"),
          workLocation: hierarchy.find(
            (h) => h.lookuptypeId.code === "WORKLOC"
          ),
        };
      }
    );

    if (!response) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching lookup hierarchy:", error);
    return next(
      AppError.internalServerError("Failed to retrieve lookup hierarchy")
    );
  }
};

/**
 * Get all lookups by lookup type with their complete parent hierarchy
 * Example: Given WORKLOC lookup type, returns all work locations with their branches and regions
 */
const getLookupsByTypeWithHierarchy = async (req, res, next) => {
  try {
    const { lookuptypeId } = req.params;

    // Use cache service to get lookups by type with hierarchy
    const response = await lookupCacheService.getLookupsByTypeWithHierarchy(
      lookuptypeId,
      async () => {
        // Database query function
        const lookups = await Lookup.find({
          lookuptypeId: lookuptypeId,
          isdeleted: false,
          isactive: true,
        }).populate({
          path: "lookuptypeId",
          select: "code lookuptype displayname",
        });

        if (!lookups || lookups.length === 0) {
          return {
            message: "No lookups found for the specified type",
            lookuptypeId: lookuptypeId,
            results: [],
          };
        }

        // Get lookup type details for response
        const lookupType = lookups[0].lookuptypeId;

        // Optimized: Collect all parent IDs from all lookups, then batch fetch
        const allParentIds = new Set();
        const lookupParentMap = new Map(); // Maps lookup ID to its parent ID chain

        // First pass: collect all parent IDs
        for (const lookup of lookups) {
          const parentIds = [];
          let currentParentId = lookup.Parentlookupid;
          
          while (currentParentId) {
            parentIds.push(currentParentId);
            allParentIds.add(currentParentId.toString());
            
            // Fetch just the parent ID field to get next parent
            const tempParent = await Lookup.findById(currentParentId).select("Parentlookupid").lean();
            currentParentId = tempParent?.Parentlookupid || null;
          }
          
          lookupParentMap.set(lookup._id.toString(), parentIds);
        }

        // Batch fetch all unique parents at once
        const allParents = allParentIds.size > 0 
          ? await Lookup.find({ _id: { $in: Array.from(allParentIds).map(id => new mongoose.Types.ObjectId(id)) } })
              .populate({
                path: "lookuptypeId",
                select: "code lookuptype displayname",
              })
              .lean()
          : [];

        // Create a map for quick parent lookup
        const parentMap = new Map(allParents.map(p => [p._id.toString(), p]));

        // Process each lookup to build its hierarchy using the batch-fetched parents
        const results = lookups.map((lookup) => {
          const hierarchy = [];
          const parentIds = lookupParentMap.get(lookup._id.toString()) || [];

          // Reconstruct hierarchy in correct order (top-to-bottom: region -> branch -> workLocation)
          // Reverse iterate to maintain correct order
          for (let i = parentIds.length - 1; i >= 0; i--) {
            const parent = parentMap.get(parentIds[i].toString());
            if (parent) {
              hierarchy.unshift({
                _id: parent._id,
                code: parent.code,
                lookupname: parent.lookupname,
                DisplayName: parent.DisplayName,
                lookuptypeId: {
                  _id: parent.lookuptypeId?._id,
                  code: parent.lookuptypeId?.code,
                  lookuptype: parent.lookuptypeId?.lookuptype,
                  displayname: parent.lookuptypeId?.displayname,
                },
                isactive: parent.isactive,
                isdeleted: parent.isdeleted,
              });
            }
          }

          return {
            lookup: {
              _id: lookup._id,
              code: lookup.code,
              lookupname: lookup.lookupname,
              DisplayName: lookup.DisplayName,
              lookuptypeId: {
                _id: lookup.lookuptypeId?._id,
                code: lookup.lookuptypeId?.code,
                lookuptype: lookup.lookuptypeId?.lookuptype,
                displayname: lookup.lookuptypeId?.displayname,
              },
              isactive: lookup.isactive,
              isdeleted: lookup.isdeleted,
            },
            hierarchy: hierarchy,
            // Convenience fields
            region: hierarchy.find((h) => h.lookuptypeId.code === "REGION"),
            branch: hierarchy.find((h) => h.lookuptypeId.code === "BRANCH"),
            workLocation: hierarchy.find(
              (h) => h.lookuptypeId.code === "WORKLOC"
            ),
          };
        });

        return {
          lookuptype: {
            _id: lookupType._id,
            code: lookupType.code,
            lookuptype: lookupType.lookuptype,
            displayname: lookupType.displayname,
          },
          totalCount: results.length,
          results: results,
        };
      }
    );

    res.status(200).json(response);
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
  getLookupHierarchy,
  getLookupsByTypeWithHierarchy,
};
