const Lookup = require("../models/lookup.model");
const { AppError } = require("../errors/AppError");
const lookupCacheService = require("../services/lookupCacheService");
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
      return next(AppError.notFound("Lookup not found"));
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

const createNewLookup = async (req, res) => {
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
      return res
        .status(400)
        .json({ error: "Code, Lookup, User ID are required" });
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
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ error: error.message });
    }
    if (error.code === 11000) {
      return res.status(400).json({ error: "Code must be unique" });
    }
    res.status(500).json({ error: "Server error" });
  }
};

const updateLookup = async (req, res) => {
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
      return res.status(404).json({ error: "Lookup not found" });
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
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Server error" });
  }
};

const deleteLookup = async (req, res) => {
  if (!req?.body?.id)
    return res.status(400).json({ message: "Lookup ID required." });

  const lookup = await Lookup.findOne({ _id: req.body.id }).exec();
  if (!lookup) {
    return res
      .status(240)
      .json({ message: ` No lookups matches ID ${req.body.id}. ` });
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

  const result = await lookup.deleteOne({ _id: req.body.id });

  // Invalidate cache after successful deletion
  await lookupCacheService.invalidateLookupCache();
  await lookupCacheService.invalidateLookupCache(req.body.id);

  // Emit event for Profile Service
  // try {
  //   await publishEvent("lookup.deleted", deletedLookup);
  //   console.log("✅ [Config] Lookup Deleted Event published:", lookup._id);
  // } catch (eventError) {
  //   console.error("❌ [Config] Error publishing Lookup Deleted Event:", eventError.message);
  // }

  res.json(result);
};

module.exports = {
  getAllLookup,
  getLookup,
  createNewLookup,
  updateLookup,
  deleteLookup,
};
