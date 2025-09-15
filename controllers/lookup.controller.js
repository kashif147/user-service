const Lookup = require("../models/Lookup");
// const { publishEvent } = require("message-bus");

const getAllLookup = async (req, res) => {
  try {
    // Fetch all Lookup documents and populate lookuptypeId with fields from LookupType
    const lookups = await Lookup.find({})
      .populate({
        path: "lookuptypeId",
        select: "code lookuptype displayname", // Fields to include from LookupType
      })
      .populate({
        path: "Parentlookupid",
        select: "lookupname ", // Fields to include from LookupType
      });

    // Send the populated data as a JSON res
    const formattedRegions = lookups.map((lookups) => ({
      _id: lookups?._id,
      code: lookups?.code,
      lookupname: lookups?.lookupname,
      DisplayName: lookups?.DisplayName,
      Parentlookupid: lookups?.Parentlookupid
        ? lookups?.Parentlookupid._id
        : null, // Keep only the ID
      Parentlookup: lookups?.Parentlookupid
        ? lookups?.Parentlookupid.lookupname
        : null, // Include name separately
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
    res.status(500).json({ error: "An error occurred while fetching lookups" });
  }
};

const getLookup = async (req, res) => {
  try {
    const { id } = req.params;
    // const lookup = await Lookup.findById(id);
    // if (!lookup) {
    //   return res.status(404).json({ error: 'Lookup not found' });
    // }
    // res.json(lookup);

    // Fetch all Lookup documents and populate lookuptypeId with fields from LookupType
    const lookups = await Lookup.find({})
      .populate({
        path: "lookuptypeId",
        select: "code lookuptype displayname", // Fields to include from LookupType
      })
      .populate({
        path: "Parentlookupid",
        select: "lookupname ", // Fields to include from LookupType
      });
    const formattedRegions = lookups.map((lookups) => ({
      _id: lookups?._id,
      code: lookups?.code,
      lookupname: lookups?.lookupname,
      DisplayName: lookups?.DisplayName,
      Parentlookupid: lookups?.Parentlookupid
        ? lookups?.Parentlookupid._id
        : null, // Keep only the ID
      Parentlookup: lookups?.Parentlookupid
        ? lookups?.Parentlookupid.lookupname
        : null, // Include name separately
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
    res.status(500).json({ error: "Server error" });
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
