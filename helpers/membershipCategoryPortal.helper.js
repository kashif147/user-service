function isHonoraryMembershipCategoryLabel(value) {
  const combined = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!combined) return false;
  return combined === "honorary" || /\bhonorary\b/.test(combined);
}

function isPortalUserRequest(req) {
  const userType =
    req?.user?.userType ||
    req?.ctx?.userType ||
    req?.headers?.["x-user-type"];
  return String(userType || "").toUpperCase() === "PORTAL";
}

function isMembershipCategoryLookupRecord(lookup) {
  const typeName =
    lookup?.lookuptypeId?.lookuptype ||
    lookup?.lookuptypeName ||
    lookup?.lookuptypeId?.lookuptypeName ||
    "";
  return String(typeName).trim().toLowerCase() === "membershipcategory";
}

function shouldExposeMembershipCategoryToRequest(req, labelOrCode) {
  if (!isPortalUserRequest(req)) return true;
  return !isHonoraryMembershipCategoryLabel(labelOrCode);
}

module.exports = {
  isHonoraryMembershipCategoryLabel,
  isPortalUserRequest,
  isMembershipCategoryLookupRecord,
  shouldExposeMembershipCategoryToRequest,
};
